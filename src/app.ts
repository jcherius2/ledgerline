/**
 * The local HTTP server: a small JSON API for the browser and the static files of the UI.
 * It holds the read-only side of the PayPal client and the confirmation gate, nothing else:
 * there is no route that writes to PayPal without going through `gate.confirm`.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TONES } from './agent/risk.js';
import { ACTION_KINDS, GateError, type ActionKind, type ConfirmationGate } from './gate.js';
import type { Journal } from './journal.js';
import type { Ledger, ToneChoice } from './ledger.js';
import { PayPalApiError } from './paypal/client.js';
import { localDate } from './paypal/types.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'web/index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'web/styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'web/dist/app.js', type: 'text/javascript; charset=utf-8' },
  '/vendor/ag-grid-community.min.js': {
    file: 'node_modules/ag-grid-community/dist/ag-grid-community.min.js', type: 'text/javascript; charset=utf-8',
  },
};

// AG Grid injects its theme as <style> elements and uses data: URIs for icons.
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'";

// The server binds to loopback, but a hostile web page can still point a DNS name at 127.0.0.1
// (DNS rebinding) and would then be "same origin". Only requests addressed to loopback by name
// are answered at all.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

export interface AppDeps {
  ledger: Ledger;
  gate: ConfirmationGate;
  journal: Journal;
  info: { paypal: string; mock: boolean };
  now?: () => Date;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new GateError('INVALID', 'Request body too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new GateError('INVALID', 'Request body must be a JSON object.'));
      }
    });
  });
}

const asTone = (v: unknown): ToneChoice => (TONES.includes(v as never) ? (v as ToneChoice) : 'auto');

export function createApp(deps: AppDeps): http.Server {
  const { ledger, gate, journal } = deps;
  const now = deps.now ?? (() => new Date());

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) {
      return send(res, 403, { error: 'FORBIDDEN', message: 'This server only answers on its loopback address.' });
    }

    const file = STATIC[p];
    if (method === 'GET' && file) {
      const full = path.join(ROOT, file.file);
      if (!fs.existsSync(full)) return send(res, 500, { error: 'NOT_BUILT', message: `${file.file} is missing; run "npm run build".` });
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(full));
      return;
    }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'NOT_FOUND', message: 'Not found.' });

    let body: Record<string, unknown> = {};
    if (method !== 'GET') {
      // The API changes state, so it only answers its own page: same origin, JSON content type.
      // An Origin that is absent (curl, same-origin GET-less clients) is accepted; one that is present
      // must be this server, so "null" (sandboxed frames) and anything unparsable are refused too.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      const foreign = origin !== undefined && !(URL.canParse(origin) && new URL(origin).host === req.headers.host);
      if (foreign || (typeof site === 'string' && site !== 'same-origin' && site !== 'none')) {
        return send(res, 403, { error: 'FORBIDDEN', message: 'Cross-origin requests are refused.' });
      }
      // The media type itself, not a substring: "text/plain; application/json" needs no CORS preflight.
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
        return send(res, 415, { error: 'UNSUPPORTED', message: 'Content-Type must be application/json.' });
      }
      body = await readJson(req);
    }

    if (method === 'GET' && p === '/api/state') {
      return send(res, 200, { ...deps.info, model: ledger.modelName, today: localDate(now()) });
    }
    if (method === 'GET' && p === '/api/invoices') {
      return send(res, 200, { today: localDate(now()), rows: await ledger.rows() });
    }
    if (method === 'POST' && p === '/api/agent/propose') {
      const ids = Array.isArray(body.invoiceIds) ? body.invoiceIds.filter((x): x is string => typeof x === 'string').slice(0, 200) : [];
      if (!ids.length) throw new GateError('INVALID', 'invoiceIds must list at least one invoice.');
      const tones: Record<string, ToneChoice> = {};
      for (const [k, v] of Object.entries((body.tones ?? {}) as Record<string, unknown>)) tones[k] = asTone(v);
      return send(res, 200, { results: await ledger.propose(ids, asTone(body.tone), tones) });
    }
    if (method === 'GET' && p === '/api/actions') {
      return send(res, 200, { actions: gate.pending() });
    }
    if (method === 'POST' && p === '/api/actions') {
      const kind = body.kind as ActionKind;
      if (!ACTION_KINDS.includes(kind)) throw new GateError('INVALID', 'Unknown action kind.');
      const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : null;
      let payload = (body.payload && typeof body.payload === 'object' ? body.payload : {}) as Record<string, unknown>;
      try {
        if (kind === 'CREATE_DRAFT' && body.form && typeof body.form === 'object') {
          payload = { draft: ledger.draftFromForm(body.form as Record<string, unknown>) };
        } else if (invoiceId && (kind === 'SEND' || kind === 'CANCEL' || kind === 'REMIND')) {
          payload = { ...(await ledger.defaultPayload(kind, invoiceId)), ...payload };
        }
      } catch (e) {
        if (e instanceof PayPalApiError || e instanceof GateError) throw e;
        throw new GateError('INVALID', e instanceof Error ? e.message : 'Invalid form.');
      }
      return send(res, 201, { action: await gate.prepare({ kind, invoiceId, payload, origin: 'user' }) });
    }
    const m = /^\/api\/actions\/([0-9a-f-]{36})(\/confirm)?$/.exec(p);
    if (m) {
      const [, id, confirm] = m;
      if (method === 'POST' && confirm) {
        return send(res, 200, { action: await gate.confirm(id, { confirm: body.confirm, digest: body.digest }) });
      }
      if (method === 'PATCH' && !confirm) {
        return send(res, 200, { action: gate.revise(id, (body.payload ?? {}) as Record<string, unknown>) });
      }
      if (method === 'DELETE' && !confirm) {
        return send(res, 200, { action: gate.discard(id) });
      }
    }
    if (method === 'GET' && p === '/api/journal') {
      return send(res, 200, { chain: journal.verify(), head: journal.head(), entries: journal.all().slice(-300) });
    }
    return send(res, 404, { error: 'NOT_FOUND', message: 'No such API route.' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof GateError) return send(res, e.status, { error: e.code, message: e.message });
      if (e instanceof PayPalApiError) return send(res, 502, { error: 'PAYPAL', message: e.message });
      send(res, 500, { error: 'INTERNAL', message: e instanceof Error ? e.message : 'Unexpected error.' });
    });
  });
}

export function listen(server: http.Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: this is a single-user desk tool, not a hosted service.
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
    });
  });
}
