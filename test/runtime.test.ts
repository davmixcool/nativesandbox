/**
 * The runtime, against a real container engine.
 *
 * Deliberately not against a stub. Every bug this package has had so far was in the seam with
 * the engine — a framed stream demuxed wrongly, an abort surfacing on the response rather than
 * the request, a traversal that normalised back inside the directory and passed a containment
 * check. A stub reproduces none of those, and would have reported green through all three.
 *
 * SKIPs when no engine is reachable, so a machine without Podman or Docker says so rather than
 * failing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { DEFAULT_IMAGES, MiB, Sandboxes, SandboxError, WORKSPACE } from "../src/index.js";

// `selfStop: false` here and in the host-sweep suites below: they test the sweep, and 1-second
// deadlines would race a sandbox stopping itself. The self-stop has its own suite.
const sandboxes = new Sandboxes({ prefix: "nsbx-test", selfStop: false });
const reachable = await sandboxes.check();

describe.skipIf(!reachable.ok)("nativesandbox", () => {
  const NAME = "runtime-suite";

  afterAll(async () => {
    await sandboxes.removeAll().catch(() => 0);
    rmSync(sandboxes.root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    await sandboxes.remove(NAME).catch(() => false);
  });

  describe("creating", () => {
    it("starts a sandbox and reports what it is", async () => {
      const box = await sandboxes.create(NAME);
      expect(box.name).toBe(NAME);
      expect(box.id).toMatch(/^[0-9a-f]{12,}$/);
      expect((await box.exec("echo alive")).stdout.trim()).toBe("alive");
    });

    it("reuses a sandbox that is big enough, and rebuilds one that is not", async () => {
      const big = await sandboxes.create(NAME, { memory: MiB(512), cpus: 1 });

      // Meet-or-exceed. Under equality these would be different sandboxes, and everything the
      // first one installed would be thrown away by the second.
      const small = await sandboxes.create(NAME, { memory: MiB(256), cpus: 1 });
      expect(small.id).toBe(big.id);

      // The other direction must NOT reuse, or a raised budget never takes effect.
      const bigger = await sandboxes.create(NAME, { memory: MiB(1024), cpus: 1 });
      expect(bigger.id).not.toBe(big.id);
    });

    it("never reuses across images, however much room is spare", async () => {
      const node = await sandboxes.create(NAME, { runtime: "node", memory: MiB(1024) });
      const python = await sandboxes.create(NAME, { runtime: "python", memory: MiB(256) });
      // An identity, not a quantity: a python command cannot run in a node sandbox.
      expect(python.id).not.toBe(node.id);
      await sandboxes.create(NAME, { runtime: "node" }); // back to node for the rest
    });

    it("applies the limits it was given, rather than accepting and ignoring them", async () => {
      await sandboxes.remove(NAME);
      const box = await sandboxes.create(NAME, { memory: MiB(256), pids: 128 });
      const memory = await box.exec("cat /sys/fs/cgroup/memory.max 2>/dev/null || echo unknown");
      // A figure equal to the host's total RAM means the limit was silently dropped, which is
      // worse than being refused.
      expect(memory.stdout.trim()).toBe(String(256 * 1024 * 1024));
      const pids = await box.exec("cat /sys/fs/cgroup/pids.max 2>/dev/null || echo unknown");
      expect(pids.stdout.trim()).toBe("128");
    });
  });

  describe("running commands", () => {
    it("separates stdout from stderr and returns the exit code", async () => {
      const box = await sandboxes.create(NAME);
      const result = await box.exec("echo out; echo err >&2; exit 3");
      expect(result.stdout.trim()).toBe("out");
      expect(result.stderr.trim()).toBe("err");
      expect(result.code).toBe(3);
    });

    it("streams output as it is produced, not at the end", async () => {
      const box = await sandboxes.create(NAME);
      const at: number[] = [];
      await box.exec("echo one; sleep 0.6; echo two", { onFrame: () => at.push(Date.now()) });
      expect(at.length).toBeGreaterThanOrEqual(2);
      // Without this a long build shows nothing and then everything.
      expect(at.at(-1)! - at[0]!).toBeGreaterThan(300);
    });

    it("applies the environment to one command only", async () => {
      const box = await sandboxes.create(NAME);
      expect((await box.exec('printf %s "$ONLY"', { env: { ONLY: "yes" } })).stdout).toBe("yes");
      // The sandbox outlives the command, and the next one may belong to somebody else.
      expect((await box.exec('printf %s "$ONLY"')).stdout).toBe("");
    });

    it("closes stdin, so a reader exits instead of hanging to the timeout", async () => {
      const box = await sandboxes.create(NAME);
      const result = await box.exec("cat", { timeoutMs: 5_000 });
      expect(result.timedOut).toBe(false);
    });

    it("times out a command that will not finish, even when it forked", async () => {
      const box = await sandboxes.create(NAME);
      // `sh -c "echo x; sleep 30"` FORKS, so killing the shell alone leaves a grandchild holding
      // the pipes open and the call never returns.
      const result = await box.exec("echo starting; sleep 30", { timeoutMs: 1_000 });
      expect(result.timedOut).toBe(true);
      expect(result.stdout).toContain("starting");
    });

    it("cancels without calling it a timeout", async () => {
      const box = await sandboxes.create(NAME);
      const cancel = new AbortController();
      setTimeout(() => cancel.abort(), 300);
      const result = await box.exec("sleep 30", { signal: cancel.signal, timeoutMs: 30_000 });
      // Cancellation is not a fault, and reporting it as a timeout lies twice.
      expect(result.timedOut).toBe(false);
    });
  });

  describe("the workspace", () => {
    it("carries files both ways", async () => {
      const box = await sandboxes.create(NAME);
      await box.writeFile("/from-host.txt", "written by the host");
      expect((await box.exec("cat from-host.txt")).stdout.trim()).toBe("written by the host");

      await box.exec('mkdir -p sub && echo "written by the sandbox" > sub/out.txt');
      // The half that matters: without it there is no way to get work back out.
      expect((await box.readFile("/sub/out.txt")).toString().trim()).toBe("written by the sandbox");
    });

    it("accepts a path with or without the workspace prefix", async () => {
      const box = await sandboxes.create(NAME);
      await box.writeFile(`${WORKSPACE}/prefixed.txt`, "x");
      expect(box.exists("/prefixed.txt")).toBe(true);
    });

    it("refuses a traversal rather than normalising it", async () => {
      const box = await sandboxes.create(NAME);
      // This normalises back INSIDE the directory, so a containment check alone passes and the
      // caller silently gets a different file from the one it named.
      await expect(box.writeFile("/../../../etc/escaped", "no")).rejects.toThrow(/outside the workspace/);
      expect(() => box.hostPath("/a/../../b")).toThrow(SandboxError);
    });
  });

  describe("idle stop — the thing that makes a fleet reclaimable", () => {
    // A container's main process is `sleep infinity`, so unlike a microVM it never goes quiet on
    // its own. Without this, every sandbox reports `running` forever and nothing can ever be
    // safely reclaimed — a leak with a fresh coat of paint.
    const quick = new Sandboxes({ prefix: "nsbx-idle", idleTimeoutMs: 1_000, selfStop: false });
    const IDLE = "idle-suite";

    afterAll(async () => {
      quick.close();
      await quick.removeAll().catch(() => 0);
      rmSync(quick.root, { recursive: true, force: true });
    });

    it("stops a sandbox that has gone quiet, and restarts it on the next create", async () => {
      const box = await quick.create(IDLE);
      await box.exec("true");

      // Not yet: it was just used.
      expect(await quick.stopIdle()).toEqual([]);
      expect((await quick.list()).find((s) => s.name === IDLE)?.state).toBe("running");

      // Past the timeout, measured from that last command.
      expect(await quick.stopIdle(Date.now() + 2_000)).toEqual([IDLE]);
      expect((await quick.list()).find((s) => s.name === IDLE)?.state).not.toBe("running");

      // The workspace survived the stop, and the next create brings it back.
      await box.writeFile("/kept.txt", "still here");
      const again = await quick.create(IDLE);
      expect(again.id).toBe(box.id);
      expect((await again.exec("cat kept.txt")).stdout.trim()).toBe("still here");
    });

    it("never stops a sandbox with a command in flight, however idle the clock says", async () => {
      const box = await quick.create(IDLE);
      const running = box.exec("sleep 2; echo done");
      await new Promise((r) => setTimeout(r, 200));

      // The clock says it is long overdue. The in-flight count says otherwise, and wins.
      expect(await quick.stopIdle(Date.now() + 60_000)).toEqual([]);
      expect((await running).stdout.trim()).toBe("done");
    });

    it("counts a sandbox it has never seen as used from first sight, not as abandoned", async () => {
      // Left running by a previous process, say. Stopping it on first sight could interrupt a
      // command that process is still running; never stopping it is the leak. So: one full
      // timeout from now.
      await quick.create(IDLE);
      const fresh = new Sandboxes({ prefix: "nsbx-idle", idleTimeoutMs: 1_000, root: quick.root, selfStop: false });
      try {
        expect(await fresh.stopIdle()).toEqual([]);                    // first sight: noted
        expect(await fresh.stopIdle(Date.now() + 2_000)).toEqual([IDLE]); // one timeout later: stopped
      } finally {
        fresh.close();
      }
    });
  });

  describe("self-stop — a sandbox stops itself, with no process of ours alive", () => {
    // The host sweep only runs while a process holds a `Sandboxes`. A sandbox created by a test,
    // a CLI, or a server that has since restarted was `running` forever — and a reclaimer that
    // rightly never touches a running sandbox kept it too. `housekeeping: false` here, so nothing
    // but the sandbox's own main process can be what stops it.
    const alone = new Sandboxes({ prefix: "nsbx-self", idleTimeoutMs: 2_000, housekeeping: false });

    const stateOf = async (name: string) => (await alone.list()).find((s) => s.name === name)?.state;
    async function until(name: string, state: string, withinMs: number): Promise<number> {
      const started = Date.now();
      while (Date.now() - started < withinMs) {
        if ((await stateOf(name)) === state) return Date.now() - started;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`${name} was not ${state} within ${withinMs}ms (it is ${await stateOf(name)})`);
    }

    afterAll(async () => {
      await alone.removeAll().catch(() => 0);
      rmSync(alone.root, { recursive: true, force: true });
    });

    it("stops once nothing has run for its idle timeout", async () => {
      const box = await alone.create("quiet");
      await box.exec("true");
      expect(await stateOf("quiet")).toBe("running");
      // Two seconds of quiet plus at most one one-second tick, and some slack for the engine.
      await until("quiet", "exited", 6_000);
    });

    it("counts anything still running — a command left in the background — as busy", async () => {
      const box = await alone.create("background", { replace: true });
      await box.exec("sleep 6 >/dev/null 2>&1 &");
      await new Promise((r) => setTimeout(r, 4_000));
      // Past the idle timeout, but something is still running.
      expect(await stateOf("background")).toBe("running");
      await until("background", "exited", 8_000);
    });

    it("stops at its lifetime however busy it is — the backstop behind the host's retirement", async () => {
      const lifetime = new Sandboxes({ prefix: "nsbx-self", idleTimeoutMs: 0, maxLifetimeMs: 2_000, housekeeping: false, root: alone.root });
      const box = await lifetime.create("forever", { replace: true });
      await box.exec("sleep 60 >/dev/null 2>&1 &");
      await until("forever", "exited", 8_000);
    });

    it("restarts on the next create, workspace intact, and stops itself again", async () => {
      const box = await alone.create("quiet");
      await box.writeFile("/kept.txt", "warm cache");
      expect((await box.exec("cat kept.txt")).stdout.trim()).toBe("warm cache");
      await until("quiet", "exited", 6_000);
    });

    it("stops promptly when asked, rather than waiting out its grace", async () => {
      const box = await alone.create("prompt", { replace: true, idleTimeoutMs: 60_000 });
      const started = Date.now();
      await box.stop(10_000);
      // A shell as PID 1 ignores SIGTERM unless it traps it; untrapped, this took the full 10s.
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("says which kind of main process a sandbox has", async () => {
      await alone.create("labelled", { replace: true });
      const legacy = new Sandboxes({ prefix: "nsbx-self", selfStop: false, housekeeping: false, root: alone.root });
      await legacy.create("old-style", { replace: true });
      const inspect = async (name: string) => {
        const id = (await alone.list()).find((s) => s.name === name)!.id;
        return alone.engine.call<{ Config: { Labels: Record<string, string>; Cmd: string[] } }>("GET", `/containers/${id}/json`);
      };
      const selfStopping = await inspect("labelled");
      expect(selfStopping?.Config.Labels["nativesandbox.selfStop"]).toBe("1");
      expect(selfStopping?.Config.Cmd.slice(0, 2)).toEqual(["sh", "-c"]);
      const old = await inspect("old-style");
      expect(old?.Config.Labels["nativesandbox.selfStop"]).toBe("0");
      expect(old?.Config.Cmd).toEqual(["sleep", "infinity"]);
    });

    it("works under a read-only root, which it writes nothing to", async () => {
      const ro = new Sandboxes({ prefix: "nsbx-self", idleTimeoutMs: 2_000, housekeeping: false, root: alone.root, hardening: { readOnlyRoot: true } });
      const box = await ro.create("readonly", { replace: true });
      await box.exec("true");
      await until("readonly", "exited", 6_000);
    });
  });

  describe("hardening — what is taken away from every sandbox", () => {
    // The container-side answer to "process isolation, not hardware isolation": each of these
    // removes something a kernel escape would need. They are only worth having if the real
    // workload survives them, so that is asserted alongside.
    it("drops every capability and forbids gaining privileges, by default", async () => {
      const box = await sandboxes.create(NAME);
      const caps = (await box.exec("grep CapEff /proc/self/status")).stdout.trim().split(/\s+/)[1];
      expect(caps).toBe("0000000000000000");
      const nnp = (await box.exec("grep NoNewPrivs /proc/self/status")).stdout.trim().split(/\s+/)[1];
      expect(nnp).toBe("1");
    });

    it("and a build still runs under that", async () => {
      const box = await sandboxes.create(NAME);
      await box.writeFile("/package.json", JSON.stringify({ name: "x", dependencies: { "is-odd": "3.0.1" } }));
      const result = await box.exec("npm install --no-audit --no-fund", { timeoutMs: 120_000 });
      expect(result.code).toBe(0);
      expect(box.exists("/node_modules/is-odd/package.json")).toBe(true);
    });

    it("can mount the image read-only, at the cost of root links", async () => {
      const ro = new Sandboxes({ prefix: "nsbx-ro", idleTimeoutMs: 0, maxLifetimeMs: 0, hardening: { readOnlyRoot: true } });
      try {
        const box = await ro.create("ro");
        expect((await box.exec("touch /etc/x")).code).not.toBe(0);
        // The workspace and /tmp are the writable exceptions; a build needs both.
        expect((await box.exec("touch /workspace/ok /tmp/ok")).code).toBe(0);
        // The documented trade: nothing can be linked at the root.
        expect((await box.exec("ln -s /workspace/src /src")).code).not.toBe(0);
      } finally {
        ro.close();
        await ro.removeAll();
        rmSync(ro.root, { recursive: true, force: true });
      }
    });
  });

  describe("/dev/shm — what a browser needs", () => {
    // Read from the mount table rather than `df`, which busybox and coreutils format differently.
    const shmBytes = async (box: { exec: (c: string) => Promise<{ stdout: string }> }) => {
      const line = (await box.exec("grep ' /dev/shm ' /proc/mounts")).stdout;
      const size = line.match(/size=(\d+)k/);
      return size ? Number(size[1]) * 1024 : null;
    };

    it("applies the size it was given, and records it", async () => {
      const box = await sandboxes.create(NAME, { shmSize: MiB(128), replace: true });
      expect(await shmBytes(box)).toBe(128 * 1024 * 1024);
      const listed = await sandboxes.engine.call<{ Config: { Labels: Record<string, string> } }>("GET", `/containers/${box.id}/json`);
      expect(listed?.Config.Labels["nativesandbox.shmSize"]).toBe("128");
    });

    it("is a capacity: a sandbox with enough is reused, one with too little is rebuilt", async () => {
      const big = await sandboxes.create(NAME, { shmSize: MiB(128) });
      expect((await sandboxes.create(NAME, { shmSize: MiB(64) })).id).toBe(big.id);
      expect((await sandboxes.create(NAME, { shmSize: MiB(256) })).id).not.toBe(big.id);
    });

    it("gives the browser runtime its default without being asked", async () => {
      // The browser image itself is not needed to prove the default is applied; any image will do.
      const local = new Sandboxes({ prefix: "nsbx-shm", selfStop: false, images: { browser: "docker.io/library/node:22-alpine" } });
      try {
        const box = await local.create("browser", { runtime: "browser" });
        expect(await shmBytes(box)).toBe(512 * 1024 * 1024);
      } finally {
        local.close();
        await local.removeAll();
        rmSync(local.root, { recursive: true, force: true });
      }
    });
  });

  describe("pulling ahead", () => {
    it("pulls a runtime's image and says which", async () => {
      expect(await sandboxes.pull(["node"])).toEqual(["docker.io/library/node:22-alpine"]);
    });
  });

  describe("maximum lifetime — nothing lives forever", () => {
    it("retires a sandbox past its ceiling but keeps its workspace", async () => {
      const short = new Sandboxes({ prefix: "nsbx-life", idleTimeoutMs: 0, maxLifetimeMs: 1_000, selfStop: false });
      try {
        const box = await short.create("life");
        await box.writeFile("/kept.txt", "warm cache");
        const id = box.id;

        expect(await short.retireExpired()).toEqual([]);
        // Past the ceiling, measured from the engine's creation time — so it holds across
        // processes, unlike anything tracked in memory.
        expect(await short.retireExpired(Date.now() + 2_000)).toEqual(["life"]);
        expect((await short.list()).some((s) => s.name === "life")).toBe(false);

        // The next create is a FRESH container over the SAME workspace.
        const again = await short.create("life");
        expect(again.id).not.toBe(id);
        expect((await again.exec("cat kept.txt")).stdout.trim()).toBe("warm cache");
      } finally {
        short.close();
        await short.removeAll();
        rmSync(short.root, { recursive: true, force: true });
      }
    });

    it("lets a command in flight finish rather than killing it mid-build", async () => {
      const short = new Sandboxes({ prefix: "nsbx-life", idleTimeoutMs: 0, maxLifetimeMs: 1_000, selfStop: false });
      try {
        const box = await short.create("busy");
        const running = box.exec("sleep 1.5; echo finished");
        await new Promise((r) => setTimeout(r, 200));
        expect(await short.retireExpired(Date.now() + 60_000)).toEqual([]);
        expect((await running).stdout.trim()).toBe("finished");
      } finally {
        short.close();
        await short.removeAll();
        rmSync(short.root, { recursive: true, force: true });
      }
    });
  });

  describe("per-sandbox deadlines — set at the call site, not only per instance", () => {
    it("honours a sandbox's own idle timeout over the instance default", async () => {
      // The instance would never stop this one; the sandbox asked to be stopped in a second.
      const box = await sandboxes.create("own-idle", { idleTimeoutMs: 1_000 });
      try {
        const info = (await sandboxes.list()).find((s) => s.name === "own-idle");
        expect(info?.idleTimeoutMs).toBe(1_000);

        expect(await sandboxes.stopIdle()).toEqual([]);
        expect(await sandboxes.stopIdle(Date.now() + 2_000)).toEqual(["own-idle"]);
        // Stopped, not removed — the workspace and whatever it held survive.
        expect((await sandboxes.list()).find((s) => s.name === "own-idle")?.state).not.toBe("running");
      } finally {
        await sandboxes.remove("own-idle");
      }
    });

    it("honours a sandbox's own maximum lifetime over the instance default", async () => {
      await sandboxes.create("own-life", { maxLifetimeMs: 1_000, idleTimeoutMs: 0 });
      try {
        expect(await sandboxes.retireExpired()).toEqual([]);
        expect(await sandboxes.retireExpired(Date.now() + 2_000)).toEqual(["own-life"]);
      } finally {
        await sandboxes.remove("own-life");
      }
    });

    it("records the deadlines on the container, so another process sweeps by the same clock", async () => {
      await sandboxes.create("recorded", { idleTimeoutMs: 1_000, maxLifetimeMs: 2_000, stopGraceMs: 3_000 });
      try {
        // A SEPARATE instance, with defaults that would never retire anything.
        const other = new Sandboxes({ prefix: "nsbx-test", root: sandboxes.root, idleTimeoutMs: 0, maxLifetimeMs: 0 });
        try {
          const seen = (await other.list()).find((s) => s.name === "recorded");
          expect(seen).toMatchObject({ idleTimeoutMs: 1_000, maxLifetimeMs: 2_000, stopGraceMs: 3_000 });
          expect(await other.retireExpired(Date.now() + 5_000)).toEqual(["recorded"]);
        } finally {
          other.close();
        }
      } finally {
        await sandboxes.remove("recorded");
      }
    });

    it("rebuilds rather than hand back a sandbox entitled to outlive the ceiling just asked for", async () => {
      const roomy = await sandboxes.create("ceiling", { maxLifetimeMs: 60 * 60 * 1000 });
      try {
        // Capacities meet-or-exceed, so a smaller memory ask reuses.
        const reused = await sandboxes.create("ceiling", { maxLifetimeMs: 60 * 60 * 1000, memory: MiB(256) });
        expect(reused.id).toBe(roomy.id);

        // Ceilings meet-or-UNDERCUT: an hour's entitlement does not serve a caller asking for
        // a minute, so it is rebuilt.
        const tight = await sandboxes.create("ceiling", { maxLifetimeMs: 60_000 });
        expect(tight.id).not.toBe(roomy.id);

        // And the other way round is fine: stopping sooner than asked is harmless, because the
        // next create starts it again.
        const loose = await sandboxes.create("ceiling", { maxLifetimeMs: 60 * 60 * 1000 });
        expect(loose.id).toBe(tight.id);
      } finally {
        await sandboxes.remove("ceiling");
      }
    });
  });

  describe("replace — the escape hatch from reuse", () => {
    it("discards the sandbox and its workspace, however well it matched", async () => {
      const first = await sandboxes.create("replaced");
      await first.writeFile("/state.txt", "from the old one");
      try {
        // Same spec: reuse would normally hand back the very same container.
        const fresh = await sandboxes.create("replaced", { replace: true });
        expect(fresh.id).not.toBe(first.id);
        expect(await fresh.exists("/state.txt")).toBe(false);
      } finally {
        await sandboxes.remove("replaced");
      }
    });

    it("is an action, not a property — it does not make the next create replace again", async () => {
      const fresh = await sandboxes.create("once", { replace: true });
      try {
        expect(await sandboxes.create("once")).toMatchObject({ id: fresh.id });
        // Nothing about it is recorded on the sandbox.
        const info = (await sandboxes.list()).find((s) => s.name === "once");
        expect(info).toBeDefined();
        expect(JSON.stringify(info)).not.toContain("replace");
      } finally {
        await sandboxes.remove("once");
      }
    });

    it("works when there is nothing to replace", async () => {
      await sandboxes.remove("absent").catch(() => false);
      const box = await sandboxes.create("absent", { replace: true });
      try {
        expect((await box.exec("echo new")).stdout.trim()).toBe("new");
      } finally {
        await sandboxes.remove("absent");
      }
    });
  });

  describe("listing and removal", () => {
    it("lists its own sandboxes and nothing else", async () => {
      await sandboxes.create(NAME);
      const listed = await sandboxes.list();
      expect(listed.some((s) => s.name === NAME)).toBe(true);
      // Scoped by label, so a sweep can never touch a container it did not create.
      expect(listed.every((s) => s.name !== "")).toBe(true);
    });

    it("removes the sandbox and its workspace", async () => {
      await sandboxes.create(NAME);
      expect(await sandboxes.remove(NAME)).toBe(true);
      expect((await sandboxes.list()).some((s) => s.name === NAME)).toBe(false);
      // Removing something that is already gone is not an error.
      expect(await sandboxes.remove(NAME)).toBe(false);
    });
  });
});

describe("the images this package builds", () => {
  it("are tagged with this package's version, so a release and its images move together", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    for (const runtime of ["node-python", "media", "browser"]) {
      expect(DEFAULT_IMAGES[runtime]).toBe(`ghcr.io/davmixcool/nativesandbox-${runtime}:${version}`);
    }
  });
});

describe("without an engine", () => {
  it("says where it looked and how to fix it", async () => {
    const missing = new Sandboxes({ socketPath: "/tmp/nativesandbox-does-not-exist.sock" });
    const check = await missing.check();
    expect(check.ok).toBe(false);
    // ECONNREFUSED on an unfamiliar path is a poor way to learn that a per-user socket died
    // with the login session.
    expect(check.problem).toMatch(/podman\.socket|enable-linger|DOCKER_HOST/);
  });
});
