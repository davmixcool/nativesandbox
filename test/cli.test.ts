/**
 * The CLI, through the built binary.
 *
 * Spawned rather than imported: the entry point calls `process.exit`, resolves its own version
 * relative to its file, and is reached through a `bin` shim — none of which an in-process import
 * exercises. What a user hits is a process with an exit code, so that is what is asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Sandboxes } from "../src/index.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ROOT = "/tmp/nsbx-cli-test";
const PREFIX = "nsbx-clitest";

/** Exit code and output, without throwing on a non-zero exit — which is half of what we assert. */
async function nsbx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const engine = await new Sandboxes().check();

describe("the CLI", () => {
  describe("without touching an engine", () => {
    it("reports the version from package.json, not a copy of it", async () => {
      const { version } = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const { code, stdout } = await nsbx("--version");
      expect(code).toBe(0);
      // The point of the assertion: a hardcoded version would pass a test that only checked the
      // shape, and would be wrong the first time one of the two was bumped alone.
      expect(stdout.trim()).toBe(version);
    });

    it("lists every command it accepts in its own help", async () => {
      const { code, stdout } = await nsbx("--help");
      expect(code).toBe(0);
      for (const command of ["doctor", "setup", "run", "exec", "ls", "rm", "sweep", "pull"]) {
        expect(stdout).toContain(command);
      }
    });

    it("separates a usage error from a failure", async () => {
      // 2 for "you typed it wrong", 1 for "it went wrong" — so a script can tell them apart.
      expect((await nsbx("nope")).code).toBe(2);
      expect((await nsbx("run")).code).toBe(2);
      expect((await nsbx("exec", "only-a-name")).code).toBe(2);
      expect((await nsbx()).code).toBe(1);
    });

    it("says where it looked and how to fix it when there is no engine", async () => {
      const { code, stderr, stdout } = await nsbx("ls", "--socket", "/nonexistent.sock");
      expect(code).toBe(1);
      const all = stderr + stdout;
      expect(all).toContain("/nonexistent.sock");
      // The message carries the remedy, because ENOENT on an unfamiliar path teaches nobody
      // about `loginctl enable-linger`.
      expect(all).toContain("enable-linger");
    });
  });

  describe.skipIf(!engine.ok)("against a real engine", () => {
    afterAll(async () => {
      await nsbx("rm", "--root", ROOT, "--prefix", PREFIX, "--all");
      rmSync(ROOT, { recursive: true, force: true });
    });

    beforeAll(async () => {
      await nsbx("rm", "--root", ROOT, "--prefix", PREFIX, "--all");
    });

    it("runs a command, streams it, and removes the sandbox afterwards", async () => {
      const { code, stdout } = await nsbx("run", "--root", ROOT, "--prefix", PREFIX, "echo streamed");
      expect(code).toBe(0);
      expect(stdout).toContain("streamed");

      const list = await nsbx("ls", "--root", ROOT, "--prefix", PREFIX);
      expect(list.stdout).toContain("no sandboxes");
    });

    it("exits with the command's own status, so a script can branch on it", async () => {
      expect((await nsbx("run", "--root", ROOT, "--prefix", PREFIX, "exit 42")).code).toBe(42);
    });

    it("keeps a named sandbox, and can exec into it afterwards", async () => {
      await nsbx("run", "--root", ROOT, "--prefix", PREFIX, "--name", "kept", "--keep", "echo hi > f.txt");
      const listed = await nsbx("ls", "--root", ROOT, "--prefix", PREFIX);
      expect(listed.stdout).toContain("kept");

      const { code, stdout } = await nsbx("exec", "--root", ROOT, "--prefix", PREFIX, "kept", "cat f.txt");
      expect(code).toBe(0);
      expect(stdout).toContain("hi");
    });

    it("records real deadlines on what it creates, so a sweep can still reclaim it", async () => {
      // Regression: the CLI once passed 0 for both, which was written onto the container and
      // opted everything `--keep` left behind out of ever being reclaimed.
      const { stdout } = await nsbx("ls", "--root", ROOT, "--prefix", PREFIX);
      expect(stdout).toMatch(/\b300s\b/);
      expect(stdout).toMatch(/\b3600s\b/);
      expect(stdout).not.toContain("off");
    });

    it("doctor agrees the host works, and says kvm is not required", async () => {
      const { code, stdout } = await nsbx("doctor");
      expect(code).toBe(0);
      expect(stdout).toContain("container engine");
      expect(stdout).toContain("not required");
    });

    it("setup changes nothing on a host that is already set up", async () => {
      const { code, stdout } = await nsbx("setup", "--print");
      expect(code).toBe(0);
      expect(stdout).toContain("Nothing to do");
    });
  });
});
