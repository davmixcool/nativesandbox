/**
 * The container engine, over its unix socket, with no dependencies.
 *
 * Podman deliberately implements Docker's REST API, so one client drives both: Docker in
 * development, rootless Podman in production. That compatibility is why this needs no vendor
 * SDK — and a vendor SDK is exactly what cost a day of production outage when its 0.4 → 0.7
 * release renamed half its surface underneath a deploy.
 *
 * `node:http` speaks to a unix socket natively through `socketPath`, so this is a few dozen
 * lines rather than a dependency tree.
 */

import http from "node:http";
import os from "node:os";
import { SandboxError } from "./errors.js";

/** One frame of a demultiplexed exec stream. */
export interface Frame {
  stream: "stdout" | "stderr";
  data: Buffer;
}

export interface EngineOptions {
  /** Defaults to `$DOCKER_HOST`, then Podman's per-user socket, then Docker's. */
  socketPath?: string;
}

/**
 * Where the engine listens.
 *
 * Podman's socket is per-user and carries the caller's own uid — `/run/user/1001/...` on a host
 * whose service account is 1001, not the 1000 everyone assumes. Derived, never written out.
 */
export function defaultSocketPath(): string {
  const fromEnv = process.env.DOCKER_HOST?.replace(/^unix:\/\//, "");
  if (fromEnv) return fromEnv;

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && os.platform() === "linux") return `/run/user/${uid}/podman/podman.sock`;
  return "/var/run/docker.sock";
}

export class Engine {
  readonly socketPath: string;

  constructor(options: EngineOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
  }

  /** A JSON request. Returns null for the empty bodies the engine sends on 204. */
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T | null> {
    const { status, text } = await this.#request(method, path, body);
    if (status >= 400) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* not JSON */
      }
      throw new SandboxError(status === 404 ? "gone" : "engine", `${method} ${path} → ${status}: ${message}`);
    }
    return text ? (JSON.parse(text) as T) : null;
  }

  /** The engine's own version, and a clear failure when the socket is not there. */
  async version(): Promise<{ Version: string; ApiVersion: string }> {
    const info = await this.call<{ Version: string; ApiVersion: string }>("GET", "/version");
    if (!info) throw new SandboxError("unavailable", "The container engine returned no version.");
    return info;
  }

  /**
   * Pull an image, waiting for the pull to finish.
   *
   * The engine streams progress and closes when done, so draining the body IS the wait —
   * returning early hands the caller a create that fails with the same 404 that got us here.
   * Per-layer failures arrive in the body rather than in the status code.
   */
  async pull(image: string): Promise<void> {
    const at = image.lastIndexOf(":");
    const tagged = at !== -1 && !image.slice(at + 1).includes("/");
    const name = tagged ? image.slice(0, at) : image;
    const tag = tagged ? image.slice(at + 1) : "latest";

    const { status, text } = await this.#request(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
    );
    if (status >= 400) throw new SandboxError("engine", `Could not pull ${image}: ${status} ${text}`);
    if (/"error"/.test(text)) {
      const line = text.split("\n").find((l) => l.includes('"error"')) ?? text;
      throw new SandboxError("engine", `Could not pull ${image}: ${line}`);
    }
  }

  /**
   * Run an exec, calling `onFrame` as output arrives.
   *
   * The stream is FRAMED, not raw: an 8-byte header — stream byte, three zeros, a big-endian
   * uint32 length — then that many bytes. stdout and stderr share one connection and are told
   * apart only by that first byte, so a naive read concatenates them into something that looks
   * almost right and silently is not. One header can arrive split across chunks and one chunk
   * can carry several frames, which is why the buffer is drained in a loop.
   */
  execStream(execId: string, onFrame: (frame: Frame) => void, options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ Detach: false, Tty: false });
      const request = http.request(
        {
          socketPath: this.socketPath,
          method: "POST",
          path: `/exec/${execId}/start`,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        },
        (res) => {
          let buffered = Buffer.alloc(0);
          res.on("data", (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            while (buffered.length >= 8) {
              const length = buffered.readUInt32BE(4);
              if (buffered.length < 8 + length) break;
              onFrame({ stream: buffered[0] === 2 ? "stderr" : "stdout", data: buffered.subarray(8, 8 + length) });
              buffered = buffered.subarray(8 + length);
            }
          });
          res.on("end", () => resolve());
          // Aborting tears the socket down mid-response, so the failure arrives HERE as well as
          // on the request. Destroying the connection is how a timeout stops reading, and it
          // must not read as a fault.
          res.on("error", (error) => (signal?.aborted ? resolve() : reject(error)));
        },
      );
      request.on("error", (error) => (signal?.aborted ? resolve() : reject(error)));
      if (signal) signal.addEventListener("abort", () => request.destroy(), { once: true });
      request.write(body);
      request.end();
    });
  }

  #request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      request.on("error", (error: NodeJS.ErrnoException) => {
        // The failure people actually hit. A per-user socket dies with the login session unless
        // lingering is on, and ECONNREFUSED on an unfamiliar path is a poor way to learn that.
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          reject(
            new SandboxError(
              "unavailable",
              `No container engine at ${this.socketPath} — is it running?\n`
                + `  rootless Podman:  systemctl --user enable --now podman.socket\n`
                + `                    loginctl enable-linger "$USER"   # so it survives logout\n`
                + `  Docker:           set DOCKER_HOST, or start the daemon\n`
                + `  (${error.code})`,
            ),
          );
          return;
        }
        reject(error);
      });
      if (payload) request.write(payload);
      request.end();
    });
  }
}
