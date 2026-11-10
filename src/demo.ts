/**
 * `npm run demo`: the whole application against the local PayPal mock, with the deterministic
 * stub in place of a language model. No account, no key, no network beyond localhost.
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StubModel, type CollectionsModel } from './agent/model.js';
import { createApp, listen } from './app.js';
import { ConfirmationGate } from './gate.js';
import { Journal } from './journal.js';
import { Ledger } from './ledger.js';
import { seedInvoiceId, startMockPayPal, type MockPayPal } from './mock/server.js';
import { PayPalClient } from './paypal/client.js';
import { addDays, isoDate } from './paypal/types.js';

export interface Demo {
  url: string;
  mock: MockPayPal;
  journal: Journal;
  gate: ConfirmationGate;
  ledger: Ledger;
  client: PayPalClient;
  server: http.Server;
  close(): Promise<void>;
}

export interface DemoOptions {
  port?: number;
  now?: () => Date;
  /** File for the journal; omitted means in memory (tests). */
  journalPath?: string;
  model?: CollectionsModel;
  ttlMs?: number;
}

/** Reminders "already sent" before the demo starts, so the risk rules have a history to read. */
const PAST_REMINDERS: [number, number[]][] = [
  [5, [-100, -70, -35]],
  [6, [-30]],
  [7, [-20]],
];

export async function startDemo(options: DemoOptions = {}): Promise<Demo> {
  const now = options.now ?? (() => new Date());
  const mock = await startMockPayPal({ now });
  const client = new PayPalClient({ baseUrl: mock.baseUrl, clientId: mock.clientId, clientSecret: mock.clientSecret, now: () => now().getTime() });
  if (options.journalPath) fs.rmSync(options.journalPath, { force: true });
  const journal = new Journal({ path: options.journalPath, now });
  const today = isoDate(now());
  const seeded = PAST_REMINDERS.flatMap(([n, offsets]) => offsets.map((offset) => ({ n, offset }))).sort((a, b) => a.offset - b.offset);
  for (const { n, offset } of seeded) {
    journal.append({
      type: 'executed', kind: 'REMIND', invoiceId: seedInvoiceId(n), invoiceNumber: `INV-${String(n).padStart(4, '0')}`,
      origin: 'demo-seed', detail: { note: 'Sample history created with the demo data; not a real reminder.' },
    }, `${addDays(today, offset)}T10:00:00.000Z`);
  }
  const gate = new ConfirmationGate({ client, journal, now, ttlMs: options.ttlMs });
  const ledger = new Ledger({ reader: client, gate, journal, model: options.model ?? new StubModel(), now });
  const server = createApp({ ledger, gate, journal, info: { paypal: mock.baseUrl, mock: true }, now });
  const url = await listen(server, options.port ?? 0);
  return {
    url, mock, journal, gate, ledger, client, server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mock.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemo({ port: Number(process.env.PORT) || 4310, journalPath: 'data/demo-journal.jsonl' });
  console.log(`Ledgerline demo: ${demo.url}`);
  console.log(`PayPal mock: ${demo.mock.baseUrl} (13 sample invoices)   agent: ${demo.ledger.modelName}`);
  console.log('Nothing leaves this machine. Ctrl+C to stop.');
}
