#!/usr/bin/env node
/**
 * The nativesandbox CLI.
 *
 * Deliberately NOT an installer for a runtime of our own — there isn't one. A microVM tool needs
 * a CLI because it ships a binary and a kernel that have to be downloaded and version-matched;
 * here the runtime is Podman or Docker, packaged by the distro. So this is three things: a
 * doctor, a way to apply what the doctor found, and enough fleet commands to see and clear what
 * a library run left behind.
 *
 * Argument parsing is hand-rolled to keep the package at zero dependencies. The surface is small
 * enough that a parser library would be the larger cost.
 */
import { readFileSync } from "node:fs";
import { Sandboxes } from "./runtime.js";
import { SandboxError } from "./errors.js";
import { MiB } from "./units.js";
import { diagnose, fixesFrom } from "./cli/doctor.js";
import { applyFixes } from "./cli/setup.js";
import { bold, check, cyan, dim, done, fatal, info, note, table, warn } from "./cli/output.js";

// Read, never restated. A hardcoded copy drifts from package.json the first time someone bumps
// one and not the other, and `nsbx --version` lying is worse than it not existing. The relative
// path is the same from `src/` during development and from `dist/` once built.
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const USAGE = `${bold("nativesandbox")} — sandboxes on any Linux host

${bold("Usage")}  nsbx <command> [options]

${bold("Host")}
  doctor            Check whether this host can run sandboxes, and what is wrong if not
    --deep            Also create a sandbox and prove the kernel holds a memory limit
  setup             Apply what doctor found, asking before each command
    --print           Show the commands and change nothing
    --yes             Run them without asking (for CI)

${bold("Sandboxes")}
  run <cmd>         Run a command in a throwaway sandbox, then remove it
    --name <n>        Name it, so --keep leaves something you can exec into
    --runtime <r>     node (default), python, node-python, media or browser
    --image <ref>     An explicit image, overriding --runtime
    --memory <MiB>    Default 512
    --cpus <n>        Default 1
    --network none    Cut the sandbox off from the network
    --keep            Leave the sandbox behind instead of removing it
  exec <name> <cmd> Run a command in an existing sandbox
  ls                List the sandboxes this runtime owns
  rm <name...>      Remove sandboxes and their workspaces
    --all             Every sandbox this runtime owns
  sweep             Stop idle sandboxes and retire expired ones
  pull              Pull runtime images now, rather than on a first command
    --runtime <r>     Only this runtime; repeat it for several (default: all)

${bold("Options")}
  --root <dir>      Where workspaces live on the host
  --prefix <p>      Only touch sandboxes with this prefix (default nsbx)
  --socket <path>   The engine socket, overriding auto-detection
  -h, --help        Show this
  -v, --version     Show the version
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** `--key value`, `--key=value` and `--flag`. Everything after `--` is positional, verbatim. */
function parse(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const takesValue = new Set(["name", "runtime", "image", "memory", "cpus", "network", "root", "prefix", "socket"]);

  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (literal) { positional.push(arg); continue; }
    if (arg === "--") { literal = true; continue; }

    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (!key) continue;
      if (inline !== undefined) flags[key] = inline;
      else if (takesValue.has(key) && argv[i + 1] !== undefined) flags[key] = argv[++i]!;
      else flags[key] = true;
    } else if (arg === "-h") flags.help = true;
    else if (arg === "-v") flags.version = true;
    else positional.push(arg);
  }

  return { command: positional.shift() ?? "", positional, flags };
}

const str = (flags: Args["flags"], key: string): string | undefined =>
  typeof flags[key] === "string" ? (flags[key] as string) : undefined;

function open(args: Args): Sandboxes {
  return new Sandboxes({
    ...(str(args.flags, "socket") ? { socketPath: str(args.flags, "socket")! } : {}),
    ...(str(args.flags, "root") ? { root: str(args.flags, "root")! } : {}),
    prefix: str(args.flags, "prefix") ?? "nsbx",
  });
}

// The deadlines are deliberately left at the library defaults rather than disabled. They are
// written onto the container, so a CLI that zeroed them would opt everything it created out of
// ever being reclaimed — `nsbx run --keep` would leak by design. Nothing sweeps behind the
// user's back regardless: the timer fires at a quarter of the soonest deadline, 75s by default,
// and every command here closes it long before that.

const ago = (date: Date): string => {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
};

// ── commands ──────────────────────────────────────────────────────────────

async function cmdDoctor(args: Args): Promise<number> {
  const report = await diagnose({ deep: args.flags.deep === true });

  info("platform", report.platform);
  info("version", VERSION);
  info("socket", `${report.socket}  ${dim(`(${report.socketReason})`)}`);
  console.log();

  for (const finding of report.findings) {
    check(finding.status, finding.label, finding.detail);
    if (finding.note) note(finding.note);
  }
  console.log();

  const fixes = fixesFrom(report);
  if (report.ready) {
    done("This host can run sandboxes.");
    if (fixes.length > 0) warn(`${fixes.length} thing${fixes.length === 1 ? "" : "s"} could still be improved — \`nsbx setup\`.`);
    return 0;
  }

  fatal("This host cannot run sandboxes yet.");
  if (fixes.length > 0) console.log(`  ${dim("Run")} ${cyan("nsbx setup")} ${dim("to fix")} ${fixes.length} ${dim("of them.")}`);
  return 1;
}

async function cmdSetup(args: Args): Promise<number> {
  const report = await diagnose({ deep: args.flags.deep === true });
  return applyFixes(fixesFrom(report), {
    assumeYes: args.flags.yes === true,
    printOnly: args.flags.print === true,
  });
}

async function cmdRun(args: Args): Promise<number> {
  const command = args.positional.join(" ").trim();
  if (!command) { fatal("nothing to run — `nsbx run \"node --version\"`"); return 2; }

  const sandboxes = open(args);
  const name = str(args.flags, "name") ?? `run-${process.pid}`;
  try {
    const box = await sandboxes.create(name, {
      ...(str(args.flags, "runtime") ? { runtime: str(args.flags, "runtime")! } : {}),
      ...(str(args.flags, "image") ? { image: str(args.flags, "image")! } : {}),
      ...(str(args.flags, "memory") ? { memory: MiB(Number(str(args.flags, "memory"))) } : {}),
      ...(str(args.flags, "cpus") ? { cpus: Number(str(args.flags, "cpus")) } : {}),
      ...(str(args.flags, "network") === "none" ? { network: "none" as const } : {}),
      replace: true,
    });

    // Streamed, not collected: a build should print as it goes, exactly as it would locally.
    const result = await box.exec(command, {
      onFrame: ({ kind, data }) => (kind === "stderr" ? process.stderr : process.stdout).write(data),
    });
    return result.code ?? 1;
  } finally {
    if (args.flags.keep === true) {
      console.log(dim(`\nkept: ${name} (${sandboxes.workspaceDir(name)})`));
    } else {
      await sandboxes.remove(name).catch(() => false);
    }
    sandboxes.close();
  }
}

async function cmdExec(args: Args): Promise<number> {
  const [name, ...rest] = args.positional;
  const command = rest.join(" ").trim();
  if (!name || !command) { fatal("usage: nsbx exec <name> <command>"); return 2; }

  const sandboxes = open(args);
  try {
    const existing = (await sandboxes.list()).find((s) => s.name === name);
    if (!existing) { fatal(`no sandbox named ${name} — \`nsbx ls\` shows what there is.`); return 1; }

    const box = await sandboxes.create(name);
    const result = await box.exec(command, {
      onFrame: ({ kind, data }) => (kind === "stderr" ? process.stderr : process.stdout).write(data),
    });
    return result.code ?? 1;
  } finally {
    sandboxes.close();
  }
}

async function cmdLs(args: Args): Promise<number> {
  const sandboxes = open(args);
  try {
    const all = await sandboxes.list();
    if (all.length === 0) { console.log(dim("  no sandboxes")); return 0; }

    table(
      all.map((s) => [
        s.name,
        s.state,
        s.image.replace(/^docker\.io\/library\//, ""),
        ago(s.createdAt),
        s.idleTimeoutMs ? `${Math.round(s.idleTimeoutMs / 1000)}s` : "off",
        s.maxLifetimeMs ? `${Math.round(s.maxLifetimeMs / 1000)}s` : "off",
      ]),
      ["NAME", "STATE", "IMAGE", "AGE", "IDLE", "MAX LIFE"],
    );
    return 0;
  } finally {
    sandboxes.close();
  }
}

async function cmdRm(args: Args): Promise<number> {
  const sandboxes = open(args);
  try {
    if (args.flags.all === true) {
      const removed = await sandboxes.removeAll();
      done(`removed ${removed}`);
      return 0;
    }
    if (args.positional.length === 0) { fatal("usage: nsbx rm <name...> | --all"); return 2; }

    let removed = 0;
    for (const name of args.positional) {
      if (await sandboxes.remove(name)) { console.log(`  removed ${name}`); removed += 1; }
      else console.log(dim(`  ${name} — not there`));
    }
    done(`removed ${removed}`);
    return 0;
  } finally {
    sandboxes.close();
  }
}

async function cmdPull(args: Args): Promise<number> {
  // Every --runtime given, not just the last: `pull --runtime node-python --runtime browser`.
  const argv = process.argv.slice(2);
  const runtimes = argv.flatMap((arg, i) =>
    arg === "--runtime" && argv[i + 1] ? [argv[i + 1]!] : arg.startsWith("--runtime=") ? [arg.slice(10)] : [],
  );
  const sandboxes = open(args);
  try {
    const pulled = await sandboxes.pull(runtimes.length > 0 ? runtimes : undefined);
    for (const image of pulled) console.log(`  pulled ${image}`);
    done(`${pulled.length} image${pulled.length === 1 ? "" : "s"} ready`);
    return 0;
  } finally {
    sandboxes.close();
  }
}

async function cmdSweep(args: Args): Promise<number> {
  // Deadlines come off the containers themselves, so this reclaims what other processes created
  // on their own terms rather than on this one's.
  const sandboxes = open(args);
  try {
    const { stopped, retired } = await sandboxes.sweep();
    if (stopped.length === 0 && retired.length === 0) { done("nothing to reclaim"); return 0; }
    if (stopped.length > 0) console.log(`  stopped  ${stopped.join(", ")}`);
    if (retired.length > 0) console.log(`  retired  ${retired.join(", ")}  ${dim("(workspaces kept)")}`);
    done(`${stopped.length} stopped, ${retired.length} retired`);
    return 0;
  } finally {
    sandboxes.close();
  }
}

// ── entry ─────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, (args: Args) => Promise<number>> = {
  doctor: cmdDoctor, setup: cmdSetup, run: cmdRun, exec: cmdExec,
  ls: cmdLs, list: cmdLs, rm: cmdRm, remove: cmdRm, sweep: cmdSweep, pull: cmdPull,
};

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));

  if (args.flags.version === true) { console.log(VERSION); return 0; }
  // Asking for help is a success. Being given nothing is not — that way `nsbx` in a script
  // fails loudly instead of printing usage and carrying on as if it had worked.
  if (args.flags.help === true) { console.log(USAGE); return 0; }
  if (!args.command) { console.log(USAGE); return 1; }

  const handler = COMMANDS[args.command];
  if (!handler) { fatal(`unknown command: ${args.command}`); console.log(`  ${dim("`nsbx --help` lists them.")}`); return 2; }

  try {
    return await handler(args);
  } catch (error) {
    if (error instanceof SandboxError) {
      fatal(error.message);
      // `unavailable` already carries the fix in its message; anything else is worth a pointer.
      if (error.code !== "unavailable") console.log(`  ${dim("Try")} ${cyan("nsbx doctor")}${dim(".")}`);
      return 1;
    }
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  (error: Error) => { fatal(error.stack ?? error.message); process.exit(1); },
);
