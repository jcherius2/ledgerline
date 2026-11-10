/**
 * A Confirmation is the proof that a human confirmed one exact action.
 *
 * `mintConfirmation` must be imported by src/gate.ts only; a test scans the source tree to
 * enforce that. The PayPal client checks every write against the set of minted objects, so a
 * look-alike object ({actionId, digest}) built anywhere else is refused.
 */
const minted = new WeakSet<object>();

export interface Confirmation {
  readonly actionId: string;
  readonly digest: string;
  readonly confirmedAt: string;
}

export function mintConfirmation(actionId: string, digest: string, confirmedAt: string): Confirmation {
  const c: Confirmation = Object.freeze({ actionId, digest, confirmedAt });
  minted.add(c);
  return c;
}

export class UnconfirmedWriteError extends Error {
  constructor() {
    super('Refused: this PayPal write was not confirmed by a human through the confirmation gate.');
    this.name = 'UnconfirmedWriteError';
  }
}

export function assertConfirmed(c: unknown): asserts c is Confirmation {
  if (typeof c !== 'object' || c === null || !minted.has(c)) throw new UnconfirmedWriteError();
}
