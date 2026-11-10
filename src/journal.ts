/**
 * Append-only journal of everything that was proposed, confirmed, sent or refused.
 *
 * One JSON object per line. Each entry carries the SHA-256 of the previous one, so an edited or
 * deleted line breaks the chain and `verify()` says where. The journal is also the app's memory
 * of reminders: PayPal's API does not report how many were sent for an invoice.
 *
 * What the chain does not do: it has no key and no outside anchor. Someone who can write the file
 * can cut off its last lines, or rewrite it whole and recompute every hash, and `verify()` will
 * still say ok. `head()` is the value to note down elsewhere if that matters: it changes in both cases.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReminderHistory } from './agent/risk.js';

export type JournalType =
  | 'proposed' | 'advised' | 'revised' | 'discarded' | 'expired' | 'stale'
  | 'confirmed' | 'executed' | 'failed';

export interface JournalInput {
  type: JournalType;
  actionId?: string;
  kind?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  origin?: string;
  digest?: string;
  detail?: Record<string, unknown>;
}

export interface JournalEntry extends JournalInput {
  seq: number;
  at: string;
  prev: string;
  hash: string;
}

/** JSON with object keys sorted, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const GENESIS = '0'.repeat(64);

function hashOf(entry: Omit<JournalEntry, 'hash'>): string {
  return sha256(canonical(entry));
}

export function verifyChain(entries: JournalEntry[]): { ok: boolean; entries: number; brokenAt: number | null } {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i += 1) {
    const { hash, ...rest } = entries[i];
    if (rest.prev !== prev || rest.seq !== i + 1 || hashOf(rest) !== hash) {
      return { ok: false, entries: entries.length, brokenAt: i + 1 };
    }
    prev = hash;
  }
  return { ok: true, entries: entries.length, brokenAt: null };
}

export class Journal {
  private readonly entries: JournalEntry[] = [];
  private readonly file: string | undefined;
  private readonly now: () => Date;

  constructor(options: { path?: string; now?: () => Date } = {}) {
    this.file = options.path;
    this.now = options.now ?? (() => new Date());
    if (this.file && fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (line.trim()) this.entries.push(JSON.parse(line) as JournalEntry);
      }
    } else if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    }
  }

  /** `at` is only passed by the demo seed, to backdate history; everything else uses the clock. */
  append(input: JournalInput, at?: string): JournalEntry {
    const last = this.entries[this.entries.length - 1];
    const rest: Omit<JournalEntry, 'hash'> = {
      ...input,
      seq: this.entries.length + 1,
      at: at ?? this.now().toISOString(),
      prev: last ? last.hash : GENESIS,
    };
    const entry: JournalEntry = { ...rest, hash: hashOf(rest) };
    this.entries.push(entry);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }

  all(): JournalEntry[] {
    return this.entries.slice();
  }

  verify(): { ok: boolean; entries: number; brokenAt: number | null } {
    return verifyChain(this.entries);
  }

  /** Hash of the last entry: compare it with a copy kept elsewhere to detect truncation or a rewrite. */
  head(): string {
    const last = this.entries[this.entries.length - 1];
    return last ? last.hash : GENESIS;
  }

  /** Reminders (plain or with a payment plan) actually sent for one invoice. */
  remindersFor(invoiceId: string): ReminderHistory {
    const sent = this.entries.filter(
      (e) => e.type === 'executed' && e.invoiceId === invoiceId && (e.kind === 'REMIND' || e.kind === 'OFFER_PLAN'));
    return { count: sent.length, lastAt: sent.length ? sent[sent.length - 1].at : null };
  }
}
