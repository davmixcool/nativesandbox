/**
 * The images in `images/`, run the way a caller runs them: under the default hardening, every capability dropped.
 *
 * Opt-in, because the images are built here and published later. `NATIVESANDBOX_IMAGE_TAG=dev` runs the local
 * builds (`docker build -t nativesandbox-<name>:dev images/<name>`); any other value runs the published images
 * at that tag, which is what CI does after pushing a release.
 */
import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { MiB, Sandboxes } from "../src/index.js";

const TAG = process.env.NATIVESANDBOX_IMAGE_TAG;
const image = (name: string) =>
  TAG === "dev" ? `nativesandbox-${name}:dev` : `ghcr.io/davmixcool/nativesandbox-${name}:${TAG}`;

const sandboxes = new Sandboxes({
  prefix: "nsbx-images",
  selfStop: false,
  images: { "node-python": image("node-python"), media: image("media"), browser: image("browser") },
});
const reachable = TAG ? (await sandboxes.check()).ok : false;

describe.skipIf(!reachable)("the images", () => {
  afterAll(async () => {
    sandboxes.close();
    await sandboxes.removeAll().catch(() => 0);
    rmSync(sandboxes.root, { recursive: true, force: true });
  });

  it("node-python: node and python in one sandbox, so a mixed chain runs", async () => {
    const box = await sandboxes.create("node-python", { runtime: "node-python" });
    const result = await box.exec(
      `python3 -c "open('/workspace/x.json','w').write('{\\"n\\": 2}')" && node -e "console.log(require('/workspace/x.json').n * 21)"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("42");
    for (const tool of ["npm -v", "python --version", "pip --version", "git --version"]) {
      expect((await box.exec(tool)).code, tool).toBe(0);
    }
  });

  it("media: ffmpeg makes a video and its poster, libvips resizes it", async () => {
    const box = await sandboxes.create("media", { runtime: "media" });
    const result = await box.exec(
      [
        "ffmpeg -loglevel error -f lavfi -i testsrc=size=640x360:rate=10 -t 1 -c:v libvpx-vp9 -b:v 0 -crf 40 clip.webm",
        "ffmpeg -loglevel error -i clip.webm -frames:v 1 poster.png",
        "vipsthumbnail poster.png --size 320x -o thumb.webp",
        "vipsheader thumb.webp",
      ].join(" && "),
      { timeoutMs: 120_000 },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/320x180/);
    expect(box.exists("/clip.webm")).toBe(true);
  });

  it("browser: Playwright drives Chromium with no install, catches a page error, and axe finds a violation", async () => {
    const box = await sandboxes.create("browser", { runtime: "browser", memory: MiB(1024) });
    await box.writeFile(
      "/check.mjs",
      `import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setContent('<html lang="en"><body><h1>Hi</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><script>throw new Error("boom")</script></body></html>');
await page.screenshot({ path: '/tmp/shot.png' });
const axe = await new AxeBuilder({ page }).analyze();
console.log(JSON.stringify({ errors, violations: axe.violations.map((v) => v.id) }));
await browser.close();
`,
    );
    const result = await box.exec("node check.mjs", { timeoutMs: 120_000 });
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split("\n").pop()!);
    expect(report.errors).toEqual(["boom"]);
    expect(report.violations).toContain("image-alt");
    expect((await box.exec("lighthouse --version")).code).toBe(0);
  });
});
