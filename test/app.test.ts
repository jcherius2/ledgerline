import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { startDemo } from '../src/demo.js';
import { seedInvoiceId } from '../src/mock/server.js';

async function setup(t: TestContext) {
  const demo = await startDemo({ now: () => new Date('2026-10-11T09:00:00Z') });
  t.after(() => demo.close());
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(demo.url + path, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
  };
  const row = async (n: number) => (await call('GET', '/api/invoices')).json.rows.find((r: any) => r.number === `INV-${String(n).padStart(4, '0')}`);
  const openIds = [5, 6, 7, 9, 11, 12].map(seedInvoiceId);
  return { demo, call, row, openIds };
}

test('GET /api/invoices returns every invoice as a ledger row, risk on the open ones only', async (t) => {
  const { call } = await setup(t);
  const res = await call('GET', '/api/invoices');
  assert.equal(res.status, 200);
  assert.equal(res.json.today, '2026-10-11');
  assert.equal(res.json.rows.length, 13);
  const scored = res.json.rows.filter((r: any) => r.riskScore !== null).map((r: any) => r.number).sort();
  assert.deepEqual(scored, ['INV-0005', 'INV-0006', 'INV-0007', 'INV-0009', 'INV-0011', 'INV-0012']);
  const paid = res.json.rows.find((r: any) => r.number === 'INV-0001');
  assert.deepEqual([paid.display, paid.due, paid.total, paid.nextStep], ['Paid', 0, 1400, null]);
});

test('the demo ledger ranks the sample invoices as the rules say', async (t) => {
  const { row } = await setup(t);
  const pick = async (n: number) => { const r = await row(n); return [r.riskScore, r.riskLevel, r.nextStep, r.display, r.reminders]; };
  assert.deepEqual(await pick(5), [100, 'critical', 'WRITE_OFF', 'Overdue', 3]);
  assert.deepEqual(await pick(6), [55, 'high', 'OFFER_PLAN', 'Overdue, part paid', 1]);
  assert.deepEqual(await pick(7), [70, 'high', 'REMIND', 'Overdue', 1]);
  assert.deepEqual(await pick(9), [45, 'medium', 'REMIND', 'Overdue', 0]);
  assert.deepEqual(await pick(11), [15, 'low', 'REMIND', 'Overdue', 0]);
  assert.deepEqual(await pick(12), [0, 'low', 'WAIT', 'Sent', 0]);
  assert.equal((await row(13)).display, 'Draft');
});

test('asking the agent prepares proposals and sends nothing to PayPal', async (t) => {
  const { demo, call, openIds, row } = await setup(t);
  const res = await call('POST', '/api/agent/propose', { invoiceIds: openIds, tone: 'auto' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.results.map((r: any) => r.action), ['WRITE_OFF', 'OFFER_PLAN', 'REMIND', 'REMIND', 'REMIND', 'WAIT']);
  assert.equal(res.json.results[5].actionId, null);
  const actions = (await call('GET', '/api/actions')).json.actions;
  assert.deepEqual(actions.map((a: any) => a.kind), ['CANCEL', 'OFFER_PLAN', 'REMIND', 'REMIND', 'REMIND']);
  assert.ok(actions.every((a: any) => a.origin === 'agent' && a.rationale && a.payload.subject && a.payload.note));
  assert.equal(demo.mock.writes().length, 0);
  assert.equal(demo.mock.reminders.length, 0);
  const r7 = await row(7);
  assert.deepEqual([r7.nextStepSource, r7.pending.length], ['agent', 1]);
});

test('the tone asked for is the tone drafted, per invoice or for the whole run', async (t) => {
  const { call } = await setup(t);
  const id7 = seedInvoiceId(7);
  const id9 = seedInvoiceId(9);
  const res = await call('POST', '/api/agent/propose', { invoiceIds: [id7, id9], tone: 'firm', tones: { [id9]: 'friendly' } });
  assert.deepEqual(res.json.results.map((r: any) => r.tone), ['firm', 'friendly']);
  const actions = (await call('GET', '/api/actions')).json.actions;
  assert.match(actions[0].payload.subject, /^Final reminder/);
  assert.match(actions[1].payload.subject, /^Friendly reminder/);
});

test('confirming over HTTP sends the reminder, updates the row and the journal', async (t) => {
  const { demo, call, row } = await setup(t);
  await call('POST', '/api/agent/propose', { invoiceIds: [seedInvoiceId(7)] });
  const [action] = (await call('GET', '/api/actions')).json.actions;
  const done = await call('POST', `/api/actions/${action.id}/confirm`, { confirm: true, digest: action.digest });
  assert.equal(done.status, 200);
  assert.equal(done.json.action.state, 'executed');
  assert.equal(demo.mock.reminders.length, 1);
  assert.equal(demo.mock.reminders[0].note, action.payload.note);
  const r = await row(7);
  assert.deepEqual([r.reminders, r.lastReminder, r.nextStep, r.nextStepSource, r.riskScore, r.pending.length], [2, '2026-10-11', 'WAIT', 'rules', 75, 0]);
  const journal = (await call('GET', '/api/journal')).json;
  assert.ok(journal.chain.ok);
  assert.deepEqual(journal.entries.slice(-3).map((e: any) => e.type), ['proposed', 'confirmed', 'executed']);
});

test('the HTTP confirm route refuses a missing or wrong digest, and a missing confirm flag', async (t) => {
  const { demo, call } = await setup(t);
  await call('POST', '/api/agent/propose', { invoiceIds: [seedInvoiceId(7)] });
  const [action] = (await call('GET', '/api/actions')).json.actions;
  const noDigest = await call('POST', `/api/actions/${action.id}/confirm`, { confirm: true });
  assert.deepEqual([noDigest.status, noDigest.json.error], [409, 'DIGEST_MISMATCH']);
  const noFlag = await call('POST', `/api/actions/${action.id}/confirm`, { digest: action.digest });
  assert.deepEqual([noFlag.status, noFlag.json.error], [400, 'NOT_CONFIRMED']);
  const empty = await call('POST', `/api/actions/${action.id}/confirm`);
  assert.equal(empty.status, 400);
  assert.equal(demo.mock.writes().length, 0);
});

test('an edited message is what gets sent', async (t) => {
  const { demo, call } = await setup(t);
  await call('POST', '/api/agent/propose', { invoiceIds: [seedInvoiceId(9)] });
  const [action] = (await call('GET', '/api/actions')).json.actions;
  const revised = await call('PATCH', `/api/actions/${action.id}`, { payload: { note: 'Ines, did the invoice reach you?' } });
  assert.equal(revised.status, 200);
  assert.notEqual(revised.json.action.digest, action.digest);
  const stale = await call('POST', `/api/actions/${action.id}/confirm`, { confirm: true, digest: action.digest });
  assert.equal(stale.status, 409);
  await call('POST', `/api/actions/${action.id}/confirm`, { confirm: true, digest: revised.json.action.digest });
  assert.equal(demo.mock.reminders[0].note, 'Ines, did the invoice reach you?');
});

test('discarding over HTTP empties the queue without touching PayPal', async (t) => {
  const { demo, call } = await setup(t);
  await call('POST', '/api/agent/propose', { invoiceIds: [seedInvoiceId(7)] });
  const [action] = (await call('GET', '/api/actions')).json.actions;
  assert.equal((await call('DELETE', `/api/actions/${action.id}`)).status, 200);
  assert.deepEqual((await call('GET', '/api/actions')).json.actions, []);
  assert.equal(demo.mock.writes().length, 0);
});

test('a new invoice goes form -> prepared draft -> confirmed -> row in the ledger', async (t) => {
  const { demo, call } = await setup(t);
  const form = { customer: 'Harbour Books', email: 'hello@harbourbooks.example', description: 'Shop sign', amount: '420.50', currency: 'EUR', dueInDays: '21' };
  const made = await call('POST', '/api/actions', { kind: 'CREATE_DRAFT', form });
  assert.equal(made.status, 201);
  assert.equal(demo.mock.invoices.size, 13);
  await call('POST', `/api/actions/${made.json.action.id}/confirm`, { confirm: true, digest: made.json.action.digest });
  const rows = (await call('GET', '/api/invoices')).json.rows;
  const row = rows.find((r: any) => r.number === 'INV-0014');
  assert.deepEqual([rows.length, row.customer, row.total, row.display, row.dueDate], [14, 'Harbour Books', 420.5, 'Draft', '2026-11-01']);
});

test('invalid requests are answered with 400 and a readable message', async (t) => {
  const { call } = await setup(t);
  const badAmount = await call('POST', '/api/actions', { kind: 'CREATE_DRAFT', form: { customer: 'X', email: 'x@y.example', description: 'd', amount: 'twelve' } });
  assert.deepEqual([badAmount.status, badAmount.json.error], [400, 'INVALID']);
  const badKind = await call('POST', '/api/actions', { kind: 'REFUND', invoiceId: seedInvoiceId(1) });
  assert.equal(badKind.status, 400);
  const noIds = await call('POST', '/api/agent/propose', { invoiceIds: [] });
  assert.equal(noIds.status, 400);
  const paid = await call('POST', '/api/actions', { kind: 'REMIND', invoiceId: seedInvoiceId(1) });
  assert.deepEqual([paid.status, paid.json.error], [400, 'INVALID']);
  const unknown = await call('POST', '/api/actions', { kind: 'REMIND', invoiceId: 'INV2-NOPE' });
  assert.deepEqual([unknown.status, unknown.json.error], [502, 'PAYPAL']);
});

test('cross-origin and non-JSON writes are refused', async (t) => {
  const { demo, call } = await setup(t);
  const body = { invoiceIds: [seedInvoiceId(7)] };
  const foreign = await call('POST', '/api/agent/propose', body, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const form = await call('POST', '/api/agent/propose', body, { 'content-type': 'text/plain' });
  assert.equal(form.status, 415);
  const same = await call('POST', '/api/agent/propose', body, { origin: demo.url });
  assert.equal(same.status, 200);
});

test('the page, its script and the AG Grid Community bundle are served locally', async (t) => {
  const { call } = await setup(t);
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /\/vendor\/ag-grid-community\.min\.js/);
  assert.doesNotMatch(page.text, /https?:\/\/(?!www\.w3\.org)/); // no CDN, no third-party request
  const grid = await call('GET', '/vendor/ag-grid-community.min.js');
  assert.equal(grid.status, 200);
  assert.match(grid.type, /javascript/);
  assert.doesNotMatch(grid.text.slice(0, 400), /enterprise/i);
  assert.equal((await call('GET', '/app.js')).status, 200);
  assert.equal((await call('GET', '/../package.json')).status, 404);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});

test('GET /api/state names the environment and exposes no credential', async (t) => {
  const { demo, call } = await setup(t);
  const res = await call('GET', '/api/state');
  assert.deepEqual(res.json, { paypal: demo.mock.baseUrl, mock: true, model: 'stub (deterministic rules)', today: '2026-10-11' });
  assert.ok(!res.text.includes(demo.mock.clientSecret) && !res.text.includes(demo.mock.clientId));
});
