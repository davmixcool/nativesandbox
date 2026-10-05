/**
 * Sandboxes, on any Linux host.
 *
 * ── The problem this solves ──
 *
 * microVM sandboxes need KVM, and most cloud instances do not have it. Nested virtualisation is
 * unavailable on all but bare-metal types, and on Oracle's Ampere ARM64 shapes — the free tier a
 * great many small deployments live on — it is simply not offered. A microVM there dies before
 * it comes up:
 *
 *     [BootStart] failed to start "…": sandbox process exited
 *     (signal: 6 (SIGABRT) (core dumped)) before agent relay became available
 *
 * That reads like a corrupt runtime. It is not. It is a host without `/dev/kvm`, and no version
 * of any microVM tool fixes it.
 *
 * Containers need no virtualisation at all, and every Linux host already runs them.
 *
 * ── The trade, stated plainly ──
 *
 * This is process isolation, not hardware isolation. A sandbox cannot read or write the host,
 * but the boundary it leans on is the kernel rather than a hypervisor, and that is a weaker
 * boundary. It is narrowed by running rootless — the sandbox's root is an unprivileged user on
 * the host, through a user namespace — and by seccomp, by memory, CPU and PID limits through
 * cgroups, and by a network policy per sandbox.
 *
 * It can be narrowed a great deal further at no cost by running the same sandboxes under gVisor,
 * which puts a user-space kernel in front of the syscall interface and still needs no KVM. That
 * is the `runtime: "runsc"` option, not a different design.
 *
 * If your host HAS KVM and you want hardware isolation, use a microVM runtime. This exists for
 * the hosts that cannot.
 *
 * ── The workspace is a bind mount ──
 *
 * microVM runtimes copy files in and out over an agent channel. Here the workspace directory is
 * mounted straight into the sandbox, so writing a file is a host write and reading one back is a
 * host read. Measured against a microVM runtime on the same machine: 7× faster to place 200
 * files, 49× faster to read them back.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine, type EngineOptions } from "./engine.js";
import { MiB, type Mebibytes } from "./units.js";
import { SandboxError } from "./errors.js";

/** Where the workspace is mounted inside every sandbox. */
export const WORKSPACE = "/workspace";

// The images this package builds are tagged with its own version, so a release and its images move together.
// Read rather than restated, for the same reason as the CLI's `--version`; the path holds from src/ and dist/.
const VERSION = (
  JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * runtime name → image. Anything unrecognised falls back to `node`.
 *
 * `node` and `python` are the stock Docker Hub images. `node-python`, `media` and `browser` are built from `images/`
 * in this repository: `node-python` is Node and Python together, `media` adds ffmpeg and libvips, and `browser` adds
 * Playwright's headless Chromium (on Debian, because that Chromium needs glibc).
 */
export const DEFAULT_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  node: "docker.io/library/node:22-alpine",
  python: "docker.io/library/python:3.12-alpine",
  "node-python": `ghcr.io/davmixcool/nativesandbox-node-python:${VERSION}`,
  media: `ghcr.io/davmixcool/nativesandbox-media:${VERSION}`,
  browser: `ghcr.io/davmixcool/nativesandbox-browser:${VERSION}`,
});

/**
 * What a runtime needs beyond its image, applied when a spec does not say otherwise.
 *
 * Chromium keeps its renderer state in `/dev/shm`, and an engine's default 64 MB of it crashes the browser on an
 * ordinary page.
 */
export const RUNTIME_DEFAULTS: Readonly<Record<string, { shmSize?: Mebibytes }>> = Object.freeze({
  browser: { shmSize: MiB(512) },
});

export interface SandboxesOptions extends EngineOptions {
  /** Where workspace directories live on the host. A temporary root when absent. */
  root?: string;
  /** runtime → image, merged over the defaults. */
  images?: Record<string, string>;
  /**
   * OCI runtime. `"runsc"` is gVisor: much stronger isolation, still no KVM.
   * Absent means the engine's default (`crun` or `runc`).
   */
  runtime?: string;
  /** Prefix for every container this instance creates, so a sweep can find its own. */
  prefix?: string;
  /**
   * Stop a sandbox after this long with no command. 0 disables it.
   *
   * A container's main process is `sleep infinity`, so unlike a microVM it never goes quiet on
   * its own — and a fleet where every sandbox reports `running` forever is one where nothing
   * can ever be safely reclaimed. This is the idle behaviour a microVM runtime provides
   * natively, reproduced here. A stopped sandbox keeps its workspace and restarts on the next
   * `create()`.
   */
  idleTimeoutMs?: number;
  /**
   * Retire a sandbox this long after it was created, however busy it is. 0 disables it.
   *
   * A hard ceiling regardless of activity, so nothing can live forever: a long-lived sandbox
   * accumulates state nobody can account for. The container is removed and the workspace is
   * KEPT, so the next `create()` gets a fresh process on a warm cache.
   */
  maxLifetimeMs?: number;
  /** How long a stop waits for the process before killing it. */
  stopGraceMs?: number;
  /**
   * Run the idle stop and lifetime retirement on a timer in this process. Default true.
   *
   * Turn it off in a process that should never stop anything it did not create — a short-lived
   * CLI, a test of the self-stop. Sandboxes still stop themselves (see `selfStop`).
   */
  housekeeping?: boolean;
  /**
   * Give every new sandbox a watchdog as its main process, so it stops ITSELF when idle and at
   * its lifetime — with no process of ours alive to stop it. Default true.
   *
   * The timer above only runs while some process holds a `Sandboxes`. A sandbox created by a
   * test, a CLI, or a server that has since restarted was otherwise `running` forever: nothing
   * was left to stop it, and a reclaimer that rightly never touches a running sandbox kept it
   * too. This is what a microVM runtime does natively. Off restores `sleep infinity`.
   */
  selfStop?: boolean;
  /**
   * What is taken away from every sandbox. All on by default; opt out one at a time.
   *
   * These are the container-side answer to "it is process isolation, not hardware isolation":
   * each one removes something a kernel escape would need. None of them costs a normal workload
   * anything — `npm install` runs unchanged under all three.
   */
  hardening?: {
    /** Drop every Linux capability. A shell running builds needs none of them. */
    dropCapabilities?: boolean;
    /** Forbid gaining privileges through setuid binaries. */
    noNewPrivileges?: boolean;
    /**
     * Mount the image read-only. Only the workspace and a private `/tmp` are writable.
     *
     * OFF by default, because it forbids the one thing some callers want at the root:
     * symlinks from `/src` to `/workspace/src`, so workspace-absolute paths resolve. Turn it on
     * where that is not needed; it is the strongest of the three.
     */
    readOnlyRoot?: boolean;
  };
}

export interface SandboxSpec {
  /** Selects the image when `image` is not given. */
  runtime?: string;
  /** An explicit image, overriding `runtime`. */
  image?: string;
  /** Enforced through cgroups. Write the unit: `MiB(512)`, `GiB(2)`. */
  memory?: Mebibytes;
  /** Fractional values are allowed — `0.5` is half a core. */
  cpus?: number;
  /** Maximum processes, which is what stops a fork bomb. */
  pids?: number;
  /** `"none"` cuts the sandbox off from the network entirely. */
  network?: "bridge" | "none";
  /**
   * Size of `/dev/shm`. Absent means the runtime's default (`RUNTIME_DEFAULTS`), else the engine's 64 MB.
   * A capacity like `memory`: a sandbox with at least this much is reused.
   */
  shmSize?: Mebibytes;

  /**
   * Stop this sandbox after this long with no command, overriding the instance default.
   * 0 disables it for this sandbox alone.
   */
  idleTimeoutMs?: number;
  /** Retire this sandbox this long after creation, overriding the instance default. */
  maxLifetimeMs?: number;
  /** How long a stop of this sandbox waits before killing, overriding the instance default. */
  stopGraceMs?: number;

  /**
   * Force a fresh sandbox: remove any existing one, and its workspace, before creating.
   *
   * An ACTION, not a property. It is never recorded on the sandbox and never influences
   * whether a later `create()` reuses it — otherwise every subsequent call would keep
   * replacing. Reach for it when the workspace itself is suspect; a sandbox whose shape no
   * longer serves is already rebuilt without it.
   */
  replace?: boolean;
}

export interface ExecOptions {
  /** Applies to this command only, never to the sandbox. */
  env?: Record<string, string>;
  /** Kills the command and returns `timedOut: true`. */
  timeoutMs?: number;
  /** Defaults to the workspace. */
  cwd?: string;
  /** Called as output arrives, rather than at the end. */
  onFrame?: (frame: { kind: "stdout" | "stderr"; data: Buffer }) => void;
  /** Cancels the command. Not a timeout, and not reported as one. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Null when the command was killed rather than exiting. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxInfo {
  name: string;
  id: string;
  state: string;
  image: string;
  createdAt: Date;
  /** What this sandbox was created with. Null on one created before these were recorded. */
  idleTimeoutMs: number | null;
  maxLifetimeMs: number | null;
  stopGraceMs: number | null;
}

const DEFAULTS = {
  runtime: "node",
  memory: MiB(512),
  cpus: 1,
  pids: 512,
  network: "bridge" as const,
  // Long enough to span a burst of commands, short enough that an abandoned sandbox is not
  // "running" by the time anyone looks. The same figure microVM runtimes tend to default to.
  idleTimeoutMs: 5 * 60 * 1000,
  maxLifetimeMs: 60 * 60 * 1000,
  stopGraceMs: 10_000,
  hardening: { dropCapabilities: true, noNewPrivileges: true, readOnlyRoot: false },
};

/**
 * The main process of a self-stopping sandbox: POSIX `sh`, `date`, `sleep` and `/proc`, so it runs in
 * busybox and glibc images alike.
 *
 * Every tick it looks for any process other than itself. One — a command, or anything a command left
 * in the background — means busy, and resets the idle clock. Quiet for the idle timeout, it exits and
 * the container stops. At lifetime plus idle it exits whatever is running: the backstop behind the
 * host sweep's gentler retirement, which lets a command in flight finish.
 *
 * Zombies are not busy: a command that daemonises leaves orphans reparented to PID 1, and a shell
 * does not reap those. The scan runs in the main process itself, so it never counts its own
 * children; `sleep & wait` keeps the SIGTERM trap prompt, so `stop` does not wait out its grace.
 */
export const WATCHDOG = [
  "trap 'exit 0' TERM INT HUP",
  "idle=${NATIVESANDBOX_IDLE_S:-0}; life=${NATIVESANDBOX_LIFE_S:-0}; tick=${NATIVESANDBOX_TICK_S:-5}",
  "start=$(date +%s); last=$start",
  "while :; do",
  "  sleep \"$tick\" & wait $!",
  "  now=$(date +%s)",
  "  for p in /proc/[0-9]*; do",
  "    [ \"$p\" = \"/proc/$$\" ] && continue",
  "    s=; while read -r k v _; do [ \"$k\" = State: ] && { s=$v; break; }; done 2>/dev/null < \"$p/status\"",
  "    [ -n \"$s\" ] && [ \"$s\" != Z ] && { last=$now; break; }",
  "  done",
  "  [ \"$idle\" -gt 0 ] && [ $((now - last)) -ge \"$idle\" ] && exit 0",
  "  [ \"$life\" -gt 0 ] && [ $((now - start)) -ge $((life + idle)) ] && exit 0",
  "done",
].join("\n");

/** Milliseconds as whole seconds for the watchdog, never rounding a real deadline down to "none". */
const seconds = (ms: number): number => (ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0);

/** A ceiling as a comparable number: 0 means "no limit", which is the loosest, not the tightest. */
const ceiling = (ms: number): number => (ms > 0 ? ms : Number.POSITIVE_INFINITY);

/** A numeric label, or null when it is absent or unparseable. */
function label(labels: Record<string, string>, key: string): number | null {
  const raw = labels[`nativesandbox.${key}`];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * One sandbox: a running container with a workspace directory mounted into it.
 *
 * Obtained from `Sandboxes.create()`. Every method is safe to call concurrently except the
 * lifecycle ones.
 */
export class Sandbox {
  readonly name: string;
  readonly id: string;
  /** The host directory mounted at {@link WORKSPACE}. Reading it is reading the sandbox. */
  readonly workspaceDir: string;

  readonly #engine: Engine;
  readonly #touch: () => void;

  /** @internal — use `Sandboxes.create()`. */
  constructor(engine: Engine, name: string, id: string, workspaceDir: string, touch: () => void = () => {}) {
    this.#engine = engine;
    this.name = name;
    this.id = id;
    this.workspaceDir = workspaceDir;
    this.#touch = touch;
  }

  /** Run a command and wait for all of it. */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.#touch();
    const created = await this.#engine.call<{ Id: string }>("POST", `/containers/${this.id}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      // Closed, so anything reading stdin gets EOF at once rather than hanging to the timeout.
      AttachStdin: false,
      Tty: false,
      WorkingDir: options.cwd ?? WORKSPACE,
      Env: Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`),
      Cmd: ["sh", "-c", command],
    });
    if (!created) throw new SandboxError("engine", "The engine created no exec.");

    let stdout = "";
    let stderr = "";
    const cancel = new AbortController();
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          cancel.abort();
        }, options.timeoutMs)
      : null;
    const relay = () => cancel.abort();
    options.signal?.addEventListener("abort", relay, { once: true });

    try {
      await this.#engine.execStream(
        created.Id,
        (frame) => {
          const text = frame.data.toString("utf8");
          if (frame.stream === "stderr") stderr += text;
          else stdout += text;
          options.onFrame?.({ kind: frame.stream, data: frame.data });
        },
        { signal: cancel.signal },
      );
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", relay);
    }

    if (timedOut) {
      // The command keeps running after the stream is dropped. `sh -c "echo x; sleep 30"` FORKS,
      // so killing the shell alone leaves a grandchild holding the pipes open.
      await this.#killExec(created.Id);
      return { code: null, stdout, stderr, timedOut: true };
    }
    if (options.signal?.aborted) {
      await this.#killExec(created.Id);
      return { code: null, stdout, stderr, timedOut: false };
    }

    const status = await this.#engine.call<{ ExitCode: number | null }>("GET", `/exec/${created.Id}/json`);
    return { code: status?.ExitCode ?? null, stdout, stderr, timedOut: false };
  }

  /** Write a file into the workspace. A host write, because the workspace is a bind mount. */
  async writeFile(filePath: string, data: Buffer | string): Promise<void> {
    const target = this.hostPath(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }

  /** Read a file back out of the workspace. Also a host read. */
  async readFile(filePath: string): Promise<Buffer> {
    return fs.readFileSync(this.hostPath(filePath));
  }

  /** Whether a workspace file exists, without reading it. */
  exists(filePath: string): boolean {
    return fs.existsSync(this.hostPath(filePath));
  }

  /**
   * A workspace path, as a path on the host.
   *
   * Traversal is REFUSED, not normalised. `/workspace/../../../etc/x` happens to normalise back
   * inside the directory, so a containment check alone passes and the caller silently gets a
   * different file from the one it named. A path that tried to leave is a bug or an attack;
   * either way the honest answer is no.
   */
  hostPath(filePath: string): string {
    const relative = filePath.startsWith(WORKSPACE) ? filePath.slice(WORKSPACE.length) : filePath;
    if (relative.split("/").includes("..")) {
      throw new SandboxError("refused", `Refusing a path outside the workspace: ${filePath}`);
    }
    const safe = path.posix.normalize(`/${relative}`).replace(/^\/+/, "");
    const full = path.join(this.workspaceDir, safe);
    // Belt and braces after normalising: a write deserves the second look.
    if (full !== this.workspaceDir && !full.startsWith(this.workspaceDir + path.sep)) {
      throw new SandboxError("refused", `Refusing a path outside the workspace: ${filePath}`);
    }
    return full;
  }

  /** Stop the sandbox, leaving it able to be started again. Returns once the engine agrees. */
  async stop(graceMs = DEFAULTS.stopGraceMs): Promise<void> {
    await this.#engine
      .call("POST", `/containers/${this.id}/stop?t=${Math.ceil(graceMs / 1000)}`)
      .catch(() => null);
    await this.#settle();
  }

  /** Stop it immediately. Returns once the engine agrees. */
  async kill(): Promise<void> {
    await this.#engine.call("POST", `/containers/${this.id}/kill`).catch(() => null);
    await this.#settle();
  }

  /** The engine's status lags the signal by a few hundred milliseconds; wait it out. */
  async #settle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.#engine
        .call<{ State: { Running: boolean } }>("GET", `/containers/${this.id}/json`)
        .catch(() => null);
      if (!info || !info.State.Running) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async #killExec(execId: string): Promise<void> {
    const status = await this.#engine.call<{ Pid: number }>("GET", `/exec/${execId}/json`).catch(() => null);
    if (!status?.Pid) return;
    // The whole process group, for the forked-grandchild case above.
    await this.exec(`kill -9 -${status.Pid} 2>/dev/null || kill -9 ${status.Pid} 2>/dev/null || true`).catch(
      () => undefined,
    );
  }
}

/**
 * The runtime: creates sandboxes, finds them again, removes them.
 *
 * ```ts
 * const sandboxes = new Sandboxes();
 * const box = await sandboxes.create("my-job", { memory: MiB(512) });
 * await box.writeFile("/main.js", "console.log('hi')");
 * const { stdout } = await box.exec("node main.js");
 * await sandboxes.remove("my-job");
 * ```
 */
export class Sandboxes {
  readonly engine: Engine;
  readonly root: string;

  readonly #images: Record<string, string>;
  readonly #runtime: string | null;
  readonly #prefix: string;
  readonly #idleTimeoutMs: number;
  readonly #maxLifetimeMs: number;
  readonly #stopGraceMs: number;
  readonly #hardening: Required<NonNullable<SandboxesOptions["hardening"]>>;
  /** name → last exec, for the idle stop. Sandboxes this process has not touched are absent. */
  readonly #lastUsed = new Map<string, number>();
  /** name → commands in flight, so an idle stop can never interrupt one. */
  readonly #inFlight = new Map<string, number>();
  #idleTimer: NodeJS.Timeout | null = null;
  readonly #housekeeping: boolean;
  readonly #selfStop: boolean;
  /** The interval currently armed, so a shorter per-sandbox timeout can shorten it. */
  #tickMs = 0;

  constructor(options: SandboxesOptions = {}) {
    this.engine = new Engine(options);
    this.root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "nativesandbox-"));
    fs.mkdirSync(this.root, { recursive: true });
    this.#images = { ...DEFAULT_IMAGES, ...options.images };
    this.#runtime = options.runtime ?? process.env.NATIVESANDBOX_OCI_RUNTIME ?? null;
    this.#prefix = options.prefix ?? "nsbx";
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? DEFAULTS.maxLifetimeMs;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULTS.stopGraceMs;
    this.#hardening = { ...DEFAULTS.hardening, ...options.hardening };
    this.#housekeeping = options.housekeeping ?? true;
    this.#selfStop = options.selfStop ?? true;

    this.#retune(this.#idleTimeoutMs, this.#maxLifetimeMs);
  }

  /**
   * Arm the housekeeping timer, shortening it if a sandbox asks for a tighter deadline.
   *
   * Checked at a fraction of the soonest deadline so a sandbox is stopped within, not up to
   * double, the interval asked for. Only ever shortens: a single sandbox with a 10-second idle
   * timeout has to speed the sweep up, but must not slow it down again when it goes away, and
   * re-arming on every create would reset the phase and could starve the sweep entirely.
   * Unref'd so it never keeps a process alive on its own.
   */
  #retune(...deadlines: number[]): void {
    if (!this.#housekeeping) return;
    const live = deadlines.filter((ms) => ms > 0);
    if (live.length === 0) return;
    const wanted = Math.max(Math.min(...live) / 4, 1_000);
    if (this.#idleTimer && wanted >= this.#tickMs) return;
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#tickMs = wanted;
    this.#idleTimer = setInterval(() => void this.sweep(), wanted);
    this.#idleTimer.unref?.();
  }

  /**
   * Stop every sandbox that has gone quiet, and return their names.
   *
   * A sandbox this process has never touched — left running by a previous process, say — is
   * counted as used from the moment it is first seen, so it is stopped one full timeout later
   * rather than immediately and rather than never. Never one with a command in flight.
   */
  async stopIdle(now: number = Date.now()): Promise<string[]> {
    const stopped: string[] = [];

    for (const info of await this.list()) {
      if (info.state !== "running") continue;
      if ((this.#inFlight.get(info.name) ?? 0) > 0) continue;

      // The sandbox's own timeout, not this instance's — it may have been created by another
      // process, or with an override.
      const timeout = info.idleTimeoutMs ?? this.#idleTimeoutMs;
      if (timeout <= 0) continue;

      const last = this.#lastUsed.get(info.name);
      if (last === undefined) {
        this.#lastUsed.set(info.name, now);
        continue;
      }
      if (now - last < timeout) continue;

      const grace = info.stopGraceMs ?? this.#stopGraceMs;
      await this.engine
        .call("POST", `/containers/${info.id}/stop?t=${Math.ceil(grace / 1000)}`)
        .catch(() => null);
      await this.#confirmStopped(info.id);
      this.#lastUsed.delete(info.name);
      stopped.push(info.name);
    }
    return stopped;
  }

  /**
   * Retire every sandbox past its maximum lifetime, and return their names.
   *
   * The container goes; the workspace directory stays. A command in flight is allowed to
   * finish — the ceiling is on how long a sandbox can be REUSED, not a kill switch under a
   * running build. Measured from the engine's own creation time, so it holds across processes.
   */
  async retireExpired(now: number = Date.now()): Promise<string[]> {
    const retired: string[] = [];

    for (const info of await this.list()) {
      if ((this.#inFlight.get(info.name) ?? 0) > 0) continue;

      const lifetime = info.maxLifetimeMs ?? this.#maxLifetimeMs;
      if (lifetime <= 0) continue;
      if (now - info.createdAt.getTime() < lifetime) continue;

      await this.engine.call("POST", `/containers/${info.id}/kill`).catch(() => null);
      await this.engine.call("DELETE", `/containers/${info.id}?force=true&v=true`).catch(() => null);
      this.#lastUsed.delete(info.name);
      retired.push(info.name);
    }
    return retired;
  }

  /** Both housekeeping passes. This is what the timer runs. */
  async sweep(now: number = Date.now()): Promise<{ stopped: string[]; retired: string[] }> {
    return { stopped: await this.stopIdle(now), retired: await this.retireExpired(now) };
  }

  /**
   * Wait until the engine AGREES the container is stopped.
   *
   * `stop` returns when the signal has been sent, and the status it reports afterwards lags by
   * a few hundred milliseconds. Measured: a list taken straight after `stop` returned said
   * `running`; the same list half a second later said `exited`. A caller that trusted the
   * return value would see a phantom running sandbox and — in the reaper's case — decline to
   * remove something that was already dead. Bounded, so a truly stuck container fails loud
   * rather than hangs.
   */
  async #confirmStopped(id: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.engine
        .call<{ State: { Running: boolean } }>("GET", `/containers/${id}/json`)
        .catch(() => null);
      if (!info || !info.State.Running) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Stop the idle timer. Sandboxes are left as they are. */
  close(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
  }

  /** The engine's version — and a clear failure if it is not reachable. */
  async ping(): Promise<string> {
    return (await this.engine.version()).Version;
  }

  /**
   * Whether this host can run a sandbox at all, and why not when it cannot.
   *
   * Worth calling at startup. The alternative is discovering it on a customer's first command.
   */
  async check(): Promise<{ ok: boolean; engine?: string; problem?: string }> {
    try {
      const version = await this.engine.version();
      return { ok: true, engine: version.Version };
    } catch (error) {
      return { ok: false, problem: (error as Error).message };
    }
  }

  /**
   * Pull the images for these runtimes now, and return the images pulled.
   *
   * `create()` pulls on demand, which is right for a small image and wrong for a large one: the browser image is
   * several hundred megabytes, and a first command that waits for it blows any sensible timeout. A host that will
   * use a runtime pulls it ahead — at deploy, or at boot. A name that is not a runtime is pulled as an image
   * reference. Defaults to every runtime this instance knows.
   */
  async pull(runtimes: string[] = Object.keys(this.#images)): Promise<string[]> {
    const images = [...new Set(runtimes.map((r) => this.#images[r] ?? r))];
    for (const image of images) await this.engine.pull(image);
    return images;
  }

  /**
   * A sandbox by that name: the running one if its shape still serves, else a fresh one.
   *
   * Reuse is MEET-OR-EXCEED, not equality, and the distinction is load-bearing. Under equality a
   * build asking for 2048MB and a small command asking for 256MB never share a sandbox, so every
   * command replaces the last one's and destroys whatever it had installed. That turns every
   * dependency install cold. A bigger sandbox runs a smaller command perfectly well; the reverse
   * is not true and is rebuilt, so a raised budget still takes effect.
   *
   * Capacities meet-or-exceed; CEILINGS meet-or-undercut. A sandbox that stops sooner than
   * asked is acceptable — it restarts here transparently — but one entitled to outlive the
   * ceiling the caller just set is not, so it is rebuilt.
   *
   * A rebuild replaces the CONTAINER and keeps the workspace, as retirement does. Deleting it threw
   * away whatever was installed every time a job moved between images or needed more room.
   *
   * `spec.replace` skips all of this and starts clean, workspace included.
   */
  async create(name: string, spec: SandboxSpec = {}): Promise<Sandbox> {
    const full = this.#name(name);

    if (spec.replace) {
      await this.remove(name);
      return this.#create(name, spec);
    }

    const existing = await this.#find(full);

    if (existing) {
      if (this.#satisfies(existing, spec) && (existing.State === "running" || await this.#restart(full, existing.Id))) {
        this.#lastUsed.set(name, Date.now());
        return this.#handle(name, existing.Id);
      }
      await this.#discardContainer(name, existing.Id);
    }
    return this.#create(name, spec);
  }

  /** The host directory mounted into a sandbox, whether or not it exists yet. */
  workspaceDir(name: string): string {
    return path.join(this.root, this.#name(name));
  }

  /** Every sandbox this runtime owns, in any state. */
  async list(): Promise<SandboxInfo[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`nativesandbox.prefix=${this.#prefix}`] }));
    const found = await this.engine.call<
      { Id: string; State: string; Image: string; Created: number; Labels: Record<string, string> }[]
    >("GET", `/containers/json?all=true&filters=${filters}`);
    return (found ?? []).map((c) => ({
      name: c.Labels["nativesandbox.name"] ?? "",
      id: c.Id,
      state: c.State,
      image: c.Image,
      createdAt: new Date(c.Created * 1000),
      idleTimeoutMs: label(c.Labels, "idleTimeoutMs"),
      maxLifetimeMs: label(c.Labels, "maxLifetimeMs"),
      stopGraceMs: label(c.Labels, "stopGraceMs"),
    }));
  }

  /** Remove a sandbox and its workspace. Returns whether there was one. */
  async remove(name: string): Promise<boolean> {
    const full = this.#name(name);
    const found = await this.#find(full);
    if (found) {
      await this.engine.call("POST", `/containers/${found.Id}/kill`).catch(() => null);
      await this.engine.call("DELETE", `/containers/${found.Id}?force=true&v=true`).catch(() => null);
    }
    fs.rmSync(this.workspaceDir(name), { recursive: true, force: true });
    this.#lastUsed.delete(name);
    this.#inFlight.delete(name);
    return Boolean(found);
  }

  /** Remove every sandbox this runtime owns. */
  async removeAll(): Promise<number> {
    const all = await this.list();
    for (const info of all) if (info.name) await this.remove(info.name);
    return all.length;
  }

  // ── internals ───────────────────────────────────────────────────────────

  #name(name: string): string {
    return `${this.#prefix}-${name}`;
  }

  /** The container only: its workspace stays for the sandbox built next under the same name. */
  /**
   * Start a stopped sandbox, and say whether it is running now.
   *
   * A failed start used to be swallowed and the handle returned anyway: a container caught mid-stop (Podman's
   * `stopping`, as an idle stop runs) or paused answered the first exec with "can only create exec sessions on
   * running containers". Not running after this means rebuild, which keeps the workspace.
   */
  async #restart(fullName: string, id: string): Promise<boolean> {
    await this.engine.call("POST", `/containers/${id}/start`).catch(() => null);
    return (await this.#find(fullName))?.State === "running";
  }

  async #discardContainer(name: string, id: string): Promise<void> {
    await this.engine.call("POST", `/containers/${id}/kill`).catch(() => null);
    await this.engine.call("DELETE", `/containers/${id}?force=true&v=true`).catch(() => null);
    this.#lastUsed.delete(name);
    this.#inFlight.delete(name);
  }

  #imageFor(spec: SandboxSpec): string {
    return spec.image ?? this.#images[spec.runtime ?? DEFAULTS.runtime] ?? this.#images.node!;
  }

  /** The `/dev/shm` a spec asks for, in MiB; 0 means the engine's default. */
  #shmFor(spec: SandboxSpec): number {
    return spec.shmSize ?? RUNTIME_DEFAULTS[spec.runtime ?? DEFAULTS.runtime]?.shmSize ?? 0;
  }

  #satisfies(
    container: { Created?: number; Labels?: Record<string, string> },
    spec: SandboxSpec,
    now: number = Date.now(),
  ): boolean {
    const labels = container.Labels ?? {};
    const memory = Number(labels["nativesandbox.memory"]);
    const cpus = Number(labels["nativesandbox.cpus"]);
    const image = labels["nativesandbox.image"];
    if (!Number.isFinite(memory) || !Number.isFinite(cpus) || !image) return false;
    // Image is an identity, not a quantity: a python command can never land in a node sandbox,
    // and no amount of spare memory makes it able to.
    if (image !== this.#imageFor(spec)) return false;
    if (memory < (spec.memory ?? DEFAULTS.memory)) return false;
    if (cpus < (spec.cpus ?? DEFAULTS.cpus)) return false;
    if ((label(labels, "shmSize") ?? 0) < this.#shmFor(spec)) return false;

    // Ceilings run the other way: 0 means "no limit", which is the loosest value rather than
    // the tightest, so it compares as infinite.
    const wantIdle = ceiling(spec.idleTimeoutMs ?? this.#idleTimeoutMs);
    const hasIdle = ceiling(label(labels, "idleTimeoutMs") ?? this.#idleTimeoutMs);
    if (hasIdle > wantIdle) return false;

    const wantLife = ceiling(spec.maxLifetimeMs ?? this.#maxLifetimeMs);
    const hasLife = ceiling(label(labels, "maxLifetimeMs") ?? this.#maxLifetimeMs);
    if (hasLife > wantLife) return false;
    // Entitled to live long enough is not the same as having done so: a sweep may not have run
    // yet, and handing back a sandbox already older than the ceiling would break it on arrival.
    if (container.Created !== undefined && now - container.Created * 1000 >= wantLife) return false;

    return true;
  }

  async #find(fullName: string) {
    const filters = encodeURIComponent(JSON.stringify({ name: [fullName] }));
    const found = await this.engine.call<
      { Id: string; State: string; Names: string[]; Created: number; Labels?: Record<string, string> }[]
    >("GET", `/containers/json?all=true&filters=${filters}`);
    // The name filter matches substrings, so the exact name is confirmed rather than assumed.
    return (found ?? []).find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, "") === fullName)) ?? null;
  }

  async #create(name: string, spec: SandboxSpec): Promise<Sandbox> {
    const full = this.#name(name);
    const image = this.#imageFor(spec);
    const dir = this.workspaceDir(name);
    fs.mkdirSync(dir, { recursive: true });

    // Recorded on the container, not held in this process, so the sweep honours them after a
    // restart and any other process reading the fleet sees the same deadlines.
    const idleTimeoutMs = spec.idleTimeoutMs ?? this.#idleTimeoutMs;
    const maxLifetimeMs = spec.maxLifetimeMs ?? this.#maxLifetimeMs;
    const stopGraceMs = spec.stopGraceMs ?? this.#stopGraceMs;
    const shmSize = this.#shmFor(spec);
    this.#retune(idleTimeoutMs, maxLifetimeMs);

    const body = {
      Image: image,
      // Every command is an exec into this one sandbox, which is what makes it worth keeping warm.
      // The main process only decides when it has been idle long enough to stop (WATCHDOG).
      Cmd: this.#selfStop ? ["sh", "-c", WATCHDOG] : ["sleep", "infinity"],
      ...(this.#selfStop ? { Env: this.#watchdogEnv(idleTimeoutMs, maxLifetimeMs) } : {}),
      WorkingDir: WORKSPACE,
      Labels: {
        "nativesandbox.prefix": this.#prefix,
        "nativesandbox.name": name,
        "nativesandbox.image": image,
        "nativesandbox.memory": String(spec.memory ?? DEFAULTS.memory),
        "nativesandbox.cpus": String(spec.cpus ?? DEFAULTS.cpus),
        "nativesandbox.idleTimeoutMs": String(idleTimeoutMs),
        "nativesandbox.maxLifetimeMs": String(maxLifetimeMs),
        "nativesandbox.stopGraceMs": String(stopGraceMs),
        "nativesandbox.shmSize": String(shmSize),
        "nativesandbox.selfStop": this.#selfStop ? "1" : "0",
      },
      HostConfig: {
        Binds: [`${dir}:${WORKSPACE}`],
        Memory: (spec.memory ?? DEFAULTS.memory) * 1024 * 1024,
        NanoCpus: Math.round((spec.cpus ?? DEFAULTS.cpus) * 1e9),
        PidsLimit: spec.pids ?? DEFAULTS.pids,
        ...(shmSize > 0 ? { ShmSize: shmSize * 1024 * 1024 } : {}),
        NetworkMode: (spec.network ?? DEFAULTS.network) === "none" ? "none" : "bridge",
        ...(this.#runtime ? { Runtime: this.#runtime } : {}),
        // What a kernel escape would need, taken away. Each is a real reduction of the surface
        // and none costs a build anything.
        ...(this.#hardening.dropCapabilities ? { CapDrop: ["ALL"] } : {}),
        ...(this.#hardening.noNewPrivileges ? { SecurityOpt: ["no-new-privileges"] } : {}),
        ...(this.#hardening.readOnlyRoot
          ? {
              ReadonlyRootfs: true,
              // A private, size-capped /tmp, because a read-only root has nowhere else for one,
              // and most tooling assumes it exists.
              Tmpfs: { "/tmp": "rw,noexec,nosuid,size=256m" },
            }
          : {}),
      },
    };

    let created: { Id: string } | null;
    try {
      created = await this.engine.call<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(full)}`,
        body,
      );
    } catch (error) {
      // Pull on demand rather than as a documented prerequisite: an image missing from the cache
      // is normal on a fresh host, after a prune, or the first time a different runtime is asked
      // for, and failing there would look like a broken installation.
      if (!/No such image|not found/i.test((error as Error).message)) throw error;
      await this.engine.pull(image);
      created = await this.engine.call<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(full)}`,
        body,
      );
    }
    if (!created) throw new SandboxError("engine", `The engine created no container for ${image}.`);

    await this.engine.call("POST", `/containers/${created.Id}/start`);
    this.#lastUsed.set(name, Date.now());
    return this.#handle(name, created.Id);
  }

  /** The watchdog's deadlines, and a tick short enough to stop within a third of the idle timeout. */
  #watchdogEnv(idleTimeoutMs: number, maxLifetimeMs: number): string[] {
    const idle = seconds(idleTimeoutMs);
    const life = seconds(maxLifetimeMs);
    const soonest = Math.min(...[idle, life].filter((s) => s > 0), 15);
    const tick = Math.min(5, Math.max(1, Math.floor(soonest / 3)));
    return [`NATIVESANDBOX_IDLE_S=${idle}`, `NATIVESANDBOX_LIFE_S=${life}`, `NATIVESANDBOX_TICK_S=${tick}`];
  }

  /** A `Sandbox` wired to report each command, so idleness is measured from the last one. */
  #handle(name: string, id: string): Sandbox {
    const box = new Sandbox(this.engine, name, id, this.workspaceDir(name), () => {
      this.#lastUsed.set(name, Date.now());
    });
    // In-flight accounting wraps `exec` so a long command is never stopped from under itself.
    const exec = box.exec.bind(box);
    box.exec = async (command, options) => {
      this.#inFlight.set(name, (this.#inFlight.get(name) ?? 0) + 1);
      try {
        return await exec(command, options);
      } finally {
        this.#inFlight.set(name, (this.#inFlight.get(name) ?? 1) - 1);
        this.#lastUsed.set(name, Date.now());
      }
    };
    return box;
  }
}
