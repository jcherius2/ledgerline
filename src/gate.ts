/**
 * The confirmation gate: the only path from this application to a PayPal write.
 *
 *   prepare  -> the exact payload is stored, hashed and journaled; nothing is sent.
 *   revise   -> the human edits the payload; the hash changes.
 *   confirm  -> the caller must say confirm:true and quote the hash of what they saw. The gate
 *               re-reads the invoice, refuses if it changed since the proposal, then mints a
 *               Confirmation, performs the call(s) and journals the outcome.
 *
 * This module is the only one allowed to import `mintConfirmation`.
 */
import { randomUUID } from 'node:crypto';
import { mintConfirmation } from './confirmation.js';
import { canonical, sha256, type Journal } from './journal.js';
import { PayPalApiError, stripReadOnly, type PayPalClient } from './paypal/client.js';
import {
  isOpen, isPlainAmount, isTwoDecimalCurrency, toCents, PAYMENT_METHODS,
  type Invoice, type InvoiceDraft, type Money, type PaymentMethod,
} from './paypal/types.js';

export type ActionKind =
  | 'CREATE_DRAFT' | 'UPDATE_DRAFT' | 'DELETE_DRAFT' | 'SEND'
  | 'REMIND' | 'OFFER_PLAN' | 'RECORD_PAYMENT' | 'CANCEL';

export const ACTION_KINDS: ActionKind[] = [
  'CREATE_DRAFT', 'UPDATE_DRAFT', 'DELETE_DRAFT', 'SEND', 'REMIND', 'OFFER_PLAN', 'RECORD_PAYMENT', 'CANCEL',
];

export type ActionState = 'pending' | 'executing' | 'executed' | 'failed' | 'discarded' | 'expired';

export interface PendingAction {
  id: string;
  kind: ActionKind;
  invoiceId: string | null;
  invoiceNumber: string | null;
  customer: string | null;
  payload: Record<string, unknown>;
  origin: 'agent' | 'user';
  rationale: string | null;
  source: string | null;
  warnings: string[];
  /** The PayPal calls that confirming will make, in order. */
  calls: string[];
  digest: string;
  snapshot: { status: string; due: string } | null;
  createdAt: string;
  expiresAt: string;
  state: ActionState;
  result: Record<string, unknown> | null;
}

export interface PrepareInput {
  kind: ActionKind;
  invoiceId?: string | null;
  payload: Record<string, unknown>;
  origin: 'agent' | 'user';
  rationale?: string;
  source?: string;
  warnings?: string[];
}

export type GateErrorCode =
  | 'INVALID' | 'NOT_FOUND' | 'NOT_PENDING' | 'NOT_CONFIRMED' | 'DIGEST_MISMATCH' | 'EXPIRED' | 'STALE' | 'PAYPAL_FAILED';

const HTTP_STATUS: Record<GateErrorCode, number> = {
  INVALID: 400, NOT_FOUND: 404, NOT_PENDING: 409, NOT_CONFIRMED: 400, DIGEST_MISMATCH: 409, EXPIRED: 410, STALE: 409, PAYPAL_FAILED: 502,
};

export class GateError extends Error {
  readonly status: number;
  constructor(readonly code: GateErrorCode, message: string) {
    super(message);
    this.name = 'GateError';
    this.status = HTTP_STATUS[code];
  }
}

const invalid = (message: string) => new GateError('INVALID', message);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function money(v: unknown, what: string): Money {
  const m = v as Money | undefined;
  if (!m || typeof m.currency_code !== 'string' || typeof m.value !== 'string') throw invalid(`${what} must be {currency_code, value}`);
  // Strict on purpose: "10.005" or "1e3" must be refused, not truncated into something else.
  if (!isPlainAmount(m.value)) throw invalid(`${what} is not a decimal amount with at most two decimals`);
  if (!isTwoDecimalCurrency(m.currency_code)) throw invalid(`${what}: currency ${m.currency_code} is not supported (two-decimal currencies only)`);
  const cents = toCents(m.value);
  if (cents <= 0) throw invalid(`${what} must be positive`);
  return { currency_code: m.currency_code, value: m.value };
}

function message(p: Record<string, unknown>): { subject: string; note: string } {
  const subject = str(p.subject).replace(/\s+/g, ' '); // one line: it becomes an email subject
  const note = str(p.note);
  if (!subject || subject.length > 4000) throw invalid('subject is required (4000 characters at most)');
  if (!note || note.length > 4000) throw invalid('note is required (4000 characters at most)');
  return { subject, note };
}

/** Checks a payload and returns it normalised: only known fields, in a fixed shape. */
export function validatePayload(kind: ActionKind, p: Record<string, unknown>): Record<string, unknown> {
  if (!p || typeof p !== 'object') throw invalid('payload must be an object');
  switch (kind) {
    case 'SEND':
    case 'REMIND':
    case 'CANCEL':
      return message(p);
    case 'OFFER_PLAN':
      return { ...message(p), minimumAmount: money(p.minimumAmount, 'minimumAmount') };
    case 'RECORD_PAYMENT': {
      if (!PAYMENT_METHODS.includes(p.method as PaymentMethod)) throw invalid('method is not a PayPal payment method');
      if (!ISO_DATE.test(str(p.paymentDate))) throw invalid('paymentDate must be YYYY-MM-DD');
      const out: Record<string, unknown> = { method: p.method, amount: money(p.amount, 'amount'), paymentDate: str(p.paymentDate) };
      if (str(p.note)) out.note = str(p.note).slice(0, 2000);
      return out;
    }
    case 'UPDATE_DRAFT': {
      const out: Record<string, unknown> = {};
      if (p.reference !== undefined && p.reference !== null) out.reference = String(p.reference).trim().slice(0, 120);
      if (p.dueDate !== undefined && p.dueDate !== null) {
        if (!ISO_DATE.test(str(p.dueDate))) throw invalid('dueDate must be YYYY-MM-DD');
        out.dueDate = str(p.dueDate);
      }
      if (!Object.keys(out).length) throw invalid('nothing to update');
      return out;
    }
    case 'CREATE_DRAFT': {
      const d = p.draft as InvoiceDraft | undefined;
      if (!d?.detail?.currency_code) throw invalid('draft.detail.currency_code is required');
      if (!isTwoDecimalCurrency(d.detail.currency_code)) throw invalid(`currency ${String(d.detail.currency_code)} is not supported (two-decimal currencies only)`);
      if (!/^\S+@\S+\.\S+$/.test(d.primary_recipients?.[0]?.billing_info?.email_address ?? '')) throw invalid('a recipient email address is required');
      if (!d.items?.length) throw invalid('at least one line item is required');
      for (const it of d.items) {
        if (!str(it.name) || !(Number(it.quantity) > 0)) throw invalid('each line item needs a name and a positive quantity');
        money(it.unit_amount, 'unit_amount');
        if (it.unit_amount.currency_code !== d.detail.currency_code) throw invalid('line items must be in the invoice currency');
      }
      return { draft: d };
    }
    case 'DELETE_DRAFT':
      return {};
    default:
      throw invalid(`unknown action kind "${String(kind)}"`);
  }
}

export function describeCalls(kind: ActionKind, id: string | null): string[] {
  const base = `/v2/invoicing/invoices${id ? `/${id}` : ''}`;
  switch (kind) {
    case 'CREATE_DRAFT': return ['POST /v2/invoicing/generate-next-invoice-number', 'POST /v2/invoicing/invoices'];
    case 'UPDATE_DRAFT': return [`PUT ${base}`];
    case 'DELETE_DRAFT': return [`DELETE ${base}`];
    case 'SEND': return [`POST ${base}/send`];
    case 'REMIND': return [`POST ${base}/remind`];
    case 'OFFER_PLAN': return [`PUT ${base}`, `POST ${base}/remind`];
    case 'RECORD_PAYMENT': return [`POST ${base}/payments`];
    case 'CANCEL': return [`POST ${base}/cancel`];
  }
}

function checkStatus(kind: ActionKind, inv: Invoice, payload: Record<string, unknown>): void {
  const draftOnly = kind === 'UPDATE_DRAFT' || kind === 'DELETE_DRAFT' || kind === 'SEND';
  if (draftOnly && inv.status !== 'DRAFT') throw invalid(`${kind} needs a draft invoice; this one is ${inv.status}`);
  if (!draftOnly && !isOpen(inv.status)) throw invalid(`${kind} needs an unpaid, sent invoice; this one is ${inv.status}`);
  // The spec's cancel errors: CANNOT_CANCEL_PAID_INVOICE covers "a paid or partially paid invoice".
  if (kind === 'CANCEL' && inv.status === 'PARTIALLY_PAID') {
    throw invalid('PayPal does not cancel a partially paid invoice; the part payment would have to be removed or refunded first');
  }
  const due = toCents(inv.due_amount?.value);
  const amount = (payload.amount ?? payload.minimumAmount) as Money | undefined;
  if (amount) {
    if (amount.currency_code !== inv.detail.currency_code) throw invalid('the amount is not in the invoice currency');
    if (toCents(amount.value) > due) throw invalid('the amount is larger than what is due');
  }
}

export interface GateOptions {
  client: PayPalClient;
  journal: Journal;
  now?: () => Date;
  /** How long a prepared action stays confirmable. */
  ttlMs?: number;
}

export class ConfirmationGate {
  private readonly actions = new Map<string, PendingAction>();
  private readonly client: PayPalClient;
  private readonly journal: Journal;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: GateOptions) {
    this.client = options.client;
    this.journal = options.journal;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
  }

  private digestOf(a: Pick<PendingAction, 'kind' | 'invoiceId' | 'payload'>): string {
    return sha256(canonical({ kind: a.kind, invoiceId: a.invoiceId, payload: a.payload }));
  }

  private log(type: Parameters<Journal['append']>[0]['type'], a: PendingAction, detail?: Record<string, unknown>): void {
    this.journal.append({
      type, actionId: a.id, kind: a.kind, invoiceId: a.invoiceId ?? undefined,
      invoiceNumber: a.invoiceNumber ?? undefined, origin: a.origin, digest: a.digest, detail,
    });
  }

  /** Store an action for review. Reads the invoice; never writes to PayPal. */
  async prepare(input: PrepareInput): Promise<PendingAction> {
    if (!ACTION_KINDS.includes(input.kind)) throw invalid(`unknown action kind "${String(input.kind)}"`);
    const payload = validatePayload(input.kind, input.payload);
    let inv: Invoice | null = null;
    if (input.kind !== 'CREATE_DRAFT') {
      if (!input.invoiceId) throw invalid('invoiceId is required');
      inv = await this.client.getInvoice(input.invoiceId);
      checkStatus(input.kind, inv, payload);
    }
    const invoiceId = inv?.id ?? null;
    // One open proposal per invoice and kind, and one agent proposal per invoice: the newer wins.
    for (const old of this.actions.values()) {
      if (old.state === 'pending' && invoiceId && old.invoiceId === invoiceId
        && (old.kind === input.kind || (old.origin === 'agent' && input.origin === 'agent'))) {
        old.state = 'discarded';
        this.log('discarded', old, { reason: 'superseded by a newer proposal' });
      }
    }
    const created = this.now();
    const draft = payload.draft as InvoiceDraft | undefined;
    const party = (inv ?? draft)?.primary_recipients?.[0]?.billing_info;
    const action: PendingAction = {
      id: randomUUID(),
      kind: input.kind,
      invoiceId,
      invoiceNumber: inv?.detail.invoice_number ?? null,
      customer: party?.business_name ?? party?.email_address ?? null,
      payload,
      origin: input.origin,
      rationale: input.rationale ?? null,
      source: input.source ?? null,
      warnings: input.warnings ?? [],
      calls: describeCalls(input.kind, invoiceId),
      digest: '',
      snapshot: inv ? { status: inv.status, due: inv.due_amount?.value ?? '' } : null,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.ttlMs).toISOString(),
      state: 'pending',
      result: null,
    };
    action.digest = this.digestOf(action);
    this.actions.set(action.id, action);
    this.log('proposed', action, { payload, rationale: action.rationale, source: action.source, warnings: action.warnings, calls: action.calls });
    return action;
  }

  get(id: string): PendingAction | undefined {
    return this.actions.get(id);
  }

  /** Actions still waiting for a decision, oldest first. */
  pending(): PendingAction[] {
    return [...this.actions.values()].filter((a) => a.state === 'pending');
  }

  private mustBePending(id: string): PendingAction {
    const a = this.actions.get(id);
    if (!a) throw new GateError('NOT_FOUND', 'No such action.');
    if (a.state !== 'pending') throw new GateError('NOT_PENDING', `This action is ${a.state}; it cannot be changed or confirmed again.`);
    return a;
  }

  /** The human edited the payload (typically the message). The digest changes with it. */
  revise(id: string, payload: Record<string, unknown>): PendingAction {
    const a = this.mustBePending(id);
    const next = validatePayload(a.kind, { ...a.payload, ...payload });
    a.payload = next;
    a.digest = this.digestOf(a);
    this.log('revised', a, { payload: next });
    return a;
  }

  discard(id: string): PendingAction {
    const a = this.mustBePending(id);
    a.state = 'discarded';
    this.log('discarded', a, { reason: 'discarded by the user' });
    return a;
  }

  /**
   * Execute a prepared action. `confirm` must be literally true and `digest` must be the digest of
   * the payload the human was shown; anything else is refused and nothing is sent.
   */
  async confirm(id: string, proof: { confirm?: unknown; digest?: unknown }): Promise<PendingAction> {
    const a = this.mustBePending(id);
    if (proof?.confirm !== true) throw new GateError('NOT_CONFIRMED', 'An explicit confirmation (confirm: true) is required.');
    if (proof.digest !== a.digest) {
      throw new GateError('DIGEST_MISMATCH', 'What was confirmed is not what would be sent. Reload the action and review it again.');
    }
    const now = this.now();
    if (now.getTime() > Date.parse(a.expiresAt)) {
      a.state = 'expired';
      this.log('expired', a);
      throw new GateError('EXPIRED', 'This proposal has expired. Ask for a new one.');
    }
    a.state = 'executing'; // from here on a second confirm is refused, even while the first is in flight
    let fresh: Invoice | null = null;
    if (a.invoiceId) {
      try {
        fresh = await this.client.getInvoice(a.invoiceId);
      } catch (e) {
        a.state = 'pending';
        throw new GateError('PAYPAL_FAILED', `Could not re-read the invoice before sending: ${errorText(e)}`);
      }
      if (fresh.status !== a.snapshot?.status || (fresh.due_amount?.value ?? '') !== a.snapshot.due) {
        a.state = 'discarded';
        this.log('stale', a, { was: a.snapshot, now: { status: fresh.status, due: fresh.due_amount?.value ?? '' } });
        throw new GateError('STALE', 'The invoice changed at PayPal since this was proposed. Nothing was sent; ask for a new proposal.');
      }
    }
    this.log('confirmed', a);
    const confirmation = mintConfirmation(a.id, a.digest, now.toISOString());
    let step = a.calls[0];
    try {
      const p = a.payload;
      const notice = { subject: p.subject as string, note: p.note as string, send_to_recipient: true, send_to_invoicer: false };
      switch (a.kind) {
        case 'CREATE_DRAFT': {
          const draft = structuredClone(p.draft) as InvoiceDraft;
          if (!draft.detail.invoice_number) draft.detail.invoice_number = await this.client.nextInvoiceNumber();
          step = a.calls[1];
          const created = await this.client.createDraft(confirmation, draft);
          a.result = { invoiceId: created.id, invoiceNumber: created.detail.invoice_number ?? null };
          break;
        }
        case 'UPDATE_DRAFT': {
          const next = stripReadOnly(fresh!);
          if (p.reference !== undefined) next.detail.reference = p.reference as string;
          // Checked on the PayPal sandbox, 2026-11-03: DUE_ON_DATE_SPECIFIED with an explicit due_date is accepted, past dates included.
          if (p.dueDate !== undefined) next.detail.payment_term = { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: p.dueDate as string };
          await this.client.updateInvoice(confirmation, a.invoiceId!, next);
          a.result = { reference: p.reference ?? null, dueDate: p.dueDate ?? null };
          break;
        }
        case 'DELETE_DRAFT':
          await this.client.deleteDraft(confirmation, a.invoiceId!);
          break;
        case 'SEND':
          await this.client.send(confirmation, a.invoiceId!, notice);
          break;
        case 'REMIND':
          await this.client.remind(confirmation, a.invoiceId!, notice);
          break;
        case 'OFFER_PLAN': {
          // Checked on the PayPal sandbox, 2026-11-03: the PUT is accepted and partial_payment reads back. Kept for the record:
          // enabling configuration.partial_payment on an already-sent invoice by
          // PUT. If the sandbox refuses, the failure is journaled at this step and no reminder is sent.
          const next = stripReadOnly(fresh!);
          next.configuration = {
            ...next.configuration,
            partial_payment: { allow_partial_payment: true, minimum_amount_due: p.minimumAmount as Money },
          };
          await this.client.updateInvoice(confirmation, a.invoiceId!, next);
          step = a.calls[1];
          await this.client.remind(confirmation, a.invoiceId!, notice);
          a.result = { minimumAmount: p.minimumAmount };
          break;
        }
        case 'RECORD_PAYMENT': {
          const res = await this.client.recordPayment(confirmation, a.invoiceId!, {
            method: p.method as PaymentMethod, payment_date: p.paymentDate as string, amount: p.amount as Money,
            note: p.note as string | undefined,
          });
          a.result = { paymentId: res.payment_id ?? null };
          break;
        }
        case 'CANCEL':
          await this.client.cancel(confirmation, a.invoiceId!, notice);
          break;
      }
    } catch (e) {
      a.state = 'failed';
      const pp = e instanceof PayPalApiError ? e : null;
      this.log('failed', a, { step, error: errorText(e), status: pp?.status, debugId: pp?.debugId, issues: pp?.issues });
      throw new GateError('PAYPAL_FAILED', `PayPal refused or failed at "${step}": ${errorText(e)}`);
    }
    a.state = 'executed';
    this.log('executed', a, { calls: a.calls, result: a.result ?? undefined });
    return a;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
