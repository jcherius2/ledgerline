import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemo } from '../src/demo.js';
import { GateError, validatePayload } from '../src/gate.js';
import { canonical, Journal, verifyChain } from '../src/journal.js';
import { seedInvoiceId } from '../src/mock/server.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

async function setup(t: TestContext, ttlMs?: number) {
  let ms = Date.parse('2026-10-11T09:00:00Z');
  const demo = await startDemo({ now: () => new Date(ms), ttlMs });
  t.after(() => demo.close());
  const seeded = demo.journal.all().length;
  return { ...demo, advance: (by: number) => { ms += by; }, types: () => demo.journal.all().slice(seeded).map((e) => e.type) };
}

const remind = (n = 7) => ({
  kind: 'REMIND' as const, invoiceId: seedInvoiceId(n), origin: 'agent' as const,
  payload: { subject: 'Invoice overdue', note: 'Please pay invoice ' + n }, rationale: 'Late.',
});
const code = (c: string) => (e: any) => e instanceof GateError && e.code === c;

// ---------------------------------------------------------------- the gate

test('preparing an action journals it and sends nothing to PayPal', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  assert.equal(a.state, 'pending');
  assert.equal(a.invoiceNumber, 'INV-0007');
  assert.deepEqual(a.calls, [`POST /v2/invoicing/invoices/${seedInvoiceId(7)}/remind`]);
  assert.deepEqual(a.snapshot, { status: 'SENT', due: '2450.00' });
  assert.deepEqual(s.types(), ['proposed']);
  assert.equal(s.mock.writes().length, 0);
});

test('confirming without confirm:true is refused and nothing is sent', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  await assert.rejects(s.gate.confirm(a.id, { digest: a.digest }), code('NOT_CONFIRMED'));
  await assert.rejects(s.gate.confirm(a.id, { confirm: 'true', digest: a.digest }), code('NOT_CONFIRMED'));
  assert.equal(s.mock.writes().length, 0);
  assert.equal(a.state, 'pending');
});

test('confirming with the wrong digest is refused and nothing is sent', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: 'deadbeef' }), code('DIGEST_MISMATCH'));
  await assert.rejects(s.gate.confirm(a.id, { confirm: true }), code('DIGEST_MISMATCH'));
  assert.equal(s.mock.writes().length, 0);
  assert.equal(a.state, 'pending');
});

test('a confirmed reminder reaches PayPal exactly as reviewed and is journaled', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  const done = await s.gate.confirm(a.id, { confirm: true, digest: a.digest });
  assert.equal(done.state, 'executed');
  assert.equal(s.mock.reminders.length, 1);
  assert.equal(s.mock.reminders[0].subject, 'Invoice overdue');
  assert.equal(s.mock.reminders[0].note, 'Please pay invoice 7');
  assert.deepEqual(s.types(), ['proposed', 'confirmed', 'executed']);
  assert.equal(s.journal.remindersFor(seedInvoiceId(7)).count, 2);
  assert.ok(s.journal.verify().ok);
});

test('an executed action cannot be confirmed a second time', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  await s.gate.confirm(a.id, { confirm: true, digest: a.digest });
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: a.digest }), code('NOT_PENDING'));
  assert.equal(s.mock.reminders.length, 1);
});

test('two confirmations racing each other send one reminder', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  const proof = { confirm: true, digest: a.digest };
  const results = await Promise.allSettled([s.gate.confirm(a.id, proof), s.gate.confirm(a.id, proof)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(s.mock.reminders.length, 1);
});

test('editing the message changes the digest; the old one no longer confirms', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  const before = a.digest;
  const revised = s.gate.revise(a.id, { note: 'A gentler text, written by the owner.' });
  assert.notEqual(revised.digest, before);
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: before }), code('DIGEST_MISMATCH'));
  await s.gate.confirm(a.id, { confirm: true, digest: revised.digest });
  assert.equal(s.mock.reminders[0].note, 'A gentler text, written by the owner.');
  assert.equal(s.mock.reminders[0].subject, 'Invoice overdue');
  assert.deepEqual(s.types(), ['proposed', 'revised', 'confirmed', 'executed']);
});

test('a discarded action can no longer be confirmed', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  s.gate.discard(a.id);
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: a.digest }), code('NOT_PENDING'));
  assert.deepEqual(s.gate.pending(), []);
  assert.equal(s.mock.writes().length, 0);
});

test('a proposal expires', async (t) => {
  const s = await setup(t, 60_000);
  const a = await s.gate.prepare(remind());
  s.advance(61_000);
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: a.digest }), code('EXPIRED'));
  assert.equal(a.state, 'expired');
  assert.equal(s.mock.writes().length, 0);
  assert.deepEqual(s.types(), ['proposed', 'expired']);
});

test('if the invoice changed at PayPal since the proposal, nothing is sent', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  s.mock.invoices.get(seedInvoiceId(7))!.status = 'MARKED_AS_PAID'; // the customer paid in the meantime
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: a.digest }), code('STALE'));
  assert.equal(s.mock.reminders.length, 0);
  assert.deepEqual(s.types(), ['proposed', 'stale']);
});

test('actions that do not fit the invoice status are refused when prepared', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.gate.prepare(remind(13)), code('INVALID')); // a draft cannot be reminded
  await assert.rejects(s.gate.prepare(remind(1)), code('INVALID')); // nor a paid invoice
  await assert.rejects(s.gate.prepare({ kind: 'SEND', invoiceId: seedInvoiceId(7), origin: 'user', payload: { subject: 's', note: 'n' } }), code('INVALID'));
  await assert.rejects(s.gate.prepare({ kind: 'REMIND', origin: 'user', payload: { subject: 's', note: 'n' } }), code('INVALID'));
  assert.deepEqual(s.types(), []);
});

test('payloads are validated: empty messages, bad dates and oversized payments are refused', async (t) => {
  const s = await setup(t);
  assert.throws(() => validatePayload('REMIND', { subject: 'x', note: '   ' }), code('INVALID'));
  assert.throws(() => validatePayload('RECORD_PAYMENT', { method: 'BITCOIN', paymentDate: '2026-10-11', amount: { currency_code: 'EUR', value: '1.00' } }), code('INVALID'));
  assert.throws(() => validatePayload('UPDATE_DRAFT', { dueDate: '11/10/2026' }), code('INVALID'));
  assert.throws(() => validatePayload('UPDATE_DRAFT', {}), code('INVALID'));
  assert.deepEqual(validatePayload('REMIND', { subject: ' s ', note: 'n', extra: 'dropped' }), { subject: 's', note: 'n' });
  const pay = (value: string, currency = 'EUR') => s.gate.prepare({
    kind: 'RECORD_PAYMENT', invoiceId: seedInvoiceId(9), origin: 'user',
    payload: { method: 'CASH', paymentDate: '2026-10-11', amount: { currency_code: currency, value } },
  });
  await assert.rejects(pay('380.01'), code('INVALID'));
  await assert.rejects(pay('100.00', 'USD'), code('INVALID'));
  assert.equal((await pay('380.00')).state, 'pending');
});

test('a newer proposal for the same invoice replaces the older one', async (t) => {
  const s = await setup(t);
  const first = await s.gate.prepare(remind());
  const second = await s.gate.prepare(remind());
  assert.equal(first.state, 'discarded');
  assert.deepEqual(s.gate.pending().map((a) => a.id), [second.id]);
  await assert.rejects(s.gate.confirm(first.id, { confirm: true, digest: first.digest }), code('NOT_PENDING'));
});

test('a payment plan enables part payments, then sends the reminder, in that order', async (t) => {
  const s = await setup(t);
  const id = seedInvoiceId(6);
  const a = await s.gate.prepare({
    kind: 'OFFER_PLAN', invoiceId: id, origin: 'agent',
    payload: { subject: 'A plan', note: '3 payments of EUR 666.67', minimumAmount: { currency_code: 'EUR', value: '666.67' } },
  });
  await s.gate.confirm(a.id, { confirm: true, digest: a.digest });
  const inv = s.mock.invoices.get(id)!;
  assert.deepEqual(inv.configuration?.partial_payment, { allow_partial_payment: true, minimum_amount_due: { currency_code: 'EUR', value: '666.67' } });
  assert.equal(inv.status, 'PARTIALLY_PAID');
  assert.equal(inv.due_amount?.value, '2000.00');
  assert.deepEqual(s.mock.writes().map((r) => r.method), ['PUT', 'POST']);
  assert.equal(s.mock.reminders.length, 1);
});

test('a PayPal failure is journaled with its debug id, and the write is not retried', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  s.mock.failNext(500, 1, 'POST');
  await assert.rejects(s.gate.confirm(a.id, { confirm: true, digest: a.digest }), code('PAYPAL_FAILED'));
  assert.equal(a.state, 'failed');
  assert.equal(s.mock.writes().length, 1);
  const last = s.journal.all().at(-1)!;
  assert.equal(last.type, 'failed');
  assert.equal(last.detail?.status, 500);
  assert.match(String(last.detail?.debugId), /^[0-9a-f]{14}$/);
  assert.equal(s.journal.remindersFor(seedInvoiceId(7)).count, 1); // the failed one does not count
});

test('create a draft, then send it: two confirmations, two journal trails', async (t) => {
  const s = await setup(t);
  const draft = s.ledger.draftFromForm({ customer: 'New Client', email: 'new@client.example', description: 'Logo', amount: '750', currency: 'eur', dueInDays: '14' });
  const create = await s.gate.prepare({ kind: 'CREATE_DRAFT', origin: 'user', payload: { draft } });
  assert.equal(s.mock.invoices.size, 13);
  const created = await s.gate.confirm(create.id, { confirm: true, digest: create.digest });
  assert.equal(created.result?.invoiceNumber, 'INV-0014');
  const id = String(created.result?.invoiceId);
  assert.equal(s.mock.invoices.get(id)?.status, 'DRAFT');
  assert.equal(s.mock.invoices.get(id)?.amount?.value, '750.00');
  assert.equal(s.mock.invoices.get(id)?.detail.payment_term?.due_date, '2026-10-25');
  const send = await s.gate.prepare({ kind: 'SEND', invoiceId: id, origin: 'user', payload: await s.ledger.defaultPayload('SEND', id) });
  await s.gate.confirm(send.id, { confirm: true, digest: send.digest });
  assert.equal(s.mock.invoices.get(id)?.status, 'SENT');
  assert.deepEqual(s.types(), ['proposed', 'confirmed', 'executed', 'proposed', 'confirmed', 'executed']);
});

test('record a payment, update a draft, delete a draft, cancel an invoice', async (t) => {
  const s = await setup(t);
  const go = async (input: Parameters<typeof s.gate.prepare>[0]) => {
    const a = await s.gate.prepare(input);
    return s.gate.confirm(a.id, { confirm: true, digest: a.digest });
  };
  const paid = await go({ kind: 'RECORD_PAYMENT', invoiceId: seedInvoiceId(9), origin: 'user', payload: { method: 'BANK_TRANSFER', paymentDate: '2026-10-10', amount: { currency_code: 'EUR', value: '380.00' } } });
  assert.match(String(paid.result?.paymentId), /^EXTR-/);
  assert.equal(s.mock.invoices.get(seedInvoiceId(9))?.status, 'MARKED_AS_PAID');

  await go({ kind: 'UPDATE_DRAFT', invoiceId: seedInvoiceId(13), origin: 'user', payload: { dueDate: '2026-12-01', reference: 'PO-9' } });
  const draft = s.mock.invoices.get(seedInvoiceId(13))!;
  assert.equal(draft.detail.payment_term?.due_date, '2026-12-01');
  assert.equal(draft.detail.reference, 'PO-9');
  assert.equal(draft.items?.length, 1);

  await go({ kind: 'DELETE_DRAFT', invoiceId: seedInvoiceId(13), origin: 'user', payload: {} });
  assert.equal(s.mock.invoices.has(seedInvoiceId(13)), false);

  await go({ kind: 'CANCEL', invoiceId: seedInvoiceId(5), origin: 'agent', payload: { subject: 'Cancelled', note: 'No payment expected.' } });
  assert.equal(s.mock.invoices.get(seedInvoiceId(5))?.status, 'CANCELLED');
});

test('an unknown action id is NOT_FOUND', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.gate.confirm('00000000-0000-0000-0000-000000000000', { confirm: true, digest: 'x' }), code('NOT_FOUND'));
  assert.throws(() => s.gate.discard('nope'), code('NOT_FOUND'));
});

test('only the gate can mint confirmations: no other source file imports mintConfirmation', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && /\bmintConfirmation\b/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'web'));
  assert.deepEqual(offenders.sort(), ['src/confirmation.ts', 'src/gate.ts']);
});

// ---------------------------------------------------------------- the journal

test('journal entries are numbered and chained by hash', () => {
  const j = new Journal({ now: () => new Date('2026-10-11T09:00:00Z') });
  const a = j.append({ type: 'proposed', kind: 'REMIND', invoiceId: 'A' });
  const b = j.append({ type: 'executed', kind: 'REMIND', invoiceId: 'A' });
  assert.equal(a.seq, 1);
  assert.equal(a.prev, '0'.repeat(64));
  assert.equal(b.prev, a.hash);
  assert.match(b.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(j.verify(), { ok: true, entries: 2, brokenAt: null });
});

test('editing or removing a journal entry breaks the chain at that entry', () => {
  const j = new Journal();
  for (let i = 0; i < 4; i += 1) j.append({ type: 'executed', kind: 'REMIND', invoiceId: 'A', detail: { i } });
  const edited = structuredClone(j.all());
  edited[1].detail = { i: 99 };
  assert.deepEqual(verifyChain(edited), { ok: false, entries: 4, brokenAt: 2 });
  const removed = j.all().filter((e) => e.seq !== 3);
  assert.equal(verifyChain(removed).brokenAt, 3);
});

test('the journal persists to a file and continues its chain after a restart', (t) => {
  const file = path.join(ROOT, 'data', `test-journal-${process.pid}.jsonl`);
  fs.rmSync(file, { force: true });
  t.after(() => fs.rmSync(file, { force: true }));
  const first = new Journal({ path: file });
  first.append({ type: 'proposed', kind: 'REMIND', invoiceId: 'A' });
  first.append({ type: 'executed', kind: 'REMIND', invoiceId: 'A' });
  const second = new Journal({ path: file });
  assert.equal(second.all().length, 2);
  const third = second.append({ type: 'executed', kind: 'OFFER_PLAN', invoiceId: 'A' });
  assert.equal(third.seq, 3);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
  assert.ok(new Journal({ path: file }).verify().ok);
});

test('remindersFor counts reminders that were actually sent, for one invoice', () => {
  const j = new Journal();
  j.append({ type: 'proposed', kind: 'REMIND', invoiceId: 'A' });
  j.append({ type: 'executed', kind: 'REMIND', invoiceId: 'A' }, '2026-09-01T10:00:00.000Z');
  j.append({ type: 'failed', kind: 'REMIND', invoiceId: 'A' });
  j.append({ type: 'executed', kind: 'OFFER_PLAN', invoiceId: 'A' }, '2026-09-20T10:00:00.000Z');
  j.append({ type: 'executed', kind: 'RECORD_PAYMENT', invoiceId: 'A' });
  j.append({ type: 'executed', kind: 'REMIND', invoiceId: 'B' });
  assert.deepEqual(j.remindersFor('A'), { count: 2, lastAt: '2026-09-20T10:00:00.000Z' });
  assert.deepEqual(j.remindersFor('C'), { count: 0, lastAt: null });
});

test('canonical JSON does not depend on key order', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), canonical({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

test('no credential or token ever lands in the journal', async (t) => {
  const s = await setup(t);
  const a = await s.gate.prepare(remind());
  await s.gate.confirm(a.id, { confirm: true, digest: a.digest });
  s.mock.failNext(500, 1, 'POST');
  const b = await s.gate.prepare(remind(9));
  await assert.rejects(s.gate.confirm(b.id, { confirm: true, digest: b.digest }));
  const text = JSON.stringify(s.journal.all());
  assert.ok(!text.includes(s.mock.clientSecret));
  assert.doesNotMatch(text, /Bearer|A21AA|access_token/);
});
