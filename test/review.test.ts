/**
 * One test per defect found in the hostile review of 2026-10-11 (see NOTES-SEANCE.md).
 * References to "the spec" mean PayPal's public OpenAPI description, invoicing_v2.json v2.6.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test, type TestContext } from 'node:test';
import { proposeWithGuard, StubModel, type CollectionsModel } from '../src/agent/model.js';
import { allowedActions, extractFeatures, TONES } from '../src/agent/risk.js';
import { startDemo } from '../src/demo.js';
import { ConfirmationGate } from '../src/gate.js';
import { Journal, verifyChain } from '../src/journal.js';
import { seedInvoiceId } from '../src/mock/server.js';
import { PayPalClient, stripReadOnly } from '../src/paypal/client.js';
import {
  formatMoney, isOpen, isPlainAmount, isTwoDecimalCurrency, localDate, PAID_STATUSES, type Invoice,
} from '../src/paypal/types.js';

const EUR = (value: string) => ({ currency_code: 'EUR', value });
const invalid = (pattern: RegExp) => (e: any) => e.code === 'INVALID' && pattern.test(e.message);

async function setup(t: TestContext) {
  const demo = await startDemo({ now: () => new Date('2026-10-11T09:00:00Z') });
  t.after(() => demo.close());
  return demo;
}

/** A request with full control of the headers (fetch refuses to forge Host). */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------- PayPal client against the spec

test('stripReadOnly drops every read-only field of the spec and keeps the invoice-level discount and shipping', () => {
  const inv = {
    id: 'INV2-X', parent_id: 'INV2-P', status: 'SENT',
    detail: { currency_code: 'EUR', metadata: { create_time: 'x' }, viewed_by_recipient: true },
    amount: {
      ...EUR('95.00'),
      breakdown: {
        item_total: EUR('100.00'), tax_total: EUR('0.00'),
        discount: { invoice_discount: { amount: EUR('10.00') }, item_discount: EUR('0.00') },
        shipping: { amount: EUR('5.00') },
      },
    },
    due_amount: EUR('95.00'), gratuity: EUR('1.00'), refunds: {}, payments: {}, links: [],
  } as unknown as Invoice;
  const out = stripReadOnly(inv) as Record<string, any>;
  for (const k of ['id', 'parent_id', 'status', 'due_amount', 'gratuity', 'payments', 'refunds', 'links']) assert.equal(k in out, false, k);
  assert.deepEqual(out.amount, { breakdown: { discount: { invoice_discount: { amount: EUR('10.00') } }, shipping: { amount: EUR('5.00') } } });
  assert.deepEqual(out.detail, { currency_code: 'EUR' });
});

test('editing the due date of a discounted draft does not change its total', async (t) => {
  const demo = await setup(t);
  const id = seedInvoiceId(13);
  const draft = demo.mock.invoices.get(id)!;
  draft.amount = { ...EUR('800.00'), breakdown: { discount: { invoice_discount: { amount: EUR('100.00') } } } };
  draft.due_amount = EUR('800.00');
  const a = await demo.gate.prepare({ kind: 'UPDATE_DRAFT', invoiceId: id, payload: { dueDate: '2026-12-01' }, origin: 'user' });
  await demo.gate.confirm(a.id, { confirm: true, digest: a.digest });
  const after = await demo.client.getInvoice(id);
  assert.equal(after.detail.payment_term?.due_date, '2026-12-01');
  assert.equal(after.amount?.value, '800.00'); // 900.00 before the fix: the PUT dropped the discount
});

test('create and update ask for the resource (Prefer: return=representation) and need no extra GET', async (t) => {
  const demo = await setup(t);
  const draft = demo.ledger.draftFromForm({ customer: 'Acme', email: 'ap@acme.example', description: 'Work', amount: '120.50', currency: 'EUR', dueInDays: 30 });
  const a = await demo.gate.prepare({ kind: 'CREATE_DRAFT', payload: { draft }, origin: 'user' });
  const before = demo.mock.requests.length;
  const done = await demo.gate.confirm(a.id, { confirm: true, digest: a.digest });
  const made = demo.mock.requests.slice(before);
  assert.deepEqual(made.map((r) => `${r.method} ${r.path}`), ['POST /v2/invoicing/generate-next-invoice-number', 'POST /v2/invoicing/invoices']);
  assert.equal(made[1].prefer, 'return=representation');
  assert.match(String(done.result?.invoiceId), /^INV2-/);
});

test('a server that ignores Prefer answers with a link, and the client follows it', async (t) => {
  const demo = await setup(t);
  const client = new PayPalClient({
    baseUrl: demo.mock.baseUrl, clientId: demo.mock.clientId, clientSecret: demo.mock.clientSecret,
    fetchImpl: ((url: any, init: any) => {
      const headers = { ...(init?.headers as Record<string, string>) };
      delete headers.Prefer;
      return fetch(url, { ...init, headers });
    }) as typeof fetch,
  });
  const gate = new ConfirmationGate({ client, journal: new Journal(), now: () => new Date('2026-10-11T09:00:00Z') });
  const draft = demo.ledger.draftFromForm({ customer: 'Acme', email: 'ap@acme.example', description: 'Work', amount: '80', currency: 'EUR', dueInDays: 10 });
  const a = await gate.prepare({ kind: 'CREATE_DRAFT', payload: { draft }, origin: 'user' });
  const created = await gate.confirm(a.id, { confirm: true, digest: a.digest });
  const id = String(created.result?.invoiceId);
  assert.equal(demo.mock.invoices.get(id)?.amount?.value, '80.00');
  const b = await gate.prepare({ kind: 'UPDATE_DRAFT', invoiceId: id, payload: { reference: 'PO-7' }, origin: 'user' });
  await gate.confirm(b.id, { confirm: true, digest: b.digest });
  assert.equal(demo.mock.invoices.get(id)?.detail.reference, 'PO-7');
});

test('a partially paid invoice cannot be cancelled: refused at the gate, never proposed, 422 at PayPal', async (t) => {
  const demo = await setup(t);
  const id = seedInvoiceId(6);
  await assert.rejects(
    () => demo.gate.prepare({ kind: 'CANCEL', invoiceId: id, payload: { subject: 'Cancelled', note: 'Cancelled.' }, origin: 'user' }),
    invalid(/partially paid/));
  const inv = await demo.client.getInvoice(id);
  const f = extractFeatures(inv, [inv], { count: 3, lastAt: null }, '2027-06-01');
  assert.ok(f.daysOverdue >= 90);
  const allowed = allowedActions(inv, f);
  assert.equal(allowed.includes('WRITE_OFF'), false);
  assert.ok(allowed.includes('OFFER_PLAN'));

  const basic = Buffer.from(`${demo.mock.clientId}:${demo.mock.clientSecret}`).toString('base64');
  const token = await (await fetch(`${demo.mock.baseUrl}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  })).json() as { access_token: string };
  const res = await fetch(`${demo.mock.baseUrl}/v2/invoicing/invoices/${id}/cancel`, {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json() as any).details[0].issue, 'CANNOT_CANCEL_PAID_INVOICE');
});

test('the statuses added to the spec are known: PAID_EXTERNAL is paid, SHARED and AUTO_CANCELLED are not open', () => {
  assert.ok(PAID_STATUSES.includes('PAID_EXTERNAL'));
  assert.equal(isOpen('SHARED'), false);
  assert.equal(isOpen('AUTO_CANCELLED'), false);
});

// ---------------------------------------------------------------- the local HTTP API

test('a request addressed to another host name (DNS rebinding) is refused, reads included', async (t) => {
  const demo = await setup(t);
  const a = await demo.gate.prepare({ kind: 'REMIND', invoiceId: seedInvoiceId(7), payload: { subject: 'Reminder', note: 'Please pay.' }, origin: 'user' });
  const body = JSON.stringify({ confirm: true, digest: a.digest });
  const evil = { host: `evil.example:${new URL(demo.url).port}` };
  assert.equal((await raw(demo.url, 'GET', '/api/actions', evil)).status, 403);
  assert.equal((await raw(demo.url, 'GET', '/', evil)).status, 403);
  const hit = await raw(demo.url, 'POST', `/api/actions/${a.id}/confirm`, { ...evil, origin: `http://${evil.host}`, 'content-type': 'application/json' }, body);
  assert.equal(hit.status, 403);
  assert.equal(demo.mock.reminders.length, 0);
  assert.equal(demo.gate.get(a.id)?.state, 'pending');
});

test('writes with Origin "null", a cross-site fetch marker or a disguised content type are refused', async (t) => {
  const demo = await setup(t);
  const a = await demo.gate.prepare({ kind: 'REMIND', invoiceId: seedInvoiceId(7), payload: { subject: 'Reminder', note: 'Please pay.' }, origin: 'user' });
  const body = JSON.stringify({ confirm: true, digest: a.digest });
  const path = `/api/actions/${a.id}/confirm`;
  const host = { host: new URL(demo.url).host };
  assert.equal((await raw(demo.url, 'POST', path, { ...host, origin: 'null', 'content-type': 'application/json' }, body)).status, 403);
  assert.equal((await raw(demo.url, 'POST', path, { ...host, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body)).status, 403);
  assert.equal((await raw(demo.url, 'POST', path, { ...host, 'content-type': 'text/plain; application/json' }, body)).status, 415);
  assert.equal(demo.mock.reminders.length, 0);
  const ok = await raw(demo.url, 'POST', path, { ...host, origin: demo.url, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' }, body);
  assert.equal(ok.status, 200);
  assert.equal(demo.mock.reminders.length, 1);
});

// ---------------------------------------------------------------- money and dates

test('amounts are refused, not truncated: three decimals, exponents, decimal-free currencies, mixed currencies', async (t) => {
  const demo = await setup(t);
  const pay = (value: string) => demo.gate.prepare({
    kind: 'RECORD_PAYMENT', invoiceId: seedInvoiceId(7), origin: 'user',
    payload: { method: 'BANK_TRANSFER', paymentDate: '2026-10-10', amount: EUR(value) },
  });
  await assert.rejects(() => pay('10.005'), invalid(/two decimals/));
  await assert.rejects(() => pay('1e2'), invalid(/two decimals/));
  assert.equal((await pay('10.5')).state, 'pending');
  const draft = (currency: string, itemCurrency = currency) => demo.gate.prepare({
    kind: 'CREATE_DRAFT', origin: 'user',
    payload: { draft: {
      detail: { currency_code: currency }, primary_recipients: [{ billing_info: { email_address: 'ap@acme.example' } }],
      items: [{ name: 'Work', quantity: '1', unit_amount: { currency_code: itemCurrency, value: '1000' } }],
    } },
  });
  await assert.rejects(() => draft('JPY'), invalid(/not supported/));
  await assert.rejects(() => draft('EUR', 'USD'), invalid(/invoice currency/));
  const form = { customer: 'Acme', email: 'ap@acme.example', description: 'Work', dueInDays: 30 };
  assert.throws(() => demo.ledger.draftFromForm({ ...form, amount: '10.999', currency: 'EUR' }), /two decimals/);
  assert.throws(() => demo.ledger.draftFromForm({ ...form, amount: '1000', currency: 'JPY' }), /not supported/);
  assert.equal(demo.mock.writes().length, 0);
});

test('decimal-free currencies are shown without invented decimals and get no payment plan', async (t) => {
  const demo = await setup(t);
  assert.equal(formatMoney(100_000, 'JPY'), 'JPY 1,000');
  assert.equal(formatMoney(245_000, 'EUR'), 'EUR 2,450.00');
  assert.deepEqual(['EUR', 'USD', 'JPY', 'HUF', 'KWD', 'eur'].map(isTwoDecimalCurrency), [true, true, false, false, false, false]);
  assert.deepEqual(['120', '120.5', '120.50', '120.505', '-1', '1e3', ''].map(isPlainAmount), [true, true, true, false, false, false, false]);
  const eur = await demo.client.getInvoice(seedInvoiceId(7));
  const jpy = structuredClone(eur);
  jpy.detail.currency_code = 'JPY';
  const none = { count: 0, lastAt: null };
  assert.ok(allowedActions(eur, extractFeatures(eur, [eur], none, '2026-10-11')).includes('OFFER_PLAN'));
  assert.equal(allowedActions(jpy, extractFeatures(jpy, [jpy], none, '2026-10-11')).includes('OFFER_PLAN'), false);
});

test('"today" is the user\'s calendar day, and a reminder is never "-1 days ago"', async (t) => {
  const demo = await setup(t);
  assert.equal(localDate(new Date('2026-10-12T02:30:00Z'), 'America/Los_Angeles'), '2026-10-11');
  assert.equal(localDate(new Date('2026-10-11T23:30:00Z'), 'Asia/Tokyo'), '2026-10-12');
  assert.match(localDate(new Date('2026-10-11T12:00:00Z'), 'Not/A_Zone'), /^2026-10-1[012]$/);
  const inv = await demo.client.getInvoice(seedInvoiceId(7));
  const f = extractFeatures(inv, [inv], { count: 1, lastAt: '2026-10-12T01:00:00.000Z' }, '2026-10-11');
  assert.equal(f.daysSinceLastReminder, 0);
});

// ---------------------------------------------------------------- the model guard

test('a draft with any number that is not a fact of the invoice falls back to the rules', async (t) => {
  const demo = await setup(t);
  const all = await demo.ledger.invoices();
  const input = demo.ledger.buildInput(all.find((i) => i.id === seedInvoiceId(7))!, all, 'neutral');
  const fake = (note: string, subject = 'Reminder'): CollectionsModel => ({
    name: 'fake', propose: async () => ({ action: 'REMIND', reason: 'Because.', subject, note }),
  });
  for (const note of [
    'Please pay, plus a late fee of 50.',
    'You now owe SEK 9,999.00.',
    'Pay within 3 days or we add 12% interest.',
    'Call 0800 123 456 to settle.',
  ]) {
    const g = await proposeWithGuard(fake(note), input);
    assert.equal(g.source, 'rules-fallback', note);
    assert.equal(g.warnings.length, 1, note);
    assert.equal(g.proposal.note.includes(note), false);
  }
  const honest = `Invoice ${input.invoice.number} was due on ${input.invoice.dueDate}: ${input.invoice.due} is still open, ${input.features.daysOverdue} days late. Please pay within 7 days.`;
  const ok = await proposeWithGuard(fake(honest, 'Reminder\r\nBcc: someone@evil.example'), input);
  assert.equal(ok.source, 'fake');
  assert.deepEqual(ok.warnings, []);
  assert.equal(/[\r\n]/.test(ok.proposal.subject), false);
});

test('the rule-based drafts pass the same guard for every open sample invoice and every tone', async (t) => {
  const demo = await setup(t);
  const all = await demo.ledger.invoices();
  const stub = new StubModel();
  let checked = 0;
  for (const inv of all.filter((i) => isOpen(i.status))) {
    for (const tone of TONES) {
      const g = await proposeWithGuard(stub, demo.ledger.buildInput(inv, all, tone));
      assert.deepEqual([g.source, g.warnings], [stub.name, []], `${inv.detail.invoice_number} ${tone}`);
      checked += 1;
    }
  }
  assert.equal(checked, 18);
});

// ---------------------------------------------------------------- the journal

test('the chain alone does not see a cut tail; the head hash does, and the API exposes it', async (t) => {
  const demo = await setup(t);
  const j = new Journal();
  assert.equal(j.head(), '0'.repeat(64));
  j.append({ type: 'proposed' });
  j.append({ type: 'confirmed' });
  j.append({ type: 'executed' });
  const cut = j.all().slice(0, 2);
  assert.equal(verifyChain(cut).ok, true); // the documented limit of a keyless chain
  assert.notEqual(cut[cut.length - 1].hash, j.head());
  const res = await (await fetch(`${demo.url}/api/journal`)).json() as { head: string; chain: { ok: boolean } };
  assert.equal(res.head, demo.journal.head());
  assert.equal(res.chain.ok, true);
});
