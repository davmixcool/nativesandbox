/**
 * What the host actually is, read rather than assumed.
 *
 * Every function here is read-only and returns `null` when it cannot tell the difference between
 * "no" and "cannot see" — a doctor that reports a confident "no" from a failed read sends people
 * to fix something that was never broken.
 */
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export const isLinux = (): boolean => os.platform() === "linux";

export const uid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

export const username = (): string => {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? "unknown";
  }
};

const read = (path: string): string | null => {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** A command's stdout, or null if it is missing or failed. Never throws, never inherits stdio. */
export function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export const exists = (path: string): boolean => fs.existsSync(path);

/** The cgroup v2 controllers delegated to this user's slice — what rootless limits depend on. */
export function delegatedControllers(): string[] | null {
  const id = uid();
  if (id === null) return null;
  const body = read(`/sys/fs/cgroup/user.slice/user-${id}.slice/user@${id}.service/cgroup.controllers`);
  return body === null ? null : body.trim().split(/\s+/).filter(Boolean);
}

export const cgroupV2 = (): boolean => exists("/sys/fs/cgroup/cgroup.controllers");

/** Whether the user has a subuid range, which rootless containers cannot work without. */
export function hasSubordinateIds(): boolean | null {
  const name = username();
  const check = (path: string) => {
    const body = read(path);
    return body === null ? null : body.split("\n").some((line) => line.startsWith(`${name}:`));
  };
  const u = check("/etc/subuid");
  const g = check("/etc/subgid");
  if (u === null || g === null) return null;
  return u && g;
}

export function userNamespaces(): boolean | null {
  const max = read("/proc/sys/user/max_user_namespaces");
  if (max === null) return null;
  return Number(max.trim()) > 0;
}

/**
 * Whether this user's systemd session survives logout.
 *
 * The single most confusing rootless failure: without it the per-user socket is torn down at
 * logout and sandboxes stop working hours later, with no deploy and no code change to blame.
 */
export function lingering(): boolean | null {
  const out = run("loginctl", ["show-user", username(), "--property=Linger"]);
  if (out === null) return null;
  return out.includes("yes");
}

export const podmanSocketActive = (): boolean | null => {
  const out = run("systemctl", ["--user", "is-active", "podman.socket"]);
  return out === null ? null : out === "active";
};

export const seccomp = (): boolean => (read("/proc/self/status") ?? "").includes("Seccomp");
export const apparmor = (): boolean => exists("/sys/kernel/security/apparmor");
export const hasKvm = (): boolean => exists("/dev/kvm");

export interface Distro {
  id: string;
  name: string;
  /** The family whose package manager applies, for hosts that only set ID_LIKE. */
  like: string[];
}

export function distro(): Distro | null {
  const body = read("/etc/os-release");
  if (body === null) return null;
  const field = (key: string) =>
    body.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.replace(/^"|"$/g, "") ?? "";
  const id = field("ID");
  if (!id) return null;
  return { id, name: field("PRETTY_NAME") || id, like: field("ID_LIKE").split(/\s+/).filter(Boolean) };
}

export type PackageManager = "apt" | "dnf" | "pacman" | "apk" | "zypper";

/** How to install a package here. Derived from ID, then ID_LIKE, then what is on PATH. */
export function packageManager(): PackageManager | null {
  const d = distro();
  const families: Record<string, PackageManager> = {
    debian: "apt", ubuntu: "apt", fedora: "dnf", rhel: "dnf", centos: "dnf",
    arch: "pacman", alpine: "apk", suse: "zypper", opensuse: "zypper",
  };
  for (const key of [d?.id, ...(d?.like ?? [])]) {
    if (key && families[key]) return families[key];
  }
  for (const [binary, manager] of [
    ["apt-get", "apt"], ["dnf", "dnf"], ["pacman", "pacman"], ["apk", "apk"], ["zypper", "zypper"],
  ] as const) {
    if (run("command", ["-v", binary]) || exists(`/usr/bin/${binary}`)) return manager;
  }
  return null;
}

export function installCommand(manager: PackageManager, pkg: string): string {
  switch (manager) {
    case "apt": return `sudo apt-get update && sudo apt-get install -y ${pkg}`;
    case "dnf": return `sudo dnf install -y ${pkg}`;
    case "pacman": return `sudo pacman -S --noconfirm ${pkg}`;
    case "apk": return `sudo apk add ${pkg}`;
    case "zypper": return `sudo zypper install -y ${pkg}`;
  }
}
