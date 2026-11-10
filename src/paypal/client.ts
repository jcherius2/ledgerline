/**
 * PayPal Invoicing v2 client. Plain `fetch`, no SDK.
 *
 * The same code talks to the local mock (`npm run demo`, tests) and to the real sandbox
 * (`PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`). Every assumption about the real API
 * that has not been checked against the sandbox is marked UNVERIFIED-SANDBOX (none left after the
 * session of 2026-11-03). Paths, methods,
 * query parameters, bodies and status codes were compared on 2026-10-11 with PayPal's public
 * OpenAPI description (paypal/paypal-rest-api-specifications, openapi/invoicing_v2.json, v2.6).
 *
 * Every method that changes something at PayPal takes a `Confirmation` as its first argument.
 * Confirmations are minted in one place only (src/gate.ts), after a human has confirmed the exact
 * payload. Without one, the method throws before any network request is made.
 */
import { randomUUID } from 'node:crypto';
import { assertConfirmed, type Confirmation } from '../confirmation.js';
import type { AmountBreakdown, Invoice, InvoiceDraft, InvoiceList, Notification, PaymentRecord } from './types.js';

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds since epoch; injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Checked on the PayPal sandbox, 2026-11-03: error bodies are {name, message, debug_id, details, links} (404 RESOURCE_NOT_FOUND
// seen). They are read as {name, message, debug_id, details:[{issue}]} and, for
// OAuth, {error, error_description}. Any other shape still yields an error with the HTTP status.
export class PayPalApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly debugId: string | undefined;
  readonly issues: string[];
  constructor(status: number, body: unknown, method: string, path: string) {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const code = String(b.name ?? b.error ?? `HTTP_${status}`);
    const message = String(b.message ?? b.error_description ?? 'PayPal request failed');
    super(`${method} ${path} -> ${status} ${code}: ${message}`);
    this.name = 'PayPalApiError';
    this.status = status;
    this.code = code;
    this.debugId = typeof b.debug_id === 'string' ? b.debug_id : undefined;
    this.issues = Array.isArray(b.details)
      ? b.details.map((d) => String((d as Record<string, unknown>)?.issue ?? '')).filter(Boolean)
      : [];
  }
}

/** The read-only half of the client: the only part the HTTP layer and the agent ever receive. */
export interface PayPalReader {
  listInvoices(page?: number, pageSize?: number): Promise<InvoiceList>;
  listAllInvoices(maxInvoices?: number): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice>;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** Ask for the resource in the answer (`Prefer: return=representation`, per the spec for create and update). */
  preferRepresentation?: boolean;
}

const INVOICES = '/v2/invoicing/invoices';

export class PayPalClient implements PayPalReader {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly baseUrl: string;

  constructor(private readonly config: PayPalConfig) {
    if (!config.clientId || !config.clientSecret) throw new Error('PayPal client id and secret are required');
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ------------------------------------------------------------------ auth

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await readBody(res);
    if (!res.ok) throw new PayPalApiError(res.status, body, 'POST', '/v1/oauth2/token');
    const b = body as { access_token?: string; expires_in?: number };
    if (!b.access_token) throw new Error('PayPal token response had no access_token');
    this.token = { value: b.access_token, expiresAt: this.now() + (b.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const qs = opts.query
      ? '?' + new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString()
      : '';
    // Checked on the PayPal sandbox, 2026-11-03: every POST carrying PayPal-Request-Id was accepted; idempotency not probed.
    // PayPal-Request-Id is documented as the idempotency header for Orders and
    // Payments; the Invoicing v2 spec declares no header parameter at all, so it is probably ignored
    // here. It is sent on every POST, harmless if ignored, and nothing relies on it: a failed write
    // is never repeated. One id per logical call, reused across the 401 retry.
    const requestId = method === 'POST' ? randomUUID() : undefined;
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const token = await this.accessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      if (opts.preferRepresentation) headers.Prefer = 'return=representation';
      const res = await this.fetchImpl(`${this.baseUrl}${path}${qs}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.status === 401 && !refreshed) {
        // Token revoked or expired early: fetch a new one and retry exactly once.
        refreshed = true;
        this.token = null;
        await res.arrayBuffer();
        continue;
      }
      // Only reads are retried on throttling or server errors: a write is never repeated blindly.
      if (method === 'GET' && (res.status === 429 || res.status >= 500) && attempt < 2) {
        attempt += 1;
        await res.arrayBuffer();
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      const body = await readBody(res);
      if (!res.ok) throw new PayPalApiError(res.status, body, method, path);
      return body as T;
    }
  }

  // ------------------------------------------------------------------ reads

  listInvoices(page = 1, pageSize = 100): Promise<InvoiceList> {
    // Checked on the PayPal sandbox, 2026-11-03: total_items and total_pages come back with total_required=true, and the
    // `next` link points at api.sandbox.paypal.com. The loop below also stops on a short page.
    return this.request<InvoiceList>('GET', INVOICES, {
      query: { page, page_size: pageSize, total_required: true },
    });
  }

  async listAllInvoices(maxInvoices = 500, pageSize = 100): Promise<Invoice[]> {
    const out: Invoice[] = [];
    for (let page = 1; out.length < maxInvoices; page += 1) {
      const res = await this.listInvoices(page, pageSize);
      const items = res.items ?? [];
      out.push(...items);
      if (items.length < pageSize) break;
      if (res.total_pages !== undefined && page >= res.total_pages) break;
    }
    return out.slice(0, maxInvoices);
  }

  getInvoice(id: string): Promise<Invoice> {
    return this.request<Invoice>('GET', `${INVOICES}/${encodeURIComponent(id)}`);
  }

  // The sandbox answers 415 UNSUPPORTED_MEDIA_TYPE to a POST with no body (2026-11-03): an empty
  // JSON object is sent so the request carries Content-Type: application/json.
  async nextInvoiceNumber(): Promise<string> {
    const res = await this.request<{ invoice_number: string }>('POST', '/v2/invoicing/generate-next-invoice-number', { body: {} });
    return res.invoice_number;
  }

  // ------------------------------------------------------------------ writes (confirmation required)

  async createDraft(c: Confirmation, draft: InvoiceDraft): Promise<Invoice> {
    assertConfirmed(c);
    const res = await this.request<Partial<Invoice> & { href?: string }>('POST', INVOICES, { body: draft, preferRepresentation: true });
    if (res.id && res.status) return res as Invoice;
    // Checked on the PayPal sandbox, 2026-11-03: creation works with `Prefer: return=representation`. Per the spec the 201
    // carries a link object ({rel:"self", href}) without the header; both shapes are handled.
    const href = res.href ?? res.links?.find((l) => l.rel === 'self')?.href;
    const id = href?.split('/').filter(Boolean).pop();
    if (!id) throw new Error('PayPal create-invoice response had neither an invoice nor a self link');
    return this.getInvoice(id);
  }

  async updateInvoice(c: Confirmation, id: string, invoice: InvoiceDraft): Promise<Invoice> {
    assertConfirmed(c);
    // PUT is a full replacement. Checked on the PayPal sandbox, 2026-11-03: a body built from a GET with the read-only
    // fields removed (see stripReadOnly) is accepted on drafts and on sent invoices, total unchanged,
    // and send_to_recipient=false sends no "invoice updated" email.
    const res = await this.request<Invoice | undefined>('PUT', `${INVOICES}/${encodeURIComponent(id)}`, {
      query: { send_to_recipient: false, send_to_invoicer: false },
      body: invoice,
      preferRepresentation: true,
    });
    return res && res.id ? res : this.getInvoice(id);
  }

  async deleteDraft(c: Confirmation, id: string): Promise<void> {
    assertConfirmed(c);
    await this.request<void>('DELETE', `${INVOICES}/${encodeURIComponent(id)}`);
  }

  // Checked on the PayPal sandbox, 2026-11-03, sandbox notifications page: the invoice email has PayPal's own subject
  // and shows the invoice's detail.note as "seller note", not this note; the reminder email is a
  // fixed template showing neither. The reviewed wording therefore reaches the customer only through
  // the mail link the queue offers. The rest of this comment is the spec as first read.
  // The spec gives send, remind and cancel the same `notification` body
  // ({subject, note, send_to_invoicer, send_to_recipient, additional_recipients}); send answers 200
  // (or 202 when scheduled) with a link, remind and cancel 204. Any response body is ignored.
  // IMPORTANT, from the same spec: "User-provided values for this field will not be honored" for
  // both `subject` and `note`: PayPal may email its own standard text instead of the reviewed
  // draft. To be settled on the sandbox; the UI and the README say so. Also: two reminders a day
  // at most per API caller.
  async send(c: Confirmation, id: string, n: Notification): Promise<void> {
    assertConfirmed(c);
    await this.request<unknown>('POST', `${INVOICES}/${encodeURIComponent(id)}/send`, { body: n });
  }

  async remind(c: Confirmation, id: string, n: Notification): Promise<void> {
    assertConfirmed(c);
    await this.request<void>('POST', `${INVOICES}/${encodeURIComponent(id)}/remind`, { body: n });
  }

  async cancel(c: Confirmation, id: string, n: Notification): Promise<void> {
    assertConfirmed(c);
    await this.request<void>('POST', `${INVOICES}/${encodeURIComponent(id)}/cancel`, { body: n });
  }

  // Checked on the PayPal sandbox, 2026-11-03: body {method, payment_date, amount, note}; answer {payment_id} (EXTR-…);
  // partial then full payment gives PARTIALLY_PAID then MARKED_AS_PAID.
  async recordPayment(c: Confirmation, id: string, p: PaymentRecord): Promise<{ payment_id?: string }> {
    assertConfirmed(c);
    const res = await this.request<{ payment_id?: string } | undefined>(
      'POST', `${INVOICES}/${encodeURIComponent(id)}/payments`, { body: p });
    return res ?? {};
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/**
 * Remove the fields the spec marks read-only before sending an invoice back in a full update.
 * `amount` is NOT read-only: its breakdown carries the invoice-level discount, shipping and custom
 * amount, and a PUT without them would silently change the total. Those inputs are kept; the
 * computed parts (value, item_total, tax_total, item_discount) are dropped.
 * Checked on the PayPal sandbox, 2026-11-03: the sandbox accepts this body as is (line items keep their read-only `id`).
 */
export function stripReadOnly(inv: Invoice): InvoiceDraft {
  const {
    id: _id, parent_id: _parent, status: _status, amount, due_amount: _due, gratuity: _gratuity,
    payments: _payments, refunds: _refunds, links: _links, ...rest
  } = inv;
  const detail = { ...rest.detail };
  delete detail.metadata;
  delete detail.viewed_by_recipient;
  const out: InvoiceDraft = { ...rest, detail };
  const b = amount?.breakdown;
  const breakdown: AmountBreakdown = {};
  if (b?.discount?.invoice_discount) breakdown.discount = { invoice_discount: b.discount.invoice_discount };
  if (b?.shipping) breakdown.shipping = b.shipping;
  if (b?.custom) breakdown.custom = b.custom;
  if (Object.keys(breakdown).length) out.amount = { breakdown };
  return out;
}
