import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  checkDraftFacts, draftMessage, HttpModel, modelFromEnv, parseModelProposal, proposeWithGuard, StubModel,
  type CollectionsModel, type ModelProposal, type ProposalInput,
} from '../src/agent/model.js';
import {
  allowedActions, assess, customerHistory, extractFeatures, levelOf, overduePoints, planFor, recommend, scoreRisk,
  TONES, type ReminderHistory, type RiskFeatures,
} from '../src/agent/risk.js';
import { startDemo } from '../src/demo.js';
import { seedInvoices } from '../src/mock/server.js';
import { addDays, daysBetween, formatMoney, fromCents, isOpen, toCents } from '../src/paypal/types.js';

const NOW = new Date('2026-10-11T09:00:00Z');
const TODAY = '2026-10-11';
const all = seedInvoices(NOW);
const seed = (n: number) => all[n - 1];
const none: ReminderHistory = { count: 0, lastAt: null };

const features = (over: Partial<RiskFeatures> = {}): RiskFeatures => ({
  currency: 'EUR', totalCents: 100_000, dueCents: 100_000, paidCents: 0, daysOverdue: 20, partialPaid: false,
  remindersSent: 0, daysSinceLastReminder: null, viewedByRecipient: true,
  customer: { paidCount: 1, lateCount: 0, avgDaysLate: 0 }, ...over,
});

// ---------------------------------------------------------------- money and dates

test('toCents and fromCents round-trip decimal strings exactly', () => {
  assert.equal(toCents('2450.00'), 245000);
  assert.equal(toCents('12.5'), 1250);
  assert.equal(toCents('0.07'), 7);
  assert.equal(toCents(undefined), 0);
  assert.equal(fromCents(245000), '2450.00');
  assert.equal(fromCents(7), '0.07');
  assert.throws(() => toCents('12,50'));
});

test('formatMoney puts the currency code first and groups thousands', () => {
  assert.equal(formatMoney(245000, 'EUR'), 'EUR 2,450.00');
  assert.equal(formatMoney(6000, 'USD'), 'USD 60.00');
});

test('daysBetween and addDays work on calendar days', () => {
  assert.equal(daysBetween('2026-09-03', TODAY), 38);
  assert.equal(daysBetween(TODAY, '2026-10-21'), 10);
  assert.equal(daysBetween('2026-09-21T10:00:00.000Z', TODAY), 20);
  assert.equal(addDays(TODAY, -38), '2026-09-03');
});

// ---------------------------------------------------------------- risk rules

test('overdue points never decrease as an invoice ages', () => {
  let last = -1;
  for (let d = -10; d <= 200; d += 1) {
    const p = overduePoints(d);
    assert.ok(p >= last);
    last = p;
  }
  assert.equal(overduePoints(0), 0);
  assert.equal(overduePoints(91), 85);
});

test('risk levels change at 25, 50 and 75', () => {
  assert.deepEqual([0, 24, 25, 49, 50, 74, 75, 100].map(levelOf), ['low', 'low', 'medium', 'medium', 'high', 'high', 'critical', 'critical']);
});

test('an invoice that is not due yet scores low and says when it is due', () => {
  const r = assess(seed(12), all, none, TODAY);
  assert.equal(r.score, 0);
  assert.equal(r.level, 'low');
  assert.match(r.reasons[0], /Not due yet \(due in 10 days\)/);
});

test('customer history counts paid invoices and how late they were', () => {
  assert.deepEqual(customerHistory(all, 'accounts@northwind-studio.example', seed(7).id), { paidCount: 2, lateCount: 2, avgDaysLate: 22 });
  assert.deepEqual(customerHistory(all, 'camille@atelier-moreau.example', seed(12).id), { paidCount: 2, lateCount: 0, avgDaysLate: 0 });
  assert.equal(customerHistory(all, 'ines@brightside-bakery.example', seed(9).id).paidCount, 0);
});

test('a habitual late payer scores higher, with the reason spelled out', () => {
  const r = assess(seed(7), all, { count: 1, lastAt: '2026-09-21T10:00:00Z' }, TODAY);
  assert.equal(r.score, 70);
  assert.equal(r.level, 'high');
  assert.ok(r.reasons.includes('38 days past due'));
  assert.ok(r.reasons.some((x) => /paid late on 2 of 2 earlier invoices/.test(x)));
  assert.equal(r.exposureCents, 171500);
});

test('a customer who always paid on time scores lower', () => {
  const good = scoreRisk(features({ customer: { paidCount: 3, lateCount: 0, avgDaysLate: 0 } }));
  const unknown = scoreRisk(features({ customer: { paidCount: 0, lateCount: 0, avgDaysLate: 0 } }));
  assert.equal(good.score, 20);
  assert.equal(unknown.score, 40);
  assert.ok(unknown.reasons.includes('No payment history with this customer'));
});

test('a part payment lowers the score and is quoted in the reasons', () => {
  const r = assess(seed(6), all, none, TODAY);
  assert.equal(r.features.partialPaid, true);
  assert.equal(r.score, 50);
  assert.ok(r.reasons.includes('Part payment received (EUR 1,000.00 of EUR 3,000.00)'));
});

test('an overdue invoice the recipient never opened is flagged as a delivery problem', () => {
  const r = assess(seed(9), all, none, TODAY);
  assert.equal(r.score, 45);
  assert.ok(r.reasons.some((x) => /has not opened the invoice/.test(x)));
});

test('ignored reminders add at most 15 points and the score stays within 0..100', () => {
  assert.equal(scoreRisk(features({ remindersSent: 2 })).score - scoreRisk(features()).score, 10);
  assert.equal(scoreRisk(features({ remindersSent: 9 })).score - scoreRisk(features()).score, 15);
  const worst = assess(seed(5), all, { count: 3, lastAt: '2026-09-06T10:00:00Z' }, TODAY);
  assert.equal(worst.score, 100);
  assert.equal(worst.level, 'critical');
});

test('extractFeatures falls back to total minus payments when due_amount is missing', () => {
  const inv = structuredClone(seed(6));
  delete inv.due_amount;
  assert.equal(extractFeatures(inv, all, none, TODAY).dueCents, 200_000);
});

test('allowed actions depend on status, amount and age', () => {
  const f = (n: number) => extractFeatures(seed(n), all, none, TODAY);
  assert.deepEqual(allowedActions(seed(1), f(1)), []);
  assert.deepEqual(allowedActions(seed(13), f(13)), []);
  assert.deepEqual(allowedActions(seed(12), f(12)), ['WAIT', 'REMIND']);
  assert.deepEqual(allowedActions(seed(7), f(7)), ['WAIT', 'REMIND', 'OFFER_PLAN']);
  assert.deepEqual(allowedActions(seed(5), f(5)), ['WAIT', 'REMIND', 'WRITE_OFF']);
});

test('the rules recommend wait, remind, a plan or a write-off for the right reasons', () => {
  const rec = (f: RiskFeatures, allowed = ['WAIT', 'REMIND', 'OFFER_PLAN', 'WRITE_OFF'] as const) => recommend(f, scoreRisk(f), [...allowed]);
  assert.equal(rec(features({ daysOverdue: -3 })).action, 'WAIT');
  assert.equal(rec(features({ daysOverdue: 20, remindersSent: 1, daysSinceLastReminder: 2 })).action, 'WAIT');
  assert.equal(rec(features({ daysOverdue: 20 })).action, 'REMIND');
  assert.equal(rec(features({ daysOverdue: 40, partialPaid: true, paidCents: 30_000, dueCents: 70_000 })).action, 'OFFER_PLAN');
  assert.equal(rec(features({ daysOverdue: 50, remindersSent: 2, daysSinceLastReminder: 10 })).action, 'OFFER_PLAN');
  assert.equal(rec(features({ daysOverdue: 130, remindersSent: 3, daysSinceLastReminder: 30, dueCents: 6_000 })).action, 'WRITE_OFF');
  assert.equal(rec(features({ daysOverdue: 130, remindersSent: 3, daysSinceLastReminder: 30, dueCents: 600_000 })).action, 'OFFER_PLAN');
  assert.equal(rec(features(), [] as never).action, 'WAIT');
});

test('a payment plan splits the balance in two or three and never loses a cent', () => {
  assert.deepEqual(planFor(60_000), { installments: 2, amountCents: 30_000 });
  assert.deepEqual(planFor(200_000), { installments: 3, amountCents: 66_667 });
  assert.ok(planFor(200_000).amountCents * 3 >= 200_000);
});

// ---------------------------------------------------------------- model: stub, validation, guard

async function inputs(t: TestContext): Promise<(n: number, tone?: 'auto' | 'friendly' | 'neutral' | 'firm') => ProposalInput> {
  const demo = await startDemo({ now: () => NOW });
  t.after(() => demo.close());
  const invoices = await demo.ledger.invoices();
  return (n, tone = 'auto') => demo.ledger.buildInput(invoices.find((i) => i.detail.invoice_number === `INV-${String(n).padStart(4, '0')}`)!, invoices, tone);
}

const answer = (input: ProposalInput, over: Partial<ModelProposal> = {}): ModelProposal => ({
  action: 'REMIND', reason: 'Late and already reminded once.', subject: `About invoice ${input.invoice.number}`,
  note: `Hello, ${input.invoice.due} is still open on invoice ${input.invoice.number}.`, ...over,
});

test('the stub model is deterministic and follows the rules', async (t) => {
  const input = (await inputs(t))(7);
  const a = await new StubModel().propose(input);
  const b = await new StubModel().propose(input);
  assert.deepEqual(a, b);
  assert.equal(a.action, 'REMIND');
  assert.match(a.reason, /^High risk \(70\/100\): 38 days past due/);
  assert.match(a.note, /EUR 2,450\.00/);
});

test('the tone changes the wording, not the facts', async (t) => {
  const make = await inputs(t);
  const subjects = TONES.map((tone) => draftMessage('REMIND', make(7, tone)).subject);
  assert.equal(new Set(subjects).size, 3);
  assert.match(subjects[0], /^Friendly reminder/);
  assert.match(subjects[2], /^Final reminder/);
  for (const tone of TONES) assert.match(draftMessage('REMIND', make(7, tone)).note, /EUR 2,450\.00/);
});

test('every rule-based draft passes its own fact check, for every open invoice, action and tone', async (t) => {
  const make = await inputs(t);
  let checked = 0;
  for (let n = 1; n <= 13; n += 1) {
    if (!isOpen(seed(n).status)) continue;
    for (const tone of TONES) {
      const input = make(n, tone);
      for (const action of input.allowed) {
        const m = draftMessage(action, input);
        const f = input.features;
        assert.deepEqual(checkDraftFacts(`${m.subject}\n${m.note}`, [f.dueCents, f.totalCents, f.paidCents, input.plan?.amountCents ?? -1]), []);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 40);
});

test('the plan message states the instalments the gate will enable', async (t) => {
  const input = (await inputs(t))(6);
  assert.deepEqual(input.plan, { installments: 3, amountCents: 66_667, amount: 'EUR 666.67' });
  const p = await new StubModel().propose(input);
  assert.equal(p.action, 'OFFER_PLAN');
  assert.match(p.note, /3 payments of EUR 666\.67/);
  assert.match(p.note, /EUR 1,000\.00 already received/);
});

test('parseModelProposal accepts JSON wrapped in prose or a code fence', async (t) => {
  const input = (await inputs(t))(7);
  const text = 'Here is my proposal:\n```json\n' + JSON.stringify(answer(input, { action: 'remind' as never })) + '\n```';
  assert.equal(parseModelProposal(text, input).action, 'REMIND');
});

test('parseModelProposal rejects an action the rules do not allow, and malformed answers', async (t) => {
  const input = (await inputs(t))(7);
  assert.throws(() => parseModelProposal(JSON.stringify(answer(input, { action: 'WRITE_OFF' })), input), /not allowed/);
  assert.throws(() => parseModelProposal(JSON.stringify(answer(input, { action: 'SUE' as never })), input), /not allowed/);
  assert.throws(() => parseModelProposal(JSON.stringify(answer(input, { note: '' })), input), /note is missing/);
  assert.throws(() => parseModelProposal('I would remind them.', input), /no JSON object/);
  assert.throws(() => parseModelProposal('{"action": "REMIND",', input), /no JSON object|not valid JSON/);
});

test('checkDraftFacts flags amounts that are not on the invoice, in any common notation', () => {
  const allowed = [245000];
  assert.deepEqual(checkDraftFacts('You owe EUR 2,450.00, due 2026-09-03, within 7 days.', allowed), []);
  assert.deepEqual(checkDraftFacts('You owe €2,450.00 or 2450.00 EUR or 2.450,00 €.', allowed), []);
  assert.deepEqual(checkDraftFacts('You owe EUR 2,450.00 plus a late fee of EUR 40.00.', allowed), ['EUR 40.00']);
  assert.deepEqual(checkDraftFacts('Pay $2,500 now.', allowed), ['$2,500']);
});

test('guard: a model that invents an amount is replaced by the rule-based draft, with a warning', async (t) => {
  const input = (await inputs(t))(7);
  const liar: CollectionsModel = { name: 'liar', propose: async () => answer(input, { note: 'You owe EUR 2,450.00 plus EUR 150.00 in interest.' }) };
  const g = await proposeWithGuard(liar, input);
  assert.equal(g.source, 'rules-fallback');
  assert.match(g.warnings[0], /EUR 150\.00/);
  assert.doesNotMatch(g.proposal.note, /interest/);
});

test('guard: a model that fails or answers out of bounds falls back, and the reviewer is told', async (t) => {
  const input = (await inputs(t))(7);
  const down: CollectionsModel = { name: 'down', propose: async () => { throw new Error('timeout'); } };
  const rogue: CollectionsModel = { name: 'rogue', propose: async () => answer(input, { action: 'WRITE_OFF' }) };
  for (const model of [down, rogue]) {
    const g = await proposeWithGuard(model, input);
    assert.equal(g.source, 'rules-fallback');
    assert.equal(g.proposal.action, 'REMIND');
    assert.equal(g.warnings.length, 1);
  }
});

test('guard: a valid model answer is kept, even when it disagrees with the rules', async (t) => {
  const input = (await inputs(t))(7);
  const model: CollectionsModel = { name: 'careful', propose: async () => answer(input, { action: 'WAIT', reason: 'They wrote yesterday.' }) };
  const g = await proposeWithGuard(model, input);
  assert.equal(g.source, 'careful');
  assert.deepEqual(g.warnings, []);
  assert.deepEqual(g.proposal, { action: 'WAIT', reason: 'They wrote yesterday.', subject: '', note: '' });
});

test('HttpModel speaks the OpenAI-compatible chat format (fake endpoint, no network)', async (t) => {
  const input = (await inputs(t))(7);
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: unknown, init?: RequestInit) => {
    seen = { url: String(url), init: init! };
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer(input)) } }] });
  }) as typeof fetch;
  const model = new HttpModel({ provider: 'openai', baseUrl: 'https://llm.example.test/v1/', model: 'some-model', apiKey: 'not-a-real-key', fetchImpl: fake });
  const p = await model.propose(input);
  assert.equal(p.action, 'REMIND');
  assert.equal(seen!.url, 'https://llm.example.test/v1/chat/completions');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer not-a-real-key');
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(body.model, 'some-model');
  assert.deepEqual(body.messages.map((m: any) => m.role), ['system', 'user']);
  assert.equal(JSON.parse(body.messages[1].content).invoice.number, 'INV-0007');
});

test('HttpModel speaks the Anthropic Messages format (fake endpoint, no network)', async (t) => {
  const input = (await inputs(t))(7);
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: unknown, init?: RequestInit) => {
    seen = { url: String(url), init: init! };
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(answer(input)) }] });
  }) as typeof fetch;
  const model = new HttpModel({ provider: 'anthropic', model: 'some-model', apiKey: 'not-a-real-key', fetchImpl: fake });
  assert.equal((await model.propose(input)).subject, 'About invoice INV-0007');
  assert.equal(seen!.url, 'https://api.anthropic.com/v1/messages');
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'not-a-real-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(String(seen!.init.body));
  assert.equal(typeof body.system, 'string');
  assert.equal(body.messages[0].role, 'user');
  assert.ok(body.max_tokens > 0);
});

test('an HTTP error from the model endpoint never carries the key or the response body', async (t) => {
  const input = (await inputs(t))(7);
  const fake = (async () => new Response('bad key not-a-real-key', { status: 401 })) as unknown as typeof fetch;
  const model = new HttpModel({ provider: 'openai', model: 'm', apiKey: 'not-a-real-key', fetchImpl: fake });
  const g = await proposeWithGuard(model, input);
  assert.equal(g.source, 'rules-fallback');
  assert.match(g.warnings[0], /HTTP 401/);
  assert.doesNotMatch(g.warnings[0], /not-a-real-key/);
});

test('modelFromEnv defaults to the stub and refuses an incomplete configuration', () => {
  assert.ok(modelFromEnv({}) instanceof StubModel);
  assert.throws(() => modelFromEnv({ MODEL_PROVIDER: 'magic' }), /MODEL_PROVIDER/);
  assert.throws(() => modelFromEnv({ MODEL_PROVIDER: 'openai', MODEL_NAME: 'm' }), /MODEL_API_KEY/);
  assert.throws(() => modelFromEnv({ MODEL_PROVIDER: 'anthropic', MODEL_API_KEY: 'k' }), /MODEL_NAME/);
  assert.equal(modelFromEnv({ MODEL_PROVIDER: 'anthropic', MODEL_NAME: 'm', MODEL_API_KEY: 'k' }).name, 'anthropic:m');
});
