/**
 * `npm start`: Ledgerline against a real PayPal REST app (sandbox by default).
 * Configuration comes from the environment or a local .env file; see .env.example.
 */
import { modelFromEnv } from './agent/model.js';
import { createApp, listen } from './app.js';
import { ConfirmationGate } from './gate.js';
import { Journal } from './journal.js';
import { Ledger } from './ledger.js';
import { PayPalClient } from './paypal/client.js';

try {
  process.loadEnvFile();
} catch {
  // No .env file: the environment alone is used.
}

const env = process.env;
const baseUrl = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  fail('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required (see .env.example). For a tour without an account: npm run demo');
}
if (/\/\/api(-m)?\.paypal\.com/.test(baseUrl) && env.LEDGERLINE_ALLOW_LIVE !== 'yes') {
  fail('PAYPAL_API_BASE points at live PayPal. This build has only been exercised against a mock and is meant for the sandbox. Set LEDGERLINE_ALLOW_LIVE=yes to override.');
}

if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(baseUrl)) {
  fail('PAYPAL_API_BASE must be an https URL: the client secret is sent to it.');
}

const client = new PayPalClient({ baseUrl, clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
const journal = new Journal({ path: env.JOURNAL_PATH || 'data/journal.jsonl' });
const chain = journal.verify();
if (!chain.ok) {
  console.error(`WARNING: the journal's hash chain is broken at entry ${chain.brokenAt}: it was edited outside Ledgerline. Reminder counts read from it may be wrong.`);
}
const gate = new ConfirmationGate({ client, journal });
const ledger = new Ledger({ reader: client, gate, journal, model: modelFromEnv(env) });
const server = createApp({ ledger, gate, journal, info: { paypal: baseUrl, mock: false } });

const url = await listen(server, Number(env.PORT) || 4310);
console.log(`Ledgerline: ${url}`);
console.log(`PayPal: ${baseUrl}   agent: ${ledger.modelName}   journal: ${env.JOURNAL_PATH || 'data/journal.jsonl'}`);
