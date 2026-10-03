/**
 * Hold the documentation to the source.
 *
 * Mintlify's own checks cover structure, links and accessibility. This covers the thing that
 * actually rots: prose that was true when it was written. Every default, every exported symbol
 * and every error code below is read out of `../src` at audit time, so a change to the library
 * that the docs did not follow fails here rather than in someone's terminal.
 *
 * The docs live inside the package, so the source is always there. A missing `../src` is a
 * failure, not a reason to skip — a check that quietly disables itself is worse than no check.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, '..', 'src');
const failures = [];
const fail = (message) => failures.push(message);

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(full));
    else files.push(full);
  }
  return files;
}

const readSource = async (name) => {
  try {
    return await readFile(join(src, name), 'utf8');
  } catch {
    fail(`Cannot read ../src/${name} — the audit cannot verify the docs against the library`);
    return '';
  }
};

const files = await filesUnder(root);
const textFiles = files.filter((file) => ['.json', '.md', '.mdx', '.mjs', '.yml', '.yaml'].includes(extname(file)));
const publicTextFiles = textFiles.filter(
  (file) => !file.endsWith('scripts/audit.mjs') && !file.endsWith('package-lock.json'),
);
const publicMdxFiles = publicTextFiles.filter((file) => extname(file) === '.mdx');
const allProse = (await Promise.all(publicMdxFiles.map((f) => readFile(f, 'utf8')))).join('\n');

// ── 1. nothing from the scaffold this site was cloned from ────────────────
const forbidden = [
  { pattern: /scrinly/iu, label: 'the scaffold this site was cloned from' },
  { pattern: /boostgpt/iu, label: 'an unrelated product name' },
  { pattern: /\bmicrosandbox\b/iu, label: 'a competitor named directly — describe the constraint, not the product' },
  { pattern: /\bplaygrounds?\b/iu, label: 'a feature this project does not have' },
  { pattern: /\bapi[_-]?key\b/iu, label: 'a credential concept this library does not have' },
];
for (const file of publicTextFiles) {
  const content = await readFile(file, 'utf8');
  for (const { pattern, label } of forbidden) {
    if (pattern.test(content)) fail(`${relative(root, file)} mentions ${label}`);
  }
  const fenced = [...content.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].map((m) => m[1]).join('\n');
  for (const secret of [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu, /\bAKIA[0-9A-Z]{16}\b/gu, /gh[pousr]_[A-Za-z0-9]{20,}/gu]) {
    if (secret.test(fenced)) fail(`${relative(root, file)} appears to contain a real credential in an example`);
  }
}

// ── 2. every exported symbol is documented, and nothing invented ──────────
const index = await readSource('index.ts');
const exported = [...index.matchAll(/^export(?: type)? \{([^}]+)\}/gmu)]
  .flatMap((m) => m[1].split(','))
  .map((name) => name.trim().split(/\s+as\s+/u).pop())
  .filter(Boolean);

if (exported.length === 0) fail('Parsed no exports from ../src/index.ts — the parser is broken, not the docs');
for (const name of exported) {
  if (!allProse.includes(name)) fail(`Exported symbol is undocumented: ${name}`);
}

// ── 3. documented defaults match DEFAULTS ─────────────────────────────────
const runtime = await readSource('runtime.ts');
const defaults = runtime.match(/const DEFAULTS = \{[\s\S]*?\n\};/u)?.[0] ?? '';
const numeric = (key) => {
  const raw = defaults.match(new RegExp(`${key}:\\s*([^,\\n]+)`, 'u'))?.[1];
  if (!raw) return null;
  try {
    // The source writes these as expressions — `5 * 60 * 1000`, `MiB(512)`, `10_000`.
    return Number(new Function(`const MiB = (n) => n; return ${raw.replace(/\s*as const$/u, '')};`)());
  } catch {
    return null;
  }
};

const reference = await readFile(join(root, 'api-reference', 'sandboxes.mdx'), 'utf8');
for (const key of ['idleTimeoutMs', 'maxLifetimeMs', 'stopGraceMs']) {
  const value = numeric(key);
  if (value === null) { fail(`Could not read DEFAULTS.${key} from the source`); continue; }
  const row = reference.match(new RegExp(`\`${key}\`[^\\n]*`, 'u'))?.[0] ?? '';
  if (!row.includes(`\`${value}\``)) fail(`api-reference/sandboxes.mdx states the wrong default for ${key}: want ${value}`);
}
for (const [key, shown] of [['memory', 'MiB(512)'], ['cpus', '1'], ['pids', '512']]) {
  const value = numeric(key);
  if (value === null) fail(`Could not read DEFAULTS.${key} from the source`);
  if (!reference.includes(`\`${shown}\``)) fail(`api-reference/sandboxes.mdx no longer shows the ${key} default as ${shown}`);
}
if (numeric('memory') !== 512) fail(`DEFAULTS.memory is ${numeric('memory')} MiB but the docs say 512`);

for (const [flag, on] of [['dropCapabilities', 'true'], ['noNewPrivileges', 'true'], ['readOnlyRoot', 'false']]) {
  if (!new RegExp(`${flag}:\\s*${on}`, 'u').test(defaults)) {
    fail(`DEFAULTS.hardening.${flag} is no longer ${on}; the isolation guide and reference both say it is`);
  }
}

// ── 4. documented error codes match the union ─────────────────────────────
const errors = await readSource('errors.ts');
// The last member of the union ends with a semicolon; an anchored match without it silently
// drops one code and the audit passes while a code goes undocumented.
const codes = [...errors.matchAll(/^\s*\|?\s*"([a-z]+)";?$/gmu)].map((m) => m[1]);
if (codes.length === 0) fail('Parsed no error codes from ../src/errors.ts');

const errorsPage = await readFile(join(root, 'operations', 'errors.mdx'), 'utf8');
for (const code of codes) {
  if (!errorsPage.includes(`\`${code}\``)) fail(`Error code is undocumented: ${code}`);
}
for (const documented of [...errorsPage.matchAll(/^### `([a-z]+)`$/gmu)].map((m) => m[1])) {
  if (!codes.includes(documented)) fail(`operations/errors.mdx documents a code the source does not define: ${documented}`);
}
// `unsupported` has no throw site. The page says so; if that changes, the page must too.
// Matched anywhere inside the call, not just as the first argument: `gone` is produced by a
// ternary (`status === 404 ? "gone" : "engine"`), and a first-argument-only match misses it and
// then reports a thrown code as dead.
const sources = [runtime, errors, await readSource('engine.ts')].join('\n');
const thrown = new Set(
  codes.filter((code) => new RegExp(`SandboxError\\([^;]*?"${code}"`, 'su').test(sources)),
);
for (const code of codes) {
  const claimedReserved = new RegExp(`\`"?${code}"?\`[^\\n]*\\n?[^\\n]*[Nn]othing throws it`, 'u').test(errorsPage)
    || (code === 'unsupported' && /Nothing throws it today/u.test(errorsPage));
  if (!thrown.has(code) && !claimedReserved) fail(`${code} is never thrown but the docs do not say so`);
  if (thrown.has(code) && claimedReserved) fail(`${code} IS thrown now — remove the "reserved" note from operations/errors.mdx`);
}

// ── 4b. every CLI command is documented ───────────────────────────────────
// Same rot as an undocumented export, but worse: a command a user can type and cannot look up.
const cli = await readSource('cli.ts');
// `[^=]*` would stop at the `=>` inside the type annotation and match nothing.
const commandBlock = cli.match(/const COMMANDS[\s\S]*?= \{([\s\S]*?)\n\};/u)?.[1] ?? '';
const commands = [...commandBlock.matchAll(/(\w+):\s*cmd\w+/gu)].map((m) => m[1]);
if (commands.length === 0) fail('Parsed no CLI commands from ../src/cli.ts');
for (const command of commands) {
  if (!new RegExp(`\`(?:nsbx |npx nativesandbox )?${command}\``, 'u').test(allProse)
      && !new RegExp(`^## \`${command}\``, 'mu').test(allProse)) {
    fail(`CLI command is undocumented: ${command}`);
  }
  // Shown in the form the CLI's own --help uses. `npx nativesandbox …` is correct but is the
  // install-free alternative, not the canonical spelling; docs that drift to it stop matching
  // the tool they document. Aliases are not required to appear.
  const canonical = new RegExp(`^\\s*nsbx ${command}\\b`, 'mu');
  const aliases = ['list', 'remove'];
  if (!aliases.includes(command) && !canonical.test(allProse)) {
    fail(`CLI command is never shown as \`nsbx ${command}\` — the docs should match the tool's own usage line`);
  }
}

// The flags the CLI advertises in its own --help must exist in the docs too.
const usage = cli.match(/const USAGE = `([\s\S]*?)`;/u)?.[1] ?? '';
for (const [, flag] of usage.matchAll(/^\s{4}(--[a-z-]+)/gmu)) {
  if (!allProse.includes(flag)) fail(`CLI flag is in --help but not in the docs: ${flag}`);
}

// ── 5. constants quoted in prose match the source ─────────────────────────
const workspace = runtime.match(/export const WORKSPACE = "([^"]+)"/u)?.[1];
if (!workspace) fail('Could not read WORKSPACE from the source');
else if (!allProse.includes(`\`${workspace}\``)) fail(`Docs never mention the workspace mount point ${workspace}`);

for (const [, , image] of runtime.matchAll(/^\s+(node|python): "([^"]+)"/gmu)) {
  if (!allProse.includes(image)) fail(`Default image is undocumented: ${image}`);
}
// The built images carry the package version in a template literal; the docs name the repository.
const built = [...runtime.matchAll(/^\s+"?(node-python|media|browser)"?: `([^:`]+):\$\{VERSION\}`/gmu)];
if (built.length !== 3) fail(`Expected the node-python, media and browser images in DEFAULT_IMAGES, found ${built.length}`);
for (const [, name, image] of built) {
  if (!allProse.includes(image)) fail(`Built image is undocumented: ${image}`);
  if (!allProse.includes(`\`${name}\``)) fail(`Runtime is undocumented: ${name}`);
}

// ── 6. the site matches the brand ─────────────────────────────────────────
const docs = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8'));
if (docs.name !== 'nativesandbox') fail('Mintlify product name must be nativesandbox');
if (docs.theme !== 'almond') fail('Mintlify theme must remain almond');

try {
  const brand = JSON.parse(await readFile(resolve(root, '..', 'assets', 'brand.config.json'), 'utf8'));
  // The bright sand is 1.96:1 on a light ground — unreadable as a link. The deep cut is the
  // light-mode primary, and nothing but the brand config gets to decide what either one is.
  if (docs.colors?.primary !== brand.colors.accentDeep) {
    fail(`docs.json primary ${docs.colors?.primary} is not the brand's accentDeep ${brand.colors.accentDeep}`);
  }
  if (docs.colors?.light !== brand.colors.accent) {
    fail(`docs.json light ${docs.colors?.light} is not the brand's accent ${brand.colors.accent}`);
  }
} catch (error) {
  if (error instanceof SyntaxError) throw error;
  fail('Cannot read ../assets/brand.config.json — run `npm run build` in assets/');
}

for (const asset of [docs.favicon, docs.logo?.light, docs.logo?.dark]) {
  if (!asset) { fail('docs.json is missing a logo or favicon'); continue; }
  try {
    await stat(join(root, asset.replace(/^\//u, '')));
  } catch {
    fail(`docs.json references a missing asset: ${asset}`);
  }
}

// ── 7. navigation points at real pages ────────────────────────────────────
const navigationText = JSON.stringify(docs.navigation ?? {});
for (const page of navigationText.matchAll(/"((?:getting-started|guides|operations|api-reference)\/[a-z0-9-]+|index|changelog)"/gu)) {
  try {
    if (!(await stat(join(root, `${page[1]}.mdx`))).isFile()) fail(`Navigation page is not a file: ${page[1]}`);
  } catch {
    fail(`Navigation page is missing: ${page[1]}`);
  }
}

const navigated = new Set([...navigationText.matchAll(/"([a-z0-9-]+(?:\/[a-z0-9-]+)?)"/gu)].map((m) => m[1]));
for (const file of publicMdxFiles) {
  const page = relative(root, file).replace(/\.mdx$/u, '');
  if (!navigated.has(page)) fail(`Page exists but is not in the navigation: ${page}`);
}

// ── 8. internal links and anchors resolve ─────────────────────────────────
// Mintlify's checker is the final authority, but a local absolute link should also fail the
// repository audit when a page or an anchor vanishes.
function headingSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-');
}

for (const sourceFile of publicMdxFiles) {
  const content = await readFile(sourceFile, 'utf8');
  const destinations = [
    ...content.matchAll(/\]\((\/[a-z0-9\-/#]+)\)/giu),
    ...content.matchAll(/\bhref=["'](\/[a-z0-9\-/#]+)["']/giu),
  ].map((match) => match[1]);

  for (const destination of destinations) {
    const [pathname, anchor] = destination.split('#');
    const page = pathname === '/' ? 'index' : pathname.replace(/^\//u, '').replace(/\/$/u, '');
    let targetContent;
    try {
      targetContent = await readFile(join(root, `${page}.mdx`), 'utf8');
    } catch {
      fail(`${relative(root, sourceFile)} links to missing page ${pathname}`);
      continue;
    }
    if (!anchor) continue;
    const anchors = new Set([...targetContent.matchAll(/^#{2,6}\s+(.+)$/gmu)].map((m) => headingSlug(m[1])));
    if (!anchors.has(anchor)) fail(`${relative(root, sourceFile)} links to missing anchor ${destination}`);
  }
}

if (failures.length) {
  console.error(`Documentation audit failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation audit passed: ${exported.length} exported symbols documented, `
  + `${codes.length} error codes, ${publicMdxFiles.length} pages.`,
);
