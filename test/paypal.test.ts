import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mintConfirmation, UnconfirmedWriteError } from '../src/confirmation.js';
import { seedInvoiceId, startMockPayPal } from '../src/mock/server.js';
import { PayPalApiError, PayPalClient, stripReadOnly } from '../src/paypal/client.js';
import type { InvoiceDraft } from '../src/paypal/types.js';

const T0 = Date.parse('2026-10-11T09:00:00Z');
const ok = mintConfirmation('test-action', 'test-digest', new Date(T0).toISOString());

async function setup(t: TestContext, tokenTtlSeconds?: number) {
  let ms = T0;
  const mock = await startMockPayPal({ now: () => new Date(ms), tokenTtlSeconds });
  t.after(() => mock.close());
  const client = new PayPalClient({
    baseUrl: mock.baseUrl, clientId: mock.clientId, clientSecret: mock.clientSecret, now: () => ms, sleep: async () => {},
  });
  return { mock, client, advance: (by: number) => { ms += by; } };
}

const draft = (number?: string): InvoiceDraft => ({
  detail: { currency_code: 'EUR', invoice_number: number, payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-10' } },
  primary_recipients: [{ billing_info: { business_name: 'Test Customer', email_address: 'pay@customer.example' } }],
  items: [{ name: 'Work', quantity: '2', unit_amount: { currency_code: 'EUR', value: '50.00' } }],
});

test('gets a token with client credentials and lists the invoices', async (t) => {
  const { mock, client } = await setup(t);
  const list = await client.listInvoices();
  assert.equal(list.items?.length, 13);
  assert.equal(list.total_items, 13);
  assert.equal(mock.tokenRequests, 1);
});

test('reuses the cached token across calls', async (t) => {
  const { mock, client } = await setup(t);
  await client.listInvoices();
  await client.getInvoice(seedInvoiceId(1));
  await client.getInvoice(seedInvoiceId(2));
  assert.equal(mock.tokenRequests, 1);
});

test('wrong client secret fails with a 401 PayPalApiError', async (t) => {
  const { mock } = await setup(t);
  const bad = new PayPalClient({ baseUrl: mock.baseUrl, clientId: mock.clientId, clientSecret: 'wrong' });
  await assert.rejects(bad.listInvoices(), (e: any) => e instanceof PayPalApiError && e.status === 401 && e.code === 'invalid_client');
});

test('a revoked token is refreshed and the request retried once', async (t) => {
  const { mock, client } = await setup(t);
  await client.listInvoices();
  mock.revokeTokens();
  const inv = await client.getInvoice(seedInvoiceId(7));
  assert.equal(inv.detail.invoice_number, 'INV-0007');
  assert.equal(mock.tokenRequests, 2);
  assert.deepEqual(mock.requests.map((r) => r.status), [200, 401, 200]);
});

test('a token about to expire is renewed before the call, without a 401', async (t) => {
  const { mock, client, advance } = await setup(t, 120);
  await client.listInvoices();
  advance(61_000);
  await client.listInvoices();
  assert.equal(mock.tokenRequests, 2);
  assert.ok(mock.requests.every((r) => r.status === 200));
});

test('listAllInvoices follows the pages', async (t) => {
  const { mock, client } = await setup(t);
  const all = await client.listAllInvoices(500, 5);
  assert.equal(new Set(all.map((i) => i.id)).size, 13);
  assert.equal(mock.requests.length, 3);
});

test('list items are summaries; getInvoice returns line items and payments', async (t) => {
  const { client } = await setup(t);
  const list = await client.listInvoices();
  assert.ok(list.items!.every((i) => i.items === undefined && i.payments === undefined));
  const inv = await client.getInvoice(seedInvoiceId(6));
  assert.equal(inv.items?.length, 2);
  assert.equal(inv.status, 'PARTIALLY_PAID');
  assert.equal(inv.amount?.value, '3000.00');
  assert.equal(inv.payments?.paid_amount?.value, '1000.00');
  assert.equal(inv.due_amount?.value, '2000.00');
});

test('an unknown invoice is a 404 RESOURCE_NOT_FOUND with a debug id', async (t) => {
  const { client } = await setup(t);
  await assert.rejects(client.getInvoice('INV2-NOPE'), (e: any) =>
    e instanceof PayPalApiError && e.status === 404 && e.code === 'RESOURCE_NOT_FOUND' && typeof e.debugId === 'string');
});

test('a write without a confirmation is refused before any network request', async (t) => {
  const { mock, client } = await setup(t);
  await assert.rejects(client.remind(undefined as any, seedInvoiceId(7), { note: 'x' }), UnconfirmedWriteError);
  await assert.rejects(client.cancel(null as any, seedInvoiceId(7), {}), UnconfirmedWriteError);
  await assert.rejects(client.createDraft({} as any, draft()), UnconfirmedWriteError);
  assert.equal(mock.requests.length, 0);
  assert.equal(mock.tokenRequests, 0);
});

test('a look-alike confirmation object is refused', async (t) => {
  const { mock, client } = await setup(t);
  const forged = { actionId: ok.actionId, digest: ok.digest, confirmedAt: ok.confirmedAt };
  await assert.rejects(client.send(forged, seedInvoiceId(13), {}), UnconfirmedWriteError);
  await assert.rejects(client.recordPayment(forged, seedInvoiceId(7), { method: 'CASH' }), UnconfirmedWriteError);
  assert.equal(mock.writes().length, 0);
});

test('createDraft follows the self link and returns the new draft', async (t) => {
  const { client } = await setup(t);
  const number = await client.nextInvoiceNumber();
  assert.equal(number, 'INV-0014');
  const created = await client.createDraft(ok, draft(number));
  assert.match(created.id, /^INV2-/);
  assert.equal(created.status, 'DRAFT');
  assert.equal(created.detail.invoice_number, 'INV-0014');
  assert.equal(created.amount?.value, '100.00');
});

test('a duplicate invoice number is a 422 with the issue named', async (t) => {
  const { client } = await setup(t);
  await assert.rejects(client.createDraft(ok, draft('INV-0001')), (e: any) =>
    e instanceof PayPalApiError && e.status === 422 && e.issues.includes('DUPLICATE_INVOICE_NUMBER'));
});

test('send moves a draft to SENT, and cannot be repeated', async (t) => {
  const { client } = await setup(t);
  await client.send(ok, seedInvoiceId(13), { subject: 'Invoice', note: 'Hello', send_to_recipient: true });
  assert.equal((await client.getInvoice(seedInvoiceId(13))).status, 'SENT');
  await assert.rejects(client.send(ok, seedInvoiceId(13), {}), (e: any) => e.status === 422);
});

test('remind on an open invoice reaches PayPal with the subject and note', async (t) => {
  const { mock, client } = await setup(t);
  await client.remind(ok, seedInvoiceId(7), { subject: 'Reminder', note: 'Please pay', send_to_recipient: true });
  assert.equal(mock.reminders.length, 1);
  assert.deepEqual({ ...mock.reminders[0], at: undefined }, { invoiceId: seedInvoiceId(7), subject: 'Reminder', note: 'Please pay', at: undefined });
});

test('remind on a paid invoice is a 422', async (t) => {
  const { mock, client } = await setup(t);
  await assert.rejects(client.remind(ok, seedInvoiceId(1), { note: 'x' }), (e: any) => e instanceof PayPalApiError && e.status === 422);
  assert.equal(mock.reminders.length, 0);
});

test('recordPayment: partial, then the rest', async (t) => {
  const { client } = await setup(t);
  const id = seedInvoiceId(7);
  const first = await client.recordPayment(ok, id, { method: 'BANK_TRANSFER', payment_date: '2026-10-11', amount: { currency_code: 'EUR', value: '450.00' } });
  assert.match(first.payment_id ?? '', /^EXTR-/);
  let inv = await client.getInvoice(id);
  assert.equal(inv.status, 'PARTIALLY_PAID');
  assert.equal(inv.due_amount?.value, '2000.00');
  await client.recordPayment(ok, id, { method: 'CASH', amount: { currency_code: 'EUR', value: '2000.00' } });
  inv = await client.getInvoice(id);
  assert.equal(inv.status, 'MARKED_AS_PAID');
  assert.equal(inv.due_amount?.value, '0.00');
});

test('a payment larger than the amount due is refused', async (t) => {
  const { client } = await setup(t);
  await assert.rejects(
    client.recordPayment(ok, seedInvoiceId(9), { method: 'CASH', amount: { currency_code: 'EUR', value: '380.01' } }),
    (e: any) => e.status === 422);
});

test('cancel sets CANCELLED; a draft cannot be cancelled', async (t) => {
  const { client } = await setup(t);
  await client.cancel(ok, seedInvoiceId(5), { subject: 'Cancelled', note: 'No payment expected' });
  assert.equal((await client.getInvoice(seedInvoiceId(5))).status, 'CANCELLED');
  await assert.rejects(client.cancel(ok, seedInvoiceId(13), {}), (e: any) => e.status === 422);
});

test('updateInvoice sends a full body without read-only fields', async (t) => {
  const { client } = await setup(t);
  const before = await client.getInvoice(seedInvoiceId(13));
  const body = stripReadOnly(before);
  assert.ok(!('id' in body) && !('status' in body) && !('amount' in body) && !('links' in body));
  assert.equal(body.detail.metadata, undefined);
  body.detail.payment_term = { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-12-01' };
  const after = await client.updateInvoice(ok, before.id, body);
  assert.equal(after.detail.payment_term?.due_date, '2026-12-01');
  assert.equal(after.status, 'DRAFT');
  assert.equal(after.amount?.value, '900.00');
});

test('deleteDraft removes a draft; a sent invoice cannot be deleted', async (t) => {
  const { client } = await setup(t);
  await client.deleteDraft(ok, seedInvoiceId(13));
  await assert.rejects(client.getInvoice(seedInvoiceId(13)), (e: any) => e.status === 404);
  await assert.rejects(client.deleteDraft(ok, seedInvoiceId(7)), (e: any) => e.status === 422);
});

test('a read is retried on 503 and 429, then gives up', async (t) => {
  const { mock, client } = await setup(t);
  mock.failNext(503, 2, 'GET');
  assert.equal((await client.getInvoice(seedInvoiceId(1))).status, 'PAID');
  assert.deepEqual(mock.requests.map((r) => r.status), [503, 503, 200]);
  mock.failNext(429, 3, 'GET');
  await assert.rejects(client.getInvoice(seedInvoiceId(1)), (e: any) => e.status === 429 && e.code === 'RATE_LIMIT_REACHED');
});

test('a write is never retried on a server error', async (t) => {
  const { mock, client } = await setup(t);
  mock.failNext(500, 1, 'POST');
  await assert.rejects(client.remind(ok, seedInvoiceId(7), { note: 'x' }), (e: any) => e.status === 500);
  assert.equal(mock.writes().length, 1);
  assert.equal(mock.reminders.length, 0);
});

test('POST requests carry a PayPal-Request-Id; reads do not', async (t) => {
  const { mock, client } = await setup(t);
  await client.getInvoice(seedInvoiceId(7));
  await client.remind(ok, seedInvoiceId(7), { note: 'x' });
  assert.equal(mock.requests[0].requestId, undefined);
  assert.match(mock.requests[1].requestId ?? '', /^[0-9a-f-]{36}$/);
});
