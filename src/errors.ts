/**
 * One error type, with a stable `code` the caller can branch on.
 *
 * Deliberately not a subclass hierarchy: callers want to know whether to retry, rebuild or give
 * up, and three of those are decided by a string.
 */
export type SandboxErrorCode =
  /** No engine at the socket — not running, or the per-user socket died with the session. */
  | "unavailable"
  /** This host cannot run a sandbox at all, and no amount of retrying changes that. */
  | "unsupported"
  /** The named sandbox is not there. */
  | "gone"
  /** The engine refused something — a bad image, a limit it will not apply. */
  | "engine"
  /** The caller asked for something the runtime will not do, such as a path outside the workspace. */
  | "refused";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}
