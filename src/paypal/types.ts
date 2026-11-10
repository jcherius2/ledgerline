/**
 * Shapes of the PayPal Invoicing v2 API that Ledgerline reads and writes.
 * Only the fields the app uses are typed; everything else passes through untouched.
 */

export interface Money {
  currency_code: string;
  value: string;
}

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'SCHEDULED'
  | 'PAID'
  | 'MARKED_AS_PAID'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIALLY_PAID'
  | 'PARTIALLY_REFUNDED'
  | 'MARKED_AS_REFUNDED'
  | 'UNPAID'
  | 'PAYMENT_PENDING'
  // In PayPal's OpenAPI spec (invoicing_v2.json, v2.6) since the first draft of this file:
  | 'AUTO_CANCELLED'
  | 'PAID_EXTERNAL'
  | 'REFUNDED_EXTERNAL'
  | 'SHARED';

export type PaymentMethod =
  | 'BANK_TRANSFER'
  | 'CASH'
  | 'CHECK'
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'PAYPAL'
  | 'WIRE_TRANSFER'
  | 'OTHER';

export const PAYMENT_METHODS: PaymentMethod[] = [
  'BANK_TRANSFER', 'CASH', 'CHECK', 'CREDIT_CARD', 'DEBIT_CARD', 'PAYPAL', 'WIRE_TRANSFER', 'OTHER',
];

export interface LinkDescription {
  href: string;
  rel: string;
  method?: string;
}

export interface InvoiceDetail {
  invoice_number?: string;
  reference?: string;
  invoice_date?: string;
  currency_code: string;
  note?: string;
  memo?: string;
  payment_term?: { term_type?: string; due_date?: string };
  // Checked on the PayPal sandbox, 2026-11-03: `detail.viewed_by_recipient` is present (false before opening), although it
  // is not in the OpenAPI schema of `detail` (v2.6). When absent the rules read "unknown", never "unopened".
  viewed_by_recipient?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Party {
  name?: { given_name?: string; surname?: string; full_name?: string };
  business_name?: string;
  email_address?: string;
}

export interface Recipient {
  billing_info?: Party;
}

export interface InvoiceItem {
  name: string;
  description?: string;
  quantity: string;
  unit_amount: Money;
  unit_of_measure?: string;
}

export interface PaymentTransaction {
  payment_id?: string;
  type?: 'PAYPAL' | 'EXTERNAL';
  payment_date?: string;
  method?: PaymentMethod;
  amount?: Money;
  note?: string;
}

export interface InvoiceConfiguration {
  partial_payment?: { allow_partial_payment?: boolean; minimum_amount_due?: Money };
  allow_tip?: boolean;
  tax_calculated_after_discount?: boolean;
  tax_inclusive?: boolean;
}

/** The parts of `amount.breakdown` Ledgerline must carry through a full update. */
export interface AmountBreakdown {
  item_total?: Money;
  tax_total?: Money;
  discount?: { invoice_discount?: { percent?: string; amount?: Money }; item_discount?: Money };
  shipping?: { amount?: Money; tax?: unknown };
  custom?: { label?: string; amount?: Money };
}

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  detail: InvoiceDetail;
  invoicer?: Party;
  primary_recipients?: Recipient[];
  items?: InvoiceItem[];
  configuration?: InvoiceConfiguration;
  /** The total, plus the invoice-level inputs (discount, shipping, custom amount) in `breakdown`. */
  amount?: Money & { breakdown?: AmountBreakdown };
  due_amount?: Money;
  payments?: { paid_amount?: Money; transactions?: PaymentTransaction[] };
  /** Read-only in the spec, like id, status, due_amount and links. */
  parent_id?: string;
  gratuity?: Money;
  refunds?: unknown;
  links?: LinkDescription[];
}

/** What is sent to create or fully update an invoice: no server-owned fields. */
export type InvoiceDraft =
  Omit<Invoice, 'id' | 'parent_id' | 'status' | 'amount' | 'due_amount' | 'gratuity' | 'payments' | 'refunds' | 'links'>
  & { amount?: { breakdown?: AmountBreakdown } };

export interface InvoiceList {
  items?: Invoice[];
  total_items?: number;
  total_pages?: number;
  links?: LinkDescription[];
}

/** Body of the send, remind and cancel actions. */
export interface Notification {
  subject?: string;
  note?: string;
  send_to_invoicer?: boolean;
  send_to_recipient?: boolean;
  additional_recipients?: string[];
}

export interface PaymentRecord {
  method: PaymentMethod;
  payment_date?: string;
  amount?: Money;
  note?: string;
}

/**
 * Statuses in which money is still expected and a reminder makes sense.
 * Checked on the PayPal sandbox, 2026-11-03: a sent invoice stays SENT even past its due date (no UNPAID seen); payments
 * are recorded on SENT and PARTIALLY_PAID. The spec refuses to cancel a partially paid invoice
 * (enforced in gate.ts).
 */
export const OPEN_STATUSES: InvoiceStatus[] = ['SENT', 'UNPAID', 'PARTIALLY_PAID'];
export const PAID_STATUSES: InvoiceStatus[] = ['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'];

export function isOpen(status: InvoiceStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

// ---------------------------------------------------------------- money and dates

/** "12.5" -> 1250. Amounts are kept as integer cents everywhere outside the wire format. */
export function toCents(value: string | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const m = /^(-?)(\d+)(?:\.(\d{1,}))?$/.exec(String(value).trim());
  if (!m) throw new Error(`Not a decimal amount: ${value}`);
  const frac = ((m[3] ?? '') + '00').slice(0, 2);
  const cents = Number(m[2]) * 100 + Number(frac);
  return m[1] === '-' ? -cents : cents;
}

/** 1250 -> "12.50" (the wire format PayPal expects for two-decimal currencies). */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 245000, "EUR" -> "EUR 2,450.00". Code first: unambiguous in an email to another country. */
export function formatMoney(cents: number, currency: string): string {
  const [whole, frac] = fromCents(Math.abs(cents)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // PayPal sends whole numbers for currencies without decimals; do not invent a ".00".
  const tail = ZERO_DECIMAL_CURRENCIES.includes(currency) && frac === '00' ? '' : `.${frac}`;
  return `${currency} ${cents < 0 ? '-' : ''}${grouped}${tail}`;
}

/** ISO 4217 currencies without minor units (PayPal itself lists HUF, JPY and TWD as decimal-free). */
export const ZERO_DECIMAL_CURRENCIES = [
  'BIF', 'CLP', 'DJF', 'GNF', 'HUF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'TWD', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];
const THREE_DECIMAL_CURRENCIES = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];

/** Ledgerline only writes amounts in two-decimal currencies; the others are shown, never written. */
export function isTwoDecimalCurrency(code: unknown): boolean {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code)
    && !ZERO_DECIMAL_CURRENCIES.includes(code) && !THREE_DECIMAL_CURRENCIES.includes(code);
}

/** "120", "120.5", "120.50": nothing that `toCents` would have to truncate or guess. */
export function isPlainAmount(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(value);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The calendar day of `d` where the user is (LEDGERLINE_TZ, else the system time zone). Due dates
 * are plain dates, so "is it late" must be asked in local time: in UTC an invoice due today would
 * already be "1 day past due" during a Californian evening.
 */
export function localDate(d: Date, timeZone: string | undefined = process.env.LEDGERLINE_TZ || undefined): string {
  const day = (tz?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  try {
    return day(timeZone);
  } catch {
    return day(); // unknown zone name: fall back to the system zone rather than fail every request
  }
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function recipientOf(inv: Invoice): { name: string; email: string } {
  const b = inv.primary_recipients?.[0]?.billing_info;
  const person = [b?.name?.given_name, b?.name?.surname].filter(Boolean).join(' ') || b?.name?.full_name || '';
  return { name: b?.business_name || person || b?.email_address || 'Unknown customer', email: b?.email_address ?? '' };
}
