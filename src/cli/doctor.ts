/**
 * Is this host able to run a sandbox, and if not, what exactly is wrong?
 *
 * Every check reports the evidence it found rather than a verdict alone, because the failures
 * this catches are ones where the obvious reading is wrong:
 *
 *  - A memory limit the kernel ACCEPTS AND IGNORES looks identical to one it enforces, until you
 *    read `memory.max` from inside a sandbox. That is the only check here that proves anything,
 *    and it is the reason `--deep` exists.
 *  - A missing `Linger` breaks sandboxes at the next logout, not now, so the cause and the
 *    symptom are hours apart and nothing in between changed.
 *  - `/dev/kvm` is REPORTED AND NOT REQUIRED. Its absence is why this package exists, and a
 *    doctor that stayed silent about it would leave people looking for a virtualisation problem.
 */
import os from "node:os";
import { Sandboxes } from "../runtime.js";
import { defaultSocketPath } from "../engine.js";
import { MiB } from "../units.js";
import * as host from "./host.js";
import type { Status } from "./output.js";

export interface Fix {
  /** What this achieves, in the imperative. */
  what: string;
  command: string;
  sudo: boolean;
}

export interface Finding {
  status: Status;
  label: string;
  detail: string;
  // Explicitly `| undefined`: the config sets exactOptionalPropertyTypes, so a computed value
  // that may be undefined cannot be assigned to a plain optional property.
  note?: string | undefined;
  fix?: Fix | undefined;
}

export interface Report {
  platform: string;
  socket: string;
  socketReason: string;
  findings: Finding[];
  /** Whether a sandbox can be created at all. Everything else is degradation, not a blocker. */
  ready: boolean;
}

const PROBE_IMAGE = "docker.io/library/alpine:latest";
const PROBE_NAME = "doctor-probe";
const PROBE_MEMORY = 64;

/** Why this socket and not another — the resolution order, made visible. */
function socketReason(): string {
  if (process.env.DOCKER_HOST) return "from $DOCKER_HOST";
  if (os.platform() === "linux") return "Podman's per-user socket";
  return "Docker's default socket";
}

async function imageCached(sandboxes: Sandboxes, reference: string): Promise<boolean> {
  const filters = encodeURIComponent(JSON.stringify({ reference: [reference] }));
  const found = await sandboxes.engine
    .call<unknown[]>("GET", `/images/json?filters=${filters}`)
    .catch(() => null);
  return Array.isArray(found) && found.length > 0;
}

/**
 * Create a real sandbox and read its cgroup back.
 *
 * The one check that cannot be faked by reading configuration. A host with delegation missing
 * reports the machine's total memory here, and every sandbox on it is unbounded.
 */
async function probeLimits(sandboxes: Sandboxes): Promise<Finding> {
  try {
    const box = await sandboxes.create(PROBE_NAME, { image: PROBE_IMAGE, memory: MiB(PROBE_MEMORY), network: "none" });
    try {
      const { stdout } = await box.exec("cat /sys/fs/cgroup/memory.max 2>/dev/null || echo unknown", {
        timeoutMs: 15_000,
      });
      const reported = stdout.trim();
      const want = PROBE_MEMORY * 1024 * 1024;

      if (reported === String(want)) {
        return { status: "ok", label: "limits enforced", detail: `memory.max is ${want} — the kernel is holding it` };
      }
      if (reported === "unknown" || reported === "max") {
        return {
          status: "warn",
          label: "limits enforced",
          detail: `the sandbox reports "${reported}"`,
          note: "Could not read the cgroup from inside. Limits may still hold; this check could not prove it.",
        };
      }
      return {
        status: "fail",
        label: "limits enforced",
        detail: `asked for ${want}, the sandbox sees ${reported}`,
        note: "The limit was accepted and ignored — every sandbox on this host is unbounded.",
        fix: {
          what: "Delegate cgroup controllers to your user slice",
          command:
            "sudo mkdir -p /etc/systemd/system/user@.service.d && "
            + "printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' | "
            + "sudo tee /etc/systemd/system/user@.service.d/delegate.conf && "
            + "sudo systemctl daemon-reload",
          sudo: true,
        },
      };
    } finally {
      await sandboxes.remove(PROBE_NAME).catch(() => false);
    }
  } catch (error) {
    return { status: "warn", label: "limits enforced", detail: (error as Error).message.split("\n")[0] ?? "probe failed" };
  }
}

export async function diagnose(options: { deep?: boolean } = {}): Promise<Report> {
  const socket = defaultSocketPath();
  const sandboxes = new Sandboxes({ socketPath: socket, prefix: "nsbx-doctor", idleTimeoutMs: 0, maxLifetimeMs: 0 });
  const findings: Finding[] = [];
  const linux = host.isLinux();

  // ── the engine ─────────────────────────────────────────────────────────
  const health = await sandboxes.check();
  const manager = host.packageManager();
  if (health.ok) {
    findings.push({ status: "ok", label: "container engine", detail: `reachable, version ${health.engine}` });
  } else {
    findings.push({
      status: "fail",
      label: "container engine",
      detail: `nothing at ${socket}`,
      note: health.problem?.split("\n")[0],
      fix: linux && manager
        ? { what: "Install Podman", command: host.installCommand(manager, "podman"), sudo: true }
        : undefined,
    });
  }

  if (linux) {
    // ── rootless prerequisites ───────────────────────────────────────────
    const socketActive = host.podmanSocketActive();
    if (socketActive === false) {
      findings.push({
        status: "fail",
        label: "podman socket",
        detail: "installed but not listening",
        fix: { what: "Start Podman's user socket now and at boot", command: "systemctl --user enable --now podman.socket", sudo: false },
      });
    } else if (socketActive === true) {
      findings.push({ status: "ok", label: "podman socket", detail: "active" });
    }

    const linger = host.lingering();
    if (linger === false) {
      findings.push({
        status: "fail",
        label: "lingering",
        detail: "off — the socket dies at logout",
        note: "Sandboxes will keep working until you log out, then stop for no visible reason.",
        fix: { what: "Keep your user's services running after logout", command: `loginctl enable-linger ${host.username()}`, sudo: false },
      });
    } else if (linger === true) {
      findings.push({ status: "ok", label: "lingering", detail: "on — survives logout" });
    }

    const controllers = host.delegatedControllers();
    const wanted = ["cpu", "memory", "pids"];
    if (!host.cgroupV2()) {
      findings.push({ status: "fail", label: "cgroups v2", detail: "not mounted — rootless limits are unavailable" });
    } else if (controllers === null) {
      findings.push({ status: "warn", label: "cgroup delegation", detail: "could not read your user slice" });
    } else {
      const missing = wanted.filter((c) => !controllers.includes(c));
      findings.push(missing.length === 0
        ? { status: "ok", label: "cgroup delegation", detail: controllers.join(" ") }
        : {
            status: "fail",
            label: "cgroup delegation",
            detail: `missing ${missing.join(", ")}`,
            note: "Without these, a memory or CPU limit is accepted and silently ignored.",
            fix: {
              what: "Delegate cgroup controllers to your user slice",
              command:
                "sudo mkdir -p /etc/systemd/system/user@.service.d && "
                + "printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' | "
                + "sudo tee /etc/systemd/system/user@.service.d/delegate.conf && "
                + "sudo systemctl daemon-reload",
              sudo: true,
            },
          });
    }

    const sub = host.hasSubordinateIds();
    if (sub === false) {
      findings.push({
        status: "fail",
        label: "subuid / subgid",
        detail: `no range for ${host.username()}`,
        fix: { what: "Give your user a subordinate id range", command: `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ${host.username()}`, sudo: true },
      });
    } else if (sub === true) {
      findings.push({ status: "ok", label: "subuid / subgid", detail: "present" });
    }

    const userns = host.userNamespaces();
    if (userns === false) {
      findings.push({
        status: "fail",
        label: "user namespaces",
        detail: "disabled",
        fix: { what: "Allow unprivileged user namespaces", command: "sudo sysctl -w user.max_user_namespaces=15000", sudo: true },
      });
    } else if (userns === true) {
      findings.push({ status: "ok", label: "user namespaces", detail: "enabled" });
    }

    findings.push({
      status: host.seccomp() ? "ok" : "warn",
      label: "seccomp",
      detail: host.seccomp() ? "available" : "not reported by the kernel",
    });
    findings.push({
      status: host.apparmor() ? "ok" : "warn",
      label: "apparmor",
      detail: host.apparmor() ? "enabled" : "absent (SELinux may cover this instead)",
    });
  } else {
    findings.push({
      status: "skip",
      label: "rootless checks",
      detail: `not applicable on ${os.platform()}`,
      note: "Containers are a Linux feature. Your engine is running them in a VM, which is fine for development.",
    });
  }

  // Deliberately last, and deliberately not a failure.
  findings.push({
    status: "ok",
    label: "/dev/kvm",
    detail: host.hasKvm() ? "present, and not required" : "absent, and not required",
    note: host.hasKvm() ? undefined : "This is the thing nativesandbox exists to do without.",
  });

  // ── the only check that proves anything ────────────────────────────────
  if (health.ok) {
    if (options.deep || (await imageCached(sandboxes, PROBE_IMAGE))) {
      findings.push(await probeLimits(sandboxes));
    } else {
      findings.push({
        status: "skip",
        label: "limits enforced",
        detail: "not verified",
        note: `Run \`nsbx doctor --deep\` to pull ${PROBE_IMAGE} and prove the kernel holds a limit.`,
      });
    }
  }

  sandboxes.close();

  return {
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    socket,
    socketReason: socketReason(),
    findings,
    ready: health.ok && !findings.some((f) => f.status === "fail"),
  };
}

export const fixesFrom = (report: Report): Fix[] =>
  report.findings.flatMap((f) => (f.fix ? [f.fix] : []));
