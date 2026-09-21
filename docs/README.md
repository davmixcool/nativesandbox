# nativesandbox documentation

The public documentation site, built with [Mintlify](https://mintlify.com) and published at
[nativesandbox.dev](https://nativesandbox.dev).

## Local development

```bash
nvm use
npm ci
npm run dev
```

The preview runs at `http://localhost:3000`.

## Checks

```bash
npm test
```

Four checks, in order:

| | What it covers |
|---|---|
| `npm run validate` | Mintlify configuration and frontmatter |
| `npm run links` | Internal links, anchors and redirects |
| `npm run a11y` | Accessibility |
| `npm run audit` | **The docs against the library** — see below |

## The audit

`scripts/audit.mjs` reads `../src` and fails when the prose has drifted from the code. Mintlify's
own checks cover structure; this covers the thing that actually rots, which is a sentence that
was true when it was written.

It asserts that:

- every symbol exported from `src/index.ts` is mentioned somewhere in the docs
- every default quoted in the API reference matches `DEFAULTS` in `src/runtime.ts` — the idle
  timeout, the maximum lifetime, the stop grace, memory, CPUs, PIDs and all three hardening flags
- every code in the `SandboxErrorCode` union has a section in `operations/errors.mdx`, and no
  section documents a code that does not exist
- a code with **no throw site** is labelled as reserved, and one that gains a throw site loses
  that label
- the workspace mount point and both default images, as quoted in prose, match the source
- `docs.json` colours match `../assets/brand.config.json`, its logo and favicon exist on disk,
  and the light-mode primary is the deep accent rather than the bright one, which is 1.96:1 on
  a light ground
- every page is in the navigation and every navigation entry is a page
- every absolute internal link resolves, anchors included

The source is read at audit time rather than copied, so there is nothing to keep in sync. If
`../src` is unreadable the audit fails rather than skipping — a check that quietly disables
itself is worse than no check.

## Writing

Pages are MDX with Mintlify components. Two conventions worth keeping:

- **Anchors come from headings, so headings avoid parentheses.** A heading of `` ## `create` ``
  gives `#create`, while `` ## `create(name, spec?)` `` gives `#createname-spec`. Put the
  signature in a code block under the heading instead.
- **Quote defaults from the source, in backticks.** The audit matches on the backticked value,
  so `` `300000` `` is checked and "five minutes" is not.
