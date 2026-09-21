/**
 * Apply what `doctor` found — one command at a time, shown before it runs.
 *
 * This installs system packages and changes systemd units on a machine we do not own, so it
 * asks. Not a confirmation dialog for the whole batch: each command is printed, labelled with
 * whether it needs root, and answered individually, because a person who is happy to enable
 * lingering is not necessarily happy to have a package manager run.
 *
 * `--yes` exists for CI, where there is no one to ask. It is the caller saying so explicitly,
 * never a default.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Fix } from "./doctor.js";
import { bold, cyan, dim, done, fatal, warn, yellow } from "./output.js";

export interface SetupOptions {
  /** Answer yes to every command without asking. For CI. */
  assumeYes?: boolean;
  /** Print the commands and change nothing. */
  printOnly?: boolean;
}

function show(fix: Fix, index: number, total: number): void {
  console.log();
  console.log(`  ${dim(`[${index}/${total}]`)} ${bold(fix.what)}${fix.sudo ? yellow("  (needs sudo)") : ""}`);
  console.log(`  ${cyan(fix.command)}`);
}

export async function applyFixes(fixes: Fix[], options: SetupOptions = {}): Promise<number> {
  if (fixes.length === 0) {
    done("Nothing to do — the host is already set up.");
    return 0;
  }

  if (options.printOnly) {
    console.log(`\n${bold("Run these to finish setting up the host:")}`);
    for (const [i, fix] of fixes.entries()) show(fix, i + 1, fixes.length);
    console.log();
    return 0;
  }

  // Without a terminal there is no one to ask, and running anyway would be the thing this
  // command exists not to do.
  if (!options.assumeYes && !process.stdin.isTTY) {
    fatal("setup needs a terminal to ask before it changes anything.");
    console.log(`  ${dim("Use")} nsbx setup --print ${dim("to see the commands, or")} nsbx setup --yes ${dim("to run them unattended.")}`);
    return 1;
  }

  console.log(`\n${bold(`${fixes.length} change${fixes.length === 1 ? "" : "s"} to make:`)}`);

  const rl = options.assumeYes ? null : createInterface({ input: process.stdin, output: process.stdout });
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const [i, fix] of fixes.entries()) {
      show(fix, i + 1, fixes.length);

      if (rl) {
        const answer = (await rl.question(`  ${dim("run it?")} [y/N/q] `)).trim().toLowerCase();
        if (answer === "q") {
          warn("Stopped. Nothing further was run.");
          break;
        }
        if (answer !== "y" && answer !== "yes") {
          console.log(`  ${dim("skipped")}`);
          skipped += 1;
          continue;
        }
      }

      // Through a shell because the fixes are pipelines, and with inherited stdio so sudo can
      // read a password from the same terminal that just asked.
      const result = spawnSync("sh", ["-c", fix.command], { stdio: "inherit" });
      if (result.status === 0) {
        applied += 1;
      } else {
        failed += 1;
        fatal(`that command exited ${result.status ?? "abnormally"}.`);
      }
    }
  } finally {
    rl?.close();
  }

  console.log();
  const parts = [`${applied} applied`];
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  (failed ? warn : done)(parts.join(", ") + ".");
  if (applied > 0) console.log(`  ${dim("Run")} nsbx doctor ${dim("again to confirm.")}`);

  return failed > 0 ? 1 : 0;
}
