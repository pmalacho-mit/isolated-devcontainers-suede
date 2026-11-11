// Exit codes a harness can rely on (section 9.1). v2's, kept.
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 64,
  /** Something else holds what this needs; trying again later can succeed. */
  busy: 75,
  /** A push to the default branch without --allow-default. */
  defaultBranch: 77,
  /** A push with no person's confirmation (P2). Not retryable by a script. */
  unconfirmed: 78,
  /** --expect did not match what would be pushed. */
  expectMismatch: 79,
} as const;

/** An error whose message is for the person, and whose `fix` names the command or flag that
 *  resolves it (P6: every refusal names what to do). */
export class Refusal extends Error {
  code: number;
  fix: string;
  constructor(message: string, fix: string, code: number = EXIT.failed) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}
// A function declaration, so that TypeScript narrows after `if (!ok) refuse(...)`.
export function refuse(message: string, fix: string, code?: number): never {
  throw new Refusal(message, fix, code);
}
