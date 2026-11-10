/**
 * A local stand-in for the PayPal Invoicing v2 API, used by `npm run demo` and the tests.
 *
 * It follows the public reference as closely as could be done without a sandbox account:
 * OAuth2 client_credentials on /v1/oauth2/token, then /v2/invoicing/invoices and its actions,
 * with PayPal-shaped error bodies ({name, message, debug_id, details:[{issue, description}]}).
 * The `issue` strings of cancel, remind and record-payment are the ones in PayPal's OpenAPI spec
 * (invoicing_v2.json, v2.6); the others are illustrative. Like the spec, create and update answer
 * with the invoice only when asked (`Prefer: return=representation`), a link otherwise, and a full
 * update that omits `amount.breakdown` loses the invoice-level discount, shipping and custom amount.
 * One known difference: this mock keeps the subject and note of a reminder, while the spec says
 * PayPal does not honour them. See NOTES-SEANCE.md.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  addDays, fromCents, isoDate, isOpen, toCents, PAYMENT_METHODS,
  type Invoice, type InvoiceItem, type InvoiceStatus, type PaymentTransaction,
} from '../paypal/types.js';

export interface MockOptions {
  port?: number;
  clientId?: string;
  clientSecret?: string;
  now?: () => Date;
  tokenTtlSeconds?: number;
  invoices?: Invoice[];
}

export interface MockRequestLog {
  method: string;
  path: string;
  status: number;
  requestId?: string;
  prefer?: string;
}

export interface MockPayPal {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  invoices: Map<string, Invoice>;
  reminders: { invoiceId: string; subject?: string; note?: string; at: string }[];
  /** Every authenticated API request, in order (token requests are counted apart). */
  requests: MockRequestLog[];
  tokenRequests: number;
  /** Requests that changed, or tried to change, something. */
  writes(): MockRequestLog[];
  revokeTokens(): void;
  /** Make the next `times` API requests (optionally of one method) fail with `status`. */
  failNext(status: number, times?: number, method?: string): void;
  close(): Promise<void>;
}

const INVOICER = { business_name: 'Juniper Studio', email_address: 'billing@juniper-studio.example' };

interface SeedSpec {
  n: number;
  customer: { business: string; given: string; surname: string; email: string };
  status: InvoiceStatus;
  issued: number;
  due: number;
  currency: string;
  items: [string, number, number][];
  paid?: { offset: number; cents: number; method?: 'PAYPAL' | 'BANK_TRANSFER' }[];
  viewed?: boolean;
  reference?: string;
}

const C = {
  moreau: { business: 'Atelier Moreau', given: 'Camille', surname: 'Moreau', email: 'camille@atelier-moreau.example' },
  northwind: { business: 'Northwind Studio', given: 'Dana', surname: 'Whitfield', email: 'accounts@northwind-studio.example' },
  harbor: { business: 'Old Harbor Cafe', given: 'Tom', surname: 'Brandt', email: 'tom@oldharborcafe.example' },
  kessler: { business: 'Kessler GmbH', given: 'Jonas', surname: 'Kessler', email: 'buchhaltung@kessler-gmbh.example' },
  lumen: { business: 'Lumen Labs Inc.', given: 'Priya', surname: 'Raman', email: 'ap@lumenlabs.example' },
  bright: { business: 'Brightside Bakery', given: 'Ines', surname: 'Duarte', email: 'ines@brightside-bakery.example' },
  pixel: { business: 'Pixel & Co', given: 'Sam', surname: 'Okafor', email: 'sam@pixelandco.example' },
};

/** Thirteen invoices dated relative to `today`, so the demo always shows the same picture. */
const SEEDS: SeedSpec[] = [
  { n: 1, customer: C.moreau, status: 'PAID', issued: -150, due: -120, currency: 'EUR', items: [['Brand identity, phase 1', 1, 140000]], paid: [{ offset: -125, cents: 140000 }], viewed: true },
  { n: 2, customer: C.northwind, status: 'PAID', issued: -140, due: -110, currency: 'EUR', items: [['Website redesign, discovery', 1, 210000]], paid: [{ offset: -92, cents: 210000 }], viewed: true },
  { n: 3, customer: C.moreau, status: 'PAID', issued: -95, due: -65, currency: 'EUR', items: [['Packaging mock-ups', 7, 14000]], paid: [{ offset: -70, cents: 98000 }], viewed: true },
  { n: 4, customer: C.northwind, status: 'PAID', issued: -100, due: -70, currency: 'EUR', items: [['Website redesign, templates', 1, 175000]], paid: [{ offset: -45, cents: 175000 }], viewed: true },
  { n: 5, customer: C.harbor, status: 'SENT', issued: -170, due: -140, currency: 'EUR', items: [['Menu card reprint, artwork fix', 1, 6000]], viewed: true },
  { n: 6, customer: C.kessler, status: 'PARTIALLY_PAID', issued: -82, due: -52, currency: 'EUR', items: [['Trade-fair booth graphics', 1, 240000], ['Print supervision', 4, 15000]], paid: [{ offset: -40, cents: 100000, method: 'BANK_TRANSFER' }], viewed: true, reference: 'PO-7741' },
  { n: 7, customer: C.northwind, status: 'SENT', issued: -68, due: -38, currency: 'EUR', items: [['Website redesign, build', 1, 245000]], viewed: true },
  { n: 8, customer: C.lumen, status: 'PAID', issued: -60, due: -30, currency: 'USD', items: [['Pitch deck design', 1, 220000]], paid: [{ offset: -33, cents: 220000 }], viewed: true },
  { n: 9, customer: C.bright, status: 'SENT', issued: -42, due: -12, currency: 'EUR', items: [['Shop window lettering', 1, 38000]], viewed: false },
  { n: 10, customer: C.pixel, status: 'CANCELLED', issued: -35, due: -5, currency: 'EUR', items: [['Icon set (cancelled by client)', 1, 64000]], viewed: true },
  { n: 11, customer: C.lumen, status: 'SENT', issued: -35, due: -5, currency: 'USD', items: [['Investor one-pager', 1, 180000]], viewed: true },
  { n: 12, customer: C.moreau, status: 'SENT', issued: -20, due: 10, currency: 'EUR', items: [['Brand identity, phase 2', 1, 120000]], viewed: true },
  { n: 13, customer: C.moreau, status: 'DRAFT', issued: 0, due: 30, currency: 'EUR', items: [['Brand guidelines PDF', 1, 90000]] },
];

export function seedInvoiceId(n: number): string {
  return `INV2-DEMO-${String(n).padStart(4, '0')}-AAAA-BBBB`;
}

export function seedInvoices(today: Date, baseUrl = ''): Invoice[] {
  const t = isoDate(today);
  return SEEDS.map((s) => {
    const transactions: PaymentTransaction[] = (s.paid ?? []).map((p, i) => ({
      payment_id: `PAY-DEMO-${s.n}-${i + 1}`,
      type: p.method === 'BANK_TRANSFER' ? 'EXTERNAL' : 'PAYPAL',
      method: p.method ?? 'PAYPAL',
      payment_date: addDays(t, p.offset),
      amount: { currency_code: s.currency, value: fromCents(p.cents) },
    }));
    const inv: Invoice = {
      id: seedInvoiceId(s.n),
      status: s.status,
      detail: {
        invoice_number: `INV-${String(s.n).padStart(4, '0')}`,
        reference: s.reference,
        invoice_date: addDays(t, s.issued),
        currency_code: s.currency,
        note: 'Thank you for your business.',
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: addDays(t, s.due) },
        viewed_by_recipient: s.viewed,
        metadata: { create_time: `${addDays(t, s.issued)}T09:00:00Z` },
      },
      invoicer: INVOICER,
      primary_recipients: [{
        billing_info: {
          name: { given_name: s.customer.given, surname: s.customer.surname },
          business_name: s.customer.business,
          email_address: s.customer.email,
        },
      }],
      items: s.items.map(([name, qty, cents]): InvoiceItem => ({
        name, quantity: String(qty), unit_amount: { currency_code: s.currency, value: fromCents(cents) },
      })),
      payments: transactions.length ? { transactions } : undefined,
    };
    recompute(inv, baseUrl);
    return inv;
  });
}

function recompute(inv: Invoice, baseUrl: string): void {
  const cur = inv.detail.currency_code;
  const total = (inv.items ?? []).reduce((sum, it) => sum + Math.round(Number(it.quantity) * toCents(it.unit_amount.value)), 0);
  const paid = (inv.payments?.transactions ?? []).reduce((sum, t) => sum + toCents(t.amount?.value), 0);
  const b = inv.amount?.breakdown;
  const grand = total + toCents(b?.shipping?.amount?.value) + toCents(b?.custom?.amount?.value)
    - toCents(b?.discount?.invoice_discount?.amount?.value);
  inv.amount = { currency_code: cur, value: fromCents(grand), ...(b ? { breakdown: b } : {}) };
  inv.due_amount = { currency_code: cur, value: fromCents(Math.max(0, grand - paid)) };
  if (inv.payments) inv.payments.paid_amount = { currency_code: cur, value: fromCents(paid) };
  inv.links = [{ rel: 'self', href: `${baseUrl}/v2/invoicing/invoices/${inv.id}`, method: 'GET' }];
}

function newId(prefix: string, groups: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `${prefix}-${Array.from({ length: groups }, part).join('-')}`;
}

export async function startMockPayPal(options: MockOptions = {}): Promise<MockPayPal> {
  const clientId = options.clientId ?? 'mock-client-id';
  const clientSecret = options.clientSecret ?? 'mock-client-secret';
  const now = options.now ?? (() => new Date());
  const ttl = options.tokenTtlSeconds ?? 32_400;
  const tokens = new Map<string, number>();
  const invoices = new Map<string, Invoice>();
  let fault: { status: number; remaining: number; method?: string } | null = null;
  let baseUrl = '';

  const mock: MockPayPal = {
    baseUrl: '',
    clientId,
    clientSecret,
    invoices,
    reminders: [],
    requests: [],
    tokenRequests: 0,
    writes: () => mock.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/generate-next-invoice-number')),
    revokeTokens: () => tokens.clear(),
    failNext: (status, times = 1, method) => { fault = { status, remaining: times, method }; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };

  const debugId = () => randomBytes(7).toString('hex');
  const problem = (name: string, message: string, issue?: string, description?: string) => ({
    name, message, debug_id: debugId(),
    details: issue ? [{ issue, description: description ?? message }] : [],
    links: [{ href: 'https://developer.paypal.com/docs/api/invoicing/#errors', rel: 'information_link', method: 'GET' }],
  });
  const unprocessable = (issue: string, description: string) =>
    problem('UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', issue, description);
  const summary = (inv: Invoice) => ({
    id: inv.id, status: inv.status, detail: inv.detail, invoicer: inv.invoicer,
    primary_recipients: inv.primary_recipients, amount: inv.amount, due_amount: inv.due_amount, links: inv.links,
  });
  const nextNumber = () => {
    const nums = [...invoices.values()].map((i) => Number(/(\d+)$/.exec(i.detail.invoice_number ?? '')?.[1] ?? 0));
    return `INV-${String(Math.max(0, ...nums) + 1).padStart(4, '0')}`;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const raw = Buffer.concat(chunks).toString('utf8');
      let status = 500;
      const reply = (code: number, body?: unknown) => {
        status = code;
        if (body === undefined) { res.writeHead(code); res.end(); return; }
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      const wantsBody = /return=representation/i.test(String(req.headers.prefer ?? ''));
      const breakdownOf = (b: any): Invoice['amount'] =>
        (b?.amount?.breakdown ? ({ breakdown: b.amount.breakdown } as Invoice['amount']) : undefined);
      // ---- OAuth2 client_credentials
      if (method === 'POST' && path === '/v1/oauth2/token') {
        mock.tokenRequests += 1;
        const expected = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        if (req.headers.authorization !== expected) {
          return reply(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
        }
        if (new URLSearchParams(raw).get('grant_type') !== 'client_credentials') {
          return reply(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
        }
        const token = 'A21AA' + randomBytes(24).toString('base64url');
        tokens.set(token, now().getTime() + ttl * 1000);
        return reply(200, {
          scope: 'https://uri.paypal.com/services/invoicing', access_token: token, token_type: 'Bearer',
          app_id: 'APP-MOCK', expires_in: ttl, nonce: randomBytes(8).toString('hex'),
        });
      }

      try {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const expiry = bearer ? tokens.get(bearer) : undefined;
        if (!expiry || expiry <= now().getTime()) {
          return reply(401, { error: 'invalid_token', error_description: 'Access Token not found in cache' });
        }
        if (fault && fault.remaining > 0 && (!fault.method || fault.method === method)) {
          fault.remaining -= 1;
          return reply(fault.status, problem(
            fault.status === 429 ? 'RATE_LIMIT_REACHED' : 'INTERNAL_SERVER_ERROR',
            fault.status === 429 ? 'Too many requests. Blocked due to rate limiting.' : 'An internal server error has occurred.'));
        }
        let body: any = undefined;
        if (raw) {
          try { body = JSON.parse(raw); } catch {
            return reply(400, problem('INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'MALFORMED_REQUEST_JSON'));
          }
        }

        if (method === 'POST' && path === '/v2/invoicing/generate-next-invoice-number') {
          return reply(200, { invoice_number: nextNumber() });
        }
        const m = /^\/v2\/invoicing\/invoices(?:\/([^/]+))?(?:\/(send|remind|cancel|payments))?(?:\/([^/]+))?$/.exec(path);
        if (!m) return reply(404, problem('RESOURCE_NOT_FOUND', 'The specified resource does not exist.'));
        const [, id, action, subId] = m;

        // ---- collection
        if (!id) {
          if (method === 'GET') {
            const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
            const size = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size') ?? 20)));
            const all = [...invoices.values()].reverse();
            const out: Record<string, unknown> = {
              items: all.slice((page - 1) * size, page * size).map(summary),
              links: [{ rel: 'self', href: `${baseUrl}${path}${url.search}`, method: 'GET' }],
            };
            if (url.searchParams.get('total_required') === 'true') {
              out.total_items = all.length;
              out.total_pages = Math.ceil(all.length / size);
            }
            return reply(200, out);
          }
          if (method === 'POST') {
            if (!body?.detail?.currency_code) {
              return reply(400, problem('INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'MISSING_REQUIRED_PARAMETER', 'detail.currency_code is required.'));
            }
            const number = body.detail.invoice_number ?? nextNumber();
            if ([...invoices.values()].some((i) => i.detail.invoice_number === number)) {
              return reply(422, unprocessable('DUPLICATE_INVOICE_NUMBER', 'The invoice number already exists.'));
            }
            const inv: Invoice = {
              id: newId('INV2', 4), status: 'DRAFT',
              detail: { invoice_date: isoDate(now()), ...body.detail, invoice_number: number, metadata: { create_time: now().toISOString() } },
              invoicer: body.invoicer ?? INVOICER,
              primary_recipients: body.primary_recipients ?? [],
              items: body.items ?? [],
              configuration: body.configuration,
              amount: breakdownOf(body),
            };
            recompute(inv, baseUrl);
            invoices.set(inv.id, inv);
            return reply(201, wantsBody ? inv : { rel: 'self', href: `${baseUrl}/v2/invoicing/invoices/${inv.id}`, method: 'GET' });
          }
          return reply(405, problem('METHOD_NOT_SUPPORTED', 'Method not supported.'));
        }

        const inv = invoices.get(id);
        if (!inv) return reply(404, problem('RESOURCE_NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID', `Invoice ${id} was not found.`));

        // ---- single invoice
        if (!action) {
          if (method === 'GET') return reply(200, inv);
          if (method === 'PUT') {
            if (inv.status !== 'DRAFT' && !isOpen(inv.status)) {
              return reply(422, unprocessable('CANNOT_UPDATE_INVOICE', `An invoice in status ${inv.status} cannot be updated.`));
            }
            if (!body?.detail?.currency_code) {
              return reply(400, problem('INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'MISSING_REQUIRED_PARAMETER', 'detail.currency_code is required.'));
            }
            inv.detail = { ...body.detail, metadata: inv.detail.metadata, viewed_by_recipient: inv.detail.viewed_by_recipient };
            inv.primary_recipients = body.primary_recipients ?? inv.primary_recipients;
            inv.items = body.items ?? inv.items;
            inv.configuration = body.configuration;
            inv.amount = breakdownOf(body); // a full replacement: what is not sent is gone
            recompute(inv, baseUrl);
            return reply(200, wantsBody ? inv : { rel: 'self', href: `${baseUrl}/v2/invoicing/invoices/${inv.id}`, method: 'GET' });
          }
          if (method === 'DELETE') {
            if (inv.status !== 'DRAFT' && inv.status !== 'SCHEDULED') {
              return reply(422, unprocessable('CANNOT_DELETE_INVOICE', 'Only draft or scheduled invoices can be deleted.'));
            }
            invoices.delete(id);
            return reply(204);
          }
          return reply(405, problem('METHOD_NOT_SUPPORTED', 'Method not supported.'));
        }

        // ---- actions
        if (action === 'payments' && subId && method === 'DELETE') {
          const txs = inv.payments?.transactions ?? [];
          const idx = txs.findIndex((t) => t.payment_id === subId);
          if (idx < 0) return reply(404, problem('RESOURCE_NOT_FOUND', 'The specified resource does not exist.'));
          txs.splice(idx, 1);
          recompute(inv, baseUrl);
          inv.status = toCents(inv.payments?.paid_amount?.value) > 0 ? 'PARTIALLY_PAID' : 'SENT';
          return reply(204);
        }
        if (method !== 'POST' || subId) return reply(405, problem('METHOD_NOT_SUPPORTED', 'Method not supported.'));

        if (action === 'send') {
          if (inv.status !== 'DRAFT') return reply(422, unprocessable('INVOICE_ALREADY_SENT', `An invoice in status ${inv.status} cannot be sent.`));
          if (!inv.primary_recipients?.[0]?.billing_info?.email_address) {
            return reply(422, unprocessable('RECIPIENT_EMAIL_REQUIRED', 'A recipient email address is required to send an invoice.'));
          }
          inv.status = 'SENT';
          inv.detail.metadata = { ...inv.detail.metadata, first_sent_time: now().toISOString() };
          return reply(200, { rel: 'self', href: `${baseUrl}/v2/invoicing/invoices/${inv.id}`, method: 'GET' });
        }
        if (action === 'remind') {
          if (!isOpen(inv.status)) return reply(422, unprocessable('CANNOT_REMIND_INVOICE', `A reminder cannot be sent for an invoice in status ${inv.status}.`));
          mock.reminders.push({ invoiceId: id, subject: body?.subject, note: body?.note, at: now().toISOString() });
          return reply(204);
        }
        if (action === 'cancel') {
          const refusal: Partial<Record<InvoiceStatus, [string, string]>> = {
            DRAFT: ['CANNOT_CANCEL_DRAFT_INVOICE', 'Draft invoice cannot be canceled.'],
            PAID: ['CANNOT_CANCEL_PAID_INVOICE', 'Cannot cancel a paid or partially paid invoice.'],
            MARKED_AS_PAID: ['CANNOT_CANCEL_PAID_INVOICE', 'Cannot cancel a paid or partially paid invoice.'],
            PARTIALLY_PAID: ['CANNOT_CANCEL_PAID_INVOICE', 'Cannot cancel a paid or partially paid invoice.'],
            REFUNDED: ['CANNOT_CANCEL_REFUNDED_INVOICE', 'Cannot cancel a refunded or partially refunded invoice.'],
            PARTIALLY_REFUNDED: ['CANNOT_CANCEL_REFUNDED_INVOICE', 'Cannot cancel a refunded or partially refunded invoice.'],
            SCHEDULED: ['CANNOT_CANCEL_SCHEDULED_INVOICE', 'Cannot cancel a scheduled invoice.'],
            CANCELLED: ['INVOICE_CANCELED_ALREADY', 'Invoice is already cancelled.'],
          };
          const why = refusal[inv.status];
          if (why) return reply(422, unprocessable(why[0], why[1]));
          inv.status = 'CANCELLED';
          return reply(204);
        }
        // payments
        if (!isOpen(inv.status)) return reply(422, unprocessable('CANNOT_PROCESS_PAYMENTS', `A payment cannot be recorded for an invoice in status ${inv.status}.`));
        if (!PAYMENT_METHODS.includes(body?.method)) {
          return reply(400, problem('INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'MISSING_REQUIRED_PARAMETER', 'method is required.'));
        }
        const due = toCents(inv.due_amount?.value);
        const amount = body.amount?.value !== undefined ? toCents(body.amount.value) : due;
        if (amount <= 0 || amount > due) return reply(422, unprocessable('PAYMENT_AMOUNT_GREATER_THAN_AMOUNT_DUE', 'The payment amount must be positive and no more than the amount due.'));
        const paymentId = newId('EXTR', 2);
        inv.payments = inv.payments ?? { transactions: [] };
        inv.payments.transactions = inv.payments.transactions ?? [];
        inv.payments.transactions.push({
          payment_id: paymentId, type: 'EXTERNAL', method: body.method,
          payment_date: body.payment_date ?? isoDate(now()),
          amount: { currency_code: inv.detail.currency_code, value: fromCents(amount) }, note: body.note,
        });
        recompute(inv, baseUrl);
        inv.status = toCents(inv.due_amount?.value) === 0 ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID';
        return reply(200, { payment_id: paymentId });
      } finally {
        const requestId = req.headers['paypal-request-id'];
        const prefer = req.headers.prefer;
        mock.requests.push({
          method, path, status, requestId: typeof requestId === 'string' ? requestId : undefined,
          prefer: typeof prefer === 'string' ? prefer : undefined,
        });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.baseUrl = baseUrl;
  for (const inv of options.invoices ?? seedInvoices(now(), baseUrl)) invoices.set(inv.id, inv);
  return mock;
}
