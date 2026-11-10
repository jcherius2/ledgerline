// One end-to-end pass through the real page in Chromium, against the local PayPal mock:
// the grid renders the invoices, the agent's proposal waits in the queue, and a confirmed
// reminder changes the ledger and the journal. Run with `npm run check:ui`.
//
// Playwright is not a dependency of this project. The script uses whichever copy it finds:
// one installed here, the path in PLAYWRIGHT_MODULE, or /opt/npm-tools. CHROMIUM_PATH overrides
// the browser binary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemo } from '../dist/src/demo.js';

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(import.meta.url), '../..');

function loadPlaywright() {
  for (const name of ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/npm-tools/node_modules/playwright'].filter(Boolean)) {
    try { return require(name); } catch { /* try the next one */ }
  }
  throw new Error('Playwright was not found. Install it (npm i -D playwright) or set PLAYWRIGHT_MODULE.');
}

const { chromium } = loadPlaywright();
const executablePath = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
const demo = await startDemo();
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const problems = [];
let failed = false;

try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 0.5 });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(demo.url);

  const row = (n) => `[row-id="INV2-DEMO-${String(n).padStart(4, '0')}-AAAA-BBBB"]`;
  const cell = (n, col) => page.locator(`.ag-center-cols-container ${row(n)} [col-id="${col}"]`);

  // 1. The grid shows the thirteen invoices and one pinned total row per currency.
  await page.waitForFunction(() => document.querySelectorAll('.ag-center-cols-container [role="row"]').length >= 13);
  const rows = await page.locator('.ag-center-cols-container [role="row"]').count();
  const totals = await page.locator('.ag-floating-bottom .ag-pinned-left-floating-bottom [role="row"]').count();
  assert.equal(rows, 13, 'thirteen invoice rows');
  assert.equal(totals, 2, 'one total row per currency (EUR, USD)');
  assert.match(await cell(7, 'riskScore').innerText(), /70\s*high/);
  assert.match(await cell(7, 'nextStep').innerText(), /Remind/i);
  const firstRow = await page.locator('.ag-center-cols-container [role="row"][row-index="0"] [col-id="riskScore"]').innerText();
  assert.match(firstRow, /100\s*critical/, 'sorted by risk, highest first');

  // 2. Ask the agent about INV-0007: a proposal appears in the queue; PayPal has received nothing.
  await cell(7, 'customer').click();
  await page.click('[data-test="detail-ask"]');
  await page.waitForSelector('#queue .card[data-kind="REMIND"]');
  assert.equal(demo.mock.writes().length, 0, 'nothing sent before confirmation');
  assert.match(await cell(7, 'nextStep').innerText(), /to confirm/i);

  // 3. Confirm it: the reminder reaches the mock, the row and the journal change.
  await page.click('#queue .card[data-kind="REMIND"] .confirm');
  await page.waitForFunction(() => document.querySelector('#journal li .type')?.textContent === 'executed');
  await page.waitForFunction((sel) => /Wait/i.test(document.querySelector(sel)?.textContent ?? ''), `.ag-center-cols-container ${row(7)} [col-id="nextStep"]`);
  assert.equal(demo.mock.reminders.length, 1, 'one reminder at PayPal');
  assert.match(await cell(7, 'riskScore').innerText(), /75\s*critical/);
  assert.equal(await page.locator('#queue .card').count(), 0);
  assert.ok(demo.journal.verify().ok);

  // 4. Leave a second proposal (a payment plan) waiting, and take the picture.
  await cell(6, 'customer').click();
  await page.click('[data-test="detail-ask"]');
  await page.waitForSelector('#queue .card[data-kind="OFFER_PLAN"]');
  await page.waitForTimeout(600);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'docs', 'screenshot.png') });

  assert.deepEqual(problems, [], 'no console error, no page error');
  console.log(`UI check passed: ${rows} rows, ${totals} total rows, reminder confirmed and journaled (${demo.journal.all().length} journal entries).`);
} catch (e) {
  failed = true;
  console.error(`UI check FAILED: ${e.message}`);
  for (const p of problems) console.error(`  ${p}`);
} finally {
  await browser.close();
  await demo.close();
}
process.exit(failed ? 1 : 0);
