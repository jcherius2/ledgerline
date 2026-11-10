/**
 * Risk rules. Deterministic, readable, and the same with or without a language model:
 * the model never decides the score. It explains, chooses among the actions these rules allow,
 * and writes the message.
 */
import {
  daysBetween, formatMoney, isOpen, isTwoDecimalCurrency, localDate, recipientOf, toCents, PAID_STATUSES, type Invoice,
} from '../paypal/types.js';

export type AgentAction = 'REMIND' | 'WAIT' | 'OFFER_PLAN' | 'WRITE_OFF';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Tone = 'friendly' | 'neutral' | 'firm';
export const TONES: Tone[] = ['friendly', 'neutral', 'firm'];

export interface ReminderHistory {
  count: number;
  lastAt: string | null;
}

export interface CustomerHistory {
  paidCount: number;
  lateCount: number;
  avgDaysLate: number;
}

export interface RiskFeatures {
  currency: string;
  totalCents: number;
  dueCents: number;
  paidCents: number;
  /** Positive when past due, zero or negative when not yet due. */
  daysOverdue: number;
  partialPaid: boolean;
  remindersSent: number;
  daysSinceLastReminder: number | null;
  viewedByRecipient: boolean | null;
  customer: CustomerHistory;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  reasons: string[];
  /** Amount due weighted by the score: what the ledger sorts by. */
  exposureCents: number;
  features: RiskFeatures;
}

export interface Recommendation {
  action: AgentAction;
  tone: Tone;
  why: string;
}

function paidOn(inv: Invoice): string | null {
  const dates = (inv.payments?.transactions ?? []).map((t) => t.payment_date).filter((d): d is string => !!d);
  return dates.length ? dates.sort()[dates.length - 1] : null;
}

/** How this customer settled their other, already paid invoices. */
export function customerHistory(all: Invoice[], email: string, excludeId: string): CustomerHistory {
  let paidCount = 0;
  let lateCount = 0;
  let lateDays = 0;
  for (const inv of all) {
    if (inv.id === excludeId || !PAID_STATUSES.includes(inv.status)) continue;
    if (!email || recipientOf(inv).email.toLowerCase() !== email.toLowerCase()) continue;
    paidCount += 1;
    const due = inv.detail.payment_term?.due_date;
    const paid = paidOn(inv);
    if (due && paid) {
      const late = daysBetween(due, paid);
      if (late > 0) { lateCount += 1; lateDays += late; }
    }
  }
  return { paidCount, lateCount, avgDaysLate: lateCount ? Math.round(lateDays / lateCount) : 0 };
}

/** A journal timestamp (UTC) as the user's calendar day, like `today`. */
function dayOf(timestamp: string): string {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? timestamp.slice(0, 10) : localDate(d);
}

export function extractFeatures(inv: Invoice, all: Invoice[], reminders: ReminderHistory, today: string): RiskFeatures {
  const totalCents = toCents(inv.amount?.value);
  const paidCents = toCents(inv.payments?.paid_amount?.value);
  // The list endpoint may omit due_amount; fall back to total minus payments.
  const dueCents = inv.due_amount ? toCents(inv.due_amount.value) : Math.max(0, totalCents - paidCents);
  const dueDate = inv.detail.payment_term?.due_date;
  return {
    currency: inv.detail.currency_code,
    totalCents,
    dueCents,
    paidCents,
    daysOverdue: dueDate ? daysBetween(dueDate, today) : 0,
    partialPaid: paidCents > 0 && dueCents > 0,
    remindersSent: reminders.count,
    daysSinceLastReminder: reminders.lastAt ? Math.max(0, daysBetween(dayOf(reminders.lastAt), today)) : null,
    viewedByRecipient: inv.detail.viewed_by_recipient ?? null,
    customer: customerHistory(all, recipientOf(inv).email, inv.id),
  };
}

export function overduePoints(daysOverdue: number): number {
  if (daysOverdue <= 0) return 0;
  if (daysOverdue <= 7) return 15;
  if (daysOverdue <= 30) return 35;
  if (daysOverdue <= 60) return 55;
  if (daysOverdue <= 90) return 70;
  return 85;
}

export function levelOf(score: number): RiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function scoreRisk(f: RiskFeatures): RiskAssessment {
  const reasons: string[] = [];
  let score = overduePoints(f.daysOverdue);
  if (f.daysOverdue > 0) reasons.push(`${plural(f.daysOverdue, 'day')} past due`);
  else if (f.daysOverdue === 0) reasons.push('Due today');
  else reasons.push(`Not due yet (due in ${plural(-f.daysOverdue, 'day')})`);

  if (f.daysOverdue > 0 && f.remindersSent > 0) {
    score += Math.min(15, 5 * f.remindersSent);
    reasons.push(`${plural(f.remindersSent, 'reminder')} already sent without full payment`);
  }
  const c = f.customer;
  if (c.paidCount >= 2 && c.lateCount * 2 >= c.paidCount) {
    score += 10;
    reasons.push(`Customer paid late on ${c.lateCount} of ${plural(c.paidCount, 'earlier invoice')} (about ${plural(c.avgDaysLate, 'day')} late)`);
  } else if (c.paidCount >= 2 && c.lateCount === 0) {
    score -= 15;
    reasons.push(`Customer paid ${plural(c.paidCount, 'earlier invoice')} on time`);
  } else if (c.paidCount === 0) {
    score += 5;
    reasons.push('No payment history with this customer');
  }
  if (f.partialPaid) {
    score -= 10;
    reasons.push(`Part payment received (${formatMoney(f.paidCents, f.currency)} of ${formatMoney(f.totalCents, f.currency)})`);
  }
  if (f.viewedByRecipient === false && f.daysOverdue > 0) {
    score += 5;
    reasons.push('Recipient has not opened the invoice: check the email address');
  }
  score = Math.max(0, Math.min(100, score));
  return { score, level: levelOf(score), reasons, exposureCents: Math.round((f.dueCents * score) / 100), features: f };
}

export function assess(inv: Invoice, all: Invoice[], reminders: ReminderHistory, today: string): RiskAssessment {
  return scoreRisk(extractFeatures(inv, all, reminders, today));
}

/** The actions the agent, rule-based or model-based, may propose for this invoice. */
export function allowedActions(inv: Invoice, f: RiskFeatures): AgentAction[] {
  if (!isOpen(inv.status) || f.dueCents <= 0) return [];
  const out: AgentAction[] = ['WAIT', 'REMIND'];
  if (f.daysOverdue > 0 && f.dueCents >= 20_000 && isTwoDecimalCurrency(f.currency)) out.push('OFFER_PLAN');
  // WRITE_OFF becomes a PayPal cancel, and PayPal refuses to cancel a paid or partially paid invoice.
  if (f.daysOverdue >= 90 && f.paidCents === 0 && inv.status !== 'PARTIALLY_PAID') out.push('WRITE_OFF');
  return out;
}

export function defaultTone(level: RiskLevel): Tone {
  return level === 'critical' ? 'firm' : level === 'high' ? 'neutral' : 'friendly';
}

/** Split of the remaining amount offered in a payment plan. */
export function planFor(dueCents: number): { installments: number; amountCents: number } {
  const installments = dueCents >= 150_000 ? 3 : 2;
  return { installments, amountCents: Math.ceil(dueCents / installments) };
}

export function recommend(f: RiskFeatures, risk: RiskAssessment, allowed: AgentAction[]): Recommendation {
  const tone = defaultTone(risk.level);
  if (!allowed.length) return { action: 'WAIT', tone, why: 'Nothing is owed on this invoice.' };
  if (f.daysOverdue <= 0) {
    return { action: 'WAIT', tone, why: f.daysOverdue === 0 ? 'It is due today; a reminder would be premature.' : `It is not due for another ${plural(-f.daysOverdue, 'day')}.` };
  }
  if (f.daysSinceLastReminder !== null && f.daysSinceLastReminder < 5) {
    return { action: 'WAIT', tone, why: `A reminder went out ${plural(f.daysSinceLastReminder, 'day')} ago; give it a few more days.` };
  }
  if (allowed.includes('WRITE_OFF') && f.daysOverdue > 120 && f.remindersSent >= 3 && f.dueCents < 10_000) {
    return { action: 'WRITE_OFF', tone: 'neutral', why: `After ${plural(f.remindersSent, 'reminder')} and ${f.daysOverdue} days, ${formatMoney(f.dueCents, f.currency)} costs more to chase than it is worth.` };
  }
  if (allowed.includes('OFFER_PLAN') && ((f.partialPaid && f.daysOverdue > 30) || (f.daysOverdue > 45 && f.remindersSent >= 2))) {
    const why = f.partialPaid
      ? 'The customer has started paying; a plan for the rest is more likely to succeed than another demand for the full amount.'
      : 'Plain reminders have not worked; smaller instalments lower the barrier.';
    return { action: 'OFFER_PLAN', tone: 'neutral', why };
  }
  return { action: 'REMIND', tone, why: f.remindersSent === 0 ? 'No reminder has been sent yet.' : 'The last reminder is old enough to follow up.' };
}
