/**
 * The language-model side of the agent.
 *
 * `CollectionsModel` has two implementations: `StubModel` (deterministic templates; used by the
 * demo, the tests, and as the fallback) and `HttpModel` (an OpenAI-compatible chat-completions
 * endpoint or the Anthropic Messages API, chosen by environment variables).
 *
 * Whatever the model answers passes `proposeWithGuard`: the action must be one the rules allow,
 * and every money amount in the drafted message must be an amount that is really on the invoice.
 * Otherwise the rule-based draft is used and the reviewer is told why.
 */
import { formatMoney } from '../paypal/types.js';
import type { AgentAction, RiskFeatures, RiskLevel, Tone } from './risk.js';

export interface ProposalInput {
  invoice: {
    id: string;
    number: string;
    customer: string;
    contact: string;
    status: string;
    currency: string;
    invoiceDate: string;
    dueDate: string;
    total: string;
    due: string;
  };
  sender: string;
  features: RiskFeatures;
  risk: { score: number; level: RiskLevel; reasons: string[] };
  allowed: AgentAction[];
  /** What the deterministic rules recommend, and why. The model may disagree within `allowed`. */
  ruleAction: AgentAction;
  ruleWhy: string;
  tone: Tone;
  plan: { installments: number; amountCents: number; amount: string } | null;
}

export interface ModelProposal {
  action: AgentAction;
  reason: string;
  subject: string;
  note: string;
}

export interface CollectionsModel {
  readonly name: string;
  propose(input: ProposalInput): Promise<ModelProposal>;
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOutputError';
  }
}

// ---------------------------------------------------------------- deterministic drafts

/** The message for one action and tone, built only from facts in `input`. */
export function draftMessage(action: AgentAction, input: ProposalInput): { subject: string; note: string } {
  const { invoice: inv, features: f, sender, tone } = input;
  const hello = `Hello ${inv.contact || inv.customer},`;
  const sign = `\n\n${tone === 'friendly' ? 'Best regards' : 'Regards'},\n${sender}`;
  const days = `${f.daysOverdue} day${f.daysOverdue === 1 ? '' : 's'}`;
  const partial = f.partialPaid ? ` Thank you for the ${formatMoney(f.paidCents, f.currency)} already received.` : '';
  if (action === 'WAIT') return { subject: '', note: '' };
  if (action === 'WRITE_OFF') {
    return {
      subject: `Invoice ${inv.number} has been cancelled`,
      note: `${hello}\n\nInvoice ${inv.number} dated ${inv.invoiceDate} has been cancelled. No further payment is expected for it and you will receive no more reminders.${sign}`,
    };
  }
  if (action === 'OFFER_PLAN' && input.plan) {
    return {
      subject: `Invoice ${inv.number}: a payment plan for the remaining balance`,
      note: `${hello}\n\n${inv.due} is still open on invoice ${inv.number}, which was due on ${inv.dueDate}.${partial}\n\nTo make this easier, the balance can be settled in ${input.plan.installments} payments of ${input.plan.amount}. Part payments are now enabled on the invoice, so the first one can be made with the usual PayPal link whenever you are ready.\n\nIf another schedule would suit you better, just reply to this message.${sign}`,
    };
  }
  if (tone === 'friendly') {
    return {
      subject: `Friendly reminder: invoice ${inv.number}`,
      note: `${hello}\n\nA quick reminder that invoice ${inv.number} was due on ${inv.dueDate} and ${inv.due} is still open.${partial} If the payment is already on its way, please ignore this message, and thank you.\n\nThe PayPal link on the invoice is the quickest way to pay.${sign}`,
    };
  }
  if (tone === 'neutral') {
    return {
      subject: `Invoice ${inv.number} is ${days} past due`,
      note: `${hello}\n\nInvoice ${inv.number} was due on ${inv.dueDate} and is now ${days} past due. The open balance is ${inv.due}.${partial}\n\nPlease arrange payment with the PayPal link on the invoice, or reply if something is holding it up.${sign}`,
    };
  }
  return {
    subject: `Final reminder: invoice ${inv.number}, ${days} overdue`,
    note: `${hello}\n\nDespite earlier reminders, invoice ${inv.number} remains unpaid ${days} after its due date of ${inv.dueDate}. The open balance is ${inv.due}.${partial}\n\nPlease pay within 7 days using the PayPal link on the invoice. If there is a problem with the invoice or with paying it in full, reply now so that we can agree on a solution.${sign}`,
  };
}

export class StubModel implements CollectionsModel {
  readonly name = 'stub (deterministic rules)';
  async propose(input: ProposalInput): Promise<ModelProposal> {
    const action = input.allowed.includes(input.ruleAction) ? input.ruleAction : 'WAIT';
    const top = input.risk.reasons.slice(0, 3).join('; ');
    return {
      action,
      reason: `${capitalise(input.risk.level)} risk (${input.risk.score}/100): ${top}. ${input.ruleWhy}`,
      ...draftMessage(action, input),
    };
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- output validation

export function validateProposal(p: ModelProposal, input: ProposalInput): ModelProposal {
  const action = String(p?.action ?? '').toUpperCase() as AgentAction;
  if (!input.allowed.includes(action)) throw new ModelOutputError(`action "${action}" is not allowed for this invoice`);
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
  if (!reason || reason.length > 600) throw new ModelOutputError('reason is missing or too long');
  if (action === 'WAIT') return { action, reason, subject: '', note: '' };
  if (action === 'OFFER_PLAN' && !input.plan) throw new ModelOutputError('no plan is available for this invoice');
  const subject = typeof p.subject === 'string' ? p.subject.replace(/\s+/g, ' ').trim() : '';
  const note = typeof p.note === 'string' ? p.note.trim() : '';
  if (!subject || subject.length > 200) throw new ModelOutputError('subject is missing or longer than 200 characters');
  if (!note || note.length > 4000) throw new ModelOutputError('note is missing or longer than 4000 characters');
  return { action, reason, subject, note };
}

/** Parse the model's text answer: one JSON object, possibly wrapped in prose or a code fence. */
export function parseModelProposal(text: string, input: ProposalInput): ModelProposal {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelOutputError('no JSON object in the model answer');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelOutputError('the model answer is not valid JSON');
  }
  return validateProposal(parsed as ModelProposal, input);
}

const AMOUNT = /(?:(?:EUR|USD|GBP|CHF|CAD|AUD)\s?|[€$£]\s?)(\d[\d.,]*\d|\d)|(\d[\d.,]*\d|\d)\s?(?:EUR|USD|GBP|CHF|CAD|AUD|[€$£])/g;

function amountToCents(raw: string): number {
  const dot = raw.lastIndexOf('.');
  const comma = raw.lastIndexOf(',');
  let dec = -1;
  if (dot >= 0 && comma >= 0) dec = Math.max(dot, comma);
  else if (dot >= 0 || comma >= 0) {
    const at = Math.max(dot, comma);
    // "2,450" is a thousands separator; "2450,5" or "12.50" is a decimal one.
    if (raw.length - at - 1 !== 3) dec = at;
  }
  const whole = (dec >= 0 ? raw.slice(0, dec) : raw).replace(/[.,]/g, '');
  const frac = dec >= 0 ? raw.slice(dec + 1) : '';
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Every money amount in `text` that is not one of `allowedCents`. Empty means the draft is clean. */
export function checkDraftFacts(text: string, allowedCents: number[]): string[] {
  const offending: string[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const raw = m[1] ?? m[2];
    if (!allowedCents.includes(amountToCents(raw))) offending.push(m[0].trim());
  }
  return offending;
}

export function allowedAmounts(input: ProposalInput): number[] {
  const f = input.features;
  return [f.dueCents, f.totalCents, f.paidCents, ...(input.plan ? [input.plan.amountCents] : [])];
}

/**
 * Every number in `text` that no fact of the invoice explains. `checkDraftFacts` only sees amounts
 * written with a currency it knows; a model (or a hostile customer name echoed by it) can also write
 * "a late fee of 50", "SEK 9,999" or "within 3 days". Here the known strings are removed first
 * (invoice number, dates, formatted amounts, names), and every number left must be an invoice
 * amount, the days overdue, the plan, a part of one of the two dates, or the "7" of "within 7 days".
 * Numbers spelled out in words are beyond this check: the human review is what catches those.
 */
export function unexplainedNumbers(text: string, input: ProposalInput): string[] {
  const { invoice: inv, features: f, plan } = input;
  const known = [
    inv.number, inv.invoiceDate, inv.dueDate, inv.total, inv.due, plan?.amount, formatMoney(f.paidCents, f.currency),
    inv.customer, inv.contact, input.sender,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
  let rest = text;
  for (const k of known) rest = rest.split(k).join(' ');
  const dateParts = [inv.invoiceDate, inv.dueDate].flatMap((d) => (/^(\d{4})-(\d{2})-(\d{2})/.exec(d) ?? []).slice(1).map(Number));
  const integers = new Set<number>([Math.abs(f.daysOverdue), 7, ...(plan ? [plan.installments] : []), ...dateParts]);
  const cents = allowedAmounts(input);
  const odd: string[] = [];
  for (const m of rest.matchAll(/\d[\d.,]*\d|\d/g)) {
    const raw = m[0];
    if (/^\d+$/.test(raw) && integers.has(Number(raw))) continue;
    if (/[.,]/.test(raw) && cents.includes(amountToCents(raw))) continue;
    if (/^\d+$/.test(raw) && cents.includes(Number(raw) * 100) && Number(raw) * 100 >= 100) continue;
    odd.push(raw);
  }
  return odd;
}

export interface GuardedProposal {
  proposal: ModelProposal;
  /** The model's name, or "rules-fallback" when its answer was rejected. */
  source: string;
  warnings: string[];
}

export async function proposeWithGuard(
  model: CollectionsModel, input: ProposalInput, fallback: CollectionsModel = new StubModel(),
): Promise<GuardedProposal> {
  const warnings: string[] = [];
  try {
    const proposal = validateProposal(await model.propose(input), input);
    const text = `${proposal.subject}\n${proposal.note}`;
    const bad = checkDraftFacts(text, allowedAmounts(input));
    const odd = bad.length ? [] : unexplainedNumbers(text, input);
    if (bad.length === 0 && odd.length === 0) return { proposal, source: model.name, warnings };
    warnings.push(bad.length
      ? `The model's draft mentioned amounts that are not on the invoice (${bad.join(', ')}). The rule-based draft was used instead.`
      : `The model's draft contained numbers that are not facts of this invoice (${odd.slice(0, 5).join(', ')}). The rule-based draft was used instead.`);
  } catch (e) {
    warnings.push(`The model's answer could not be used (${e instanceof Error ? e.message : 'unknown error'}). The rule-based draft was used instead.`);
  }
  return { proposal: validateProposal(await fallback.propose(input), input), source: 'rules-fallback', warnings };
}

// ---------------------------------------------------------------- real model over HTTP

export const SYSTEM_PROMPT = [
  'You are the collections assistant inside Ledgerline, an invoice ledger used by a freelancer or a very small business.',
  'You never send anything yourself: a human reads your proposal and confirms or discards it.',
  'You receive the facts of one unpaid PayPal invoice as JSON: amounts, dates, payment history, a rule-based risk score with its reasons, the allowed actions and the action the rules recommend.',
  'Choose the next action among "allowed" and, unless it is WAIT, write the message to the customer in English in the requested tone (friendly, neutral or firm).',
  'Use only the facts given. Never invent an amount, a date, a fee, interest, a deadline other than "within 7 days", or a legal threat. Never tell the customer that they were scored.',
  'For OFFER_PLAN, state the plan exactly as given in "plan". For WRITE_OFF, the message tells the customer the invoice is cancelled.',
  'Keep the note under 120 words, plain text, signed with "sender".',
  'Answer with one JSON object and nothing else: {"action": "...", "reason": "one or two sentences for the business owner", "subject": "...", "note": "..."}.',
].join('\n');

export interface HttpModelConfig {
  provider: 'openai' | 'anthropic';
  baseUrl?: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpModel implements CollectionsModel {
  readonly name: string;
  constructor(private readonly config: HttpModelConfig) {
    if (!config.model) throw new Error('MODEL_NAME is required for a real model');
    if (!config.apiKey) throw new Error('MODEL_API_KEY is required for a real model');
    this.name = `${config.provider}:${config.model}`;
  }

  async propose(input: ProposalInput): Promise<ModelProposal> {
    const { provider, model, apiKey } = this.config;
    const f = this.config.fetchImpl ?? fetch;
    const user = JSON.stringify(input);
    const signal = AbortSignal.timeout(this.config.timeoutMs ?? 30_000);
    let res: Response;
    if (provider === 'anthropic') {
      const base = (this.config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
      res = await f(`${base}/v1/messages`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] }),
      });
    } else {
      const base = (this.config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      res = await f(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }),
      });
    }
    // The error carries the status only: never the key, never the provider's response body.
    if (!res.ok) throw new ModelOutputError(`model endpoint answered HTTP ${res.status}`);
    const body = (await res.json()) as any;
    const text: unknown = provider === 'anthropic'
      ? (Array.isArray(body?.content) ? body.content.find((b: any) => b?.type === 'text')?.text : undefined)
      : body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new ModelOutputError('model answer had no text');
    return parseModelProposal(text, input);
  }
}

export function modelFromEnv(env: Record<string, string | undefined>): CollectionsModel {
  const provider = (env.MODEL_PROVIDER ?? 'stub').toLowerCase();
  if (provider === 'stub') return new StubModel();
  if (provider !== 'openai' && provider !== 'anthropic') {
    throw new Error(`MODEL_PROVIDER must be "stub", "openai" or "anthropic" (got "${provider}")`);
  }
  return new HttpModel({ provider, baseUrl: env.MODEL_BASE_URL, model: env.MODEL_NAME ?? '', apiKey: env.MODEL_API_KEY ?? '' });
}
