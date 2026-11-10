/**
 * The ledger: PayPal invoices flattened into grid rows, with the risk rules applied, and the
 * agent run that turns unpaid invoices into proposals waiting at the confirmation gate.
 */
import {
  allowedActions, assess, planFor, recommend, TONES,
  type AgentAction, type RiskLevel, type Tone,
} from './agent/risk.js';
import { proposeWithGuard, type CollectionsModel, type ProposalInput } from './agent/model.js';
import type { ActionKind, ConfirmationGate } from './gate.js';
import type { Journal } from './journal.js';
import type { PayPalReader } from './paypal/client.js';
import {
  addDays, formatMoney, fromCents, isOpen, isPlainAmount, isTwoDecimalCurrency, localDate, recipientOf, toCents, PAID_STATUSES,
  type Invoice, type InvoiceDraft, type InvoiceStatus,
} from './paypal/types.js';

export interface LedgerRow {
  id: string;
  number: string;
  customer: string;
  email: string;
  status: InvoiceStatus;
  /** Status as shown: adds "Overdue", which PayPal does not have as a status. */
  display: string;
  invoiceDate: string | null;
  dueDate: string | null;
  currency: string;
  total: number;
  due: number;
  paid: number;
  daysOverdue: number | null;
  reference: string;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  riskReasons: string[];
  exposure: number | null;
  reminders: number;
  lastReminder: string | null;
  nextStep: AgentAction | null;
  nextStepSource: 'agent' | 'rules' | null;
  nextStepWhy: string;
  pending: { id: string; kind: ActionKind }[];
}

export interface ProposalResult {
  invoiceId: string;
  invoiceNumber: string;
  action: AgentAction;
  reason: string;
  tone: Tone;
  source: string;
  warnings: string[];
  /** The action waiting at the gate, or null when the advice is to wait. */
  actionId: string | null;
}

export type ToneChoice = Tone | 'auto';

const LABELS: Partial<Record<InvoiceStatus, string>> = {
  DRAFT: 'Draft', SENT: 'Sent', UNPAID: 'Sent', PARTIALLY_PAID: 'Part paid', PAID: 'Paid',
  MARKED_AS_PAID: 'Paid', PAID_EXTERNAL: 'Paid', CANCELLED: 'Cancelled', AUTO_CANCELLED: 'Cancelled', SCHEDULED: 'Scheduled', REFUNDED: 'Refunded',
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export interface LedgerDeps {
  reader: PayPalReader;
  gate: ConfirmationGate;
  journal: Journal;
  model: CollectionsModel;
  now?: () => Date;
}

export class Ledger {
  private readonly proposals = new Map<string, ProposalResult & { day: string }>();
  private readonly now: () => Date;

  constructor(private readonly deps: LedgerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get modelName(): string {
    return this.deps.model.name;
  }

  /**
   * All invoices, with full detail for those where payments matter.
   * Checked on the PayPal sandbox, 2026-11-03: list items carry `due_amount`, and `payments` when there are any, but
   * not every field of a GET (no `configuration`, no `metadata`); one GET per open or paid invoice is
   * kept so that the rules read the same object as the gate. Four at a time;
   * PayPal's rate limits for Invoicing are not published and were not probed.
   */
  async invoices(): Promise<Invoice[]> {
    const list = await this.deps.reader.listAllInvoices();
    return mapLimit(list, 4, (inv) =>
      isOpen(inv.status) || PAID_STATUSES.includes(inv.status) ? this.deps.reader.getInvoice(inv.id) : Promise.resolve(inv));
  }

  private today(): string {
    return localDate(this.now());
  }

  async rows(): Promise<LedgerRow[]> {
    const all = await this.invoices();
    const today = this.today();
    const pending = this.deps.gate.pending();
    return all.map((inv) => {
      const who = recipientOf(inv);
      const total = toCents(inv.amount?.value);
      const paid = toCents(inv.payments?.paid_amount?.value);
      const due = inv.due_amount ? toCents(inv.due_amount.value) : Math.max(0, total - paid);
      const open = isOpen(inv.status);
      const row: LedgerRow = {
        id: inv.id,
        number: inv.detail.invoice_number ?? inv.id,
        customer: who.name,
        email: who.email,
        status: inv.status,
        display: LABELS[inv.status] ?? inv.status.toLowerCase().replace(/_/g, ' '),
        invoiceDate: inv.detail.invoice_date ?? null,
        dueDate: inv.detail.payment_term?.due_date ?? null,
        currency: inv.detail.currency_code,
        total: total / 100,
        due: (open ? due : 0) / 100, // a draft is not owed yet
        paid: paid / 100,
        daysOverdue: null,
        reference: inv.detail.reference ?? '',
        riskScore: null, riskLevel: null, riskReasons: [], exposure: null,
        reminders: 0, lastReminder: null,
        nextStep: null, nextStepSource: null, nextStepWhy: '',
        pending: pending.filter((a) => a.invoiceId === inv.id).map((a) => ({ id: a.id, kind: a.kind })),
      };
      if (!open) return row;
      const reminders = this.deps.journal.remindersFor(inv.id);
      const risk = assess(inv, all, reminders, today);
      const rec = recommend(risk.features, risk, allowedActions(inv, risk.features));
      row.daysOverdue = risk.features.daysOverdue;
      if (risk.features.daysOverdue > 0) row.display = inv.status === 'PARTIALLY_PAID' ? 'Overdue, part paid' : 'Overdue';
      row.riskScore = risk.score;
      row.riskLevel = risk.level;
      row.riskReasons = risk.reasons;
      row.exposure = risk.exposureCents / 100;
      row.reminders = reminders.count;
      row.lastReminder = reminders.lastAt ? reminders.lastAt.slice(0, 10) : null;
      const stored = this.proposals.get(inv.id);
      const live = stored && (stored.actionId ? this.deps.gate.get(stored.actionId)?.state === 'pending' : stored.day === today);
      if (stored && live) {
        row.nextStep = stored.action;
        row.nextStepSource = 'agent';
        row.nextStepWhy = stored.reason;
      } else {
        row.nextStep = rec.action;
        row.nextStepSource = 'rules';
        row.nextStepWhy = rec.why;
      }
      return row;
    });
  }

  /** Everything the model is given about one invoice. No credentials, nothing about other customers. */
  buildInput(inv: Invoice, all: Invoice[], toneChoice: ToneChoice): ProposalInput {
    const today = this.today();
    const risk = assess(inv, all, this.deps.journal.remindersFor(inv.id), today);
    const f = risk.features;
    const allowed = allowedActions(inv, f);
    const rec = recommend(f, risk, allowed);
    const plan = allowed.includes('OFFER_PLAN') ? planFor(f.dueCents) : null;
    const who = recipientOf(inv);
    return {
      invoice: {
        id: inv.id,
        number: inv.detail.invoice_number ?? inv.id,
        customer: who.name,
        contact: inv.primary_recipients?.[0]?.billing_info?.name?.given_name ?? '',
        status: inv.status,
        currency: f.currency,
        invoiceDate: inv.detail.invoice_date ?? '',
        dueDate: inv.detail.payment_term?.due_date ?? '',
        total: formatMoney(f.totalCents, f.currency),
        due: formatMoney(f.dueCents, f.currency),
      },
      sender: inv.invoicer?.business_name || inv.invoicer?.name?.full_name || 'Accounts receivable',
      features: f,
      risk: { score: risk.score, level: risk.level, reasons: risk.reasons },
      allowed,
      ruleAction: rec.action,
      ruleWhy: rec.why,
      tone: toneChoice === 'auto' ? rec.tone : toneChoice,
      plan: plan ? { ...plan, amount: formatMoney(plan.amountCents, f.currency) } : null,
    };
  }

  /**
   * Run the agent on the given invoices. Each answer becomes a prepared action at the gate
   * (or plain advice when the answer is to wait). Nothing is sent to PayPal here.
   */
  async propose(invoiceIds: string[], tone: ToneChoice = 'auto', tones: Record<string, ToneChoice> = {}): Promise<ProposalResult[]> {
    const all = await this.invoices();
    const results: ProposalResult[] = [];
    for (const id of invoiceIds) {
      const inv = all.find((i) => i.id === id);
      if (!inv || !isOpen(inv.status)) continue;
      const choice = tones[id] ?? tone;
      const input = this.buildInput(inv, all, choice === 'auto' || TONES.includes(choice) ? choice : 'auto');
      if (!input.allowed.length) continue;
      const guarded = await proposeWithGuard(this.deps.model, input);
      const p = guarded.proposal;
      const result: ProposalResult = {
        invoiceId: id, invoiceNumber: input.invoice.number, action: p.action, reason: p.reason,
        tone: input.tone, source: guarded.source, warnings: guarded.warnings, actionId: null,
      };
      if (p.action === 'WAIT') {
        this.deps.journal.append({
          type: 'advised', kind: 'WAIT', invoiceId: id, invoiceNumber: input.invoice.number, origin: 'agent',
          detail: { reason: p.reason, source: guarded.source },
        });
      } else {
        const kind: ActionKind = p.action === 'WRITE_OFF' ? 'CANCEL' : p.action;
        const payload: Record<string, unknown> = { subject: p.subject, note: p.note };
        if (p.action === 'OFFER_PLAN' && input.plan) {
          payload.minimumAmount = { currency_code: input.features.currency, value: fromCents(input.plan.amountCents) };
        }
        const action = await this.deps.gate.prepare({
          kind, invoiceId: id, payload, origin: 'agent', rationale: p.reason, source: guarded.source, warnings: guarded.warnings,
        });
        result.actionId = action.id;
      }
      this.proposals.set(id, { ...result, day: this.today() });
      results.push(result);
    }
    return results;
  }

  /** Default wording for actions the user starts by hand; always editable before confirming. */
  async defaultPayload(kind: ActionKind, invoiceId: string): Promise<Record<string, unknown>> {
    const inv = await this.deps.reader.getInvoice(invoiceId);
    const number = inv.detail.invoice_number ?? inv.id;
    const sender = inv.invoicer?.business_name || 'Accounts receivable';
    if (kind === 'SEND') {
      return { subject: `Invoice ${number} from ${sender}`, note: `Please find invoice ${number} attached to this message. Thank you for your business.` };
    }
    if (kind === 'CANCEL') {
      return { subject: `Invoice ${number} has been cancelled`, note: `Invoice ${number} has been cancelled. No payment is expected for it.` };
    }
    if (kind === 'REMIND') {
      const all = await this.invoices();
      const input = this.buildInput(inv, all, 'auto');
      return { subject: `Reminder: invoice ${number}`, note: `Invoice ${number} was due on ${input.invoice.dueDate}; ${input.invoice.due} is still open.` };
    }
    return {};
  }

  /** Turn the "new invoice" form into a PayPal draft body. */
  draftFromForm(form: Record<string, unknown>): InvoiceDraft {
    const text = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
    const today = this.today();
    const currency = (text('currency') || 'EUR').toUpperCase();
    if (!isTwoDecimalCurrency(currency)) throw new Error(`Currency ${currency} is not supported: two-decimal currencies only.`);
    // Refused rather than truncated: "10.999" must not quietly become 10.99.
    if (!isPlainAmount(text('amount'))) throw new Error('The amount must be a number with at most two decimals, such as 120.50.');
    const days = Number(form.dueInDays);
    // Checked on the PayPal sandbox, 2026-11-03: a draft without an `invoicer` block is accepted; PayPal fills it from the
    // merchant account.
    return {
      detail: {
        currency_code: currency,
        invoice_date: today,
        reference: text('reference') || undefined,
        note: 'Thank you for your business.',
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: addDays(today, Number.isFinite(days) && days >= 0 ? Math.round(days) : 30) },
      },
      primary_recipients: [{ billing_info: { business_name: text('customer') || undefined, email_address: text('email') } }],
      items: [{
        name: text('description') || 'Services',
        quantity: '1',
        unit_amount: { currency_code: currency, value: fromCents(toCents(text('amount') || '0')) },
      }],
    };
  }
}
