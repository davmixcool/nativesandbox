/**
 * nativesandbox — run untrusted code in isolated sandboxes on any Linux host.
 *
 * Containers through Podman or Docker. No nested virtualisation, no KVM, no daemon of our own,
 * and no dependencies.
 *
 * @see https://nativesandbox.dev
 */

export { Sandboxes, Sandbox, WORKSPACE, DEFAULT_IMAGES, WATCHDOG } from "./runtime.js";
export type { SandboxesOptions, SandboxSpec, ExecOptions, ExecResult, SandboxInfo } from "./runtime.js";
export { Engine, defaultSocketPath } from "./engine.js";
export type { EngineOptions, Frame } from "./engine.js";
export { KiB, MiB, GiB, TiB } from "./units.js";
export type { Mebibytes } from "./units.js";
export { SandboxError } from "./errors.js";
export type { SandboxErrorCode } from "./errors.js";
