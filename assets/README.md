# brand

Source for nativesandbox's mark, favicons, app icons, social avatars and OG card,
built with the `web-brand` skill.

Build inputs, not a deployable. There is no binary master: the mark is geometry
in `build-config.mjs`, and every size is rasterised from it.

## Regenerating

```sh
nvm use 22          # the generator needs 20+
npm install
npm run build
```

That writes two places:

| Path | Tracked? | Why |
|---|---|---|
| `dist/` | **no** — gitignored | The full kit: avatars, lockups, the X banner, the OG card, single-colour marks. Regenerate when you need one. |
| `../docs/assets/` | **yes** | The docs logo, icon and favicon. Mintlify serves them from the repo, so they have to exist in a fresh clone. |

So changing the mark means running `npm run build` **and committing
`../docs/assets/`**. `dist/` alone changes nothing that ships.

## The vector pair

`build-svg.mjs` writes `icon.svg` (the mark) and `logo.svg` (mark + wordmark)
from the same geometry the rasteriser uses — a docs header, a README, a nav bar
and a retina display all want vectors rather than a PNG at a guessed size.

**Neither file needs a font.** The wordmark is committed as outlines in
`wordmark.json`. It matters because an SVG loaded through `<img>` is isolated —
it cannot fetch a webfont, so a `<text>` element would render in whatever face
the viewer happened to have installed.

`tools/make-wordmark.py` is what produced those outlines, from Inter SemiBold
via fontTools and HarfBuzz. It is **not** part of `npm run build`: the outlines
are data now, and nothing that rasterises the kit needs Python or a font file.
Run it only if the word itself changes. Inter is SIL OFL, which permits
shipping outlines like this.

The PNG lockups, banner and OG card are a different matter — they set live text
and pull Inter from Google Fonts at render time. Offline they silently fall back
to `system-ui` and the run still *succeeds*, which is what makes it easy to
miss. Check `dist/og-1200x630.png` if a lockup looks wrong.

## The mark

A hexagon with a shell prompt — `>_` — knocked out of it. A container, and what
the container is for.

Four constraints are load-bearing, and all four were found by rendering rather
than by reading:

- **It must not be a rounded square.** The generator composites the mark onto a
  rounded square tile for avatars and launcher icons, so a rounded square mark
  produces a square inside a square and reads as a framing mistake. A hexagon is
  also the shape this industry already reads as "a container".
- **The hexagon and its holes must be one path.** The generator emits each array
  entry as its own `<path>`, and separate elements cannot cut holes in one
  another — winding only resolves inside a single `d`. Listed separately, the
  prompt vanishes and the mark renders as a solid hexagon.
- **The two holes must not touch.** Under nonzero winding the outline counts +1
  and each hole −1, so a hole is transparent at 0 — but where two holes overlap
  the count reaches −1 again and the overlap fills back in. The chevron is drawn
  as one six-point polygon for exactly this reason: two bars meeting at an apex
  would put a solid wedge at the point. `build-config.mjs` asserts the chevron
  and the underscore stay apart rather than trusting the drawing. Even-odd fill
  does not fix this; only a true union would, which is not worth the geometry
  here.
- **The drawn bounds are measured, not assumed.** Rounding the corners moves
  them: the top vertex sits at y=6, but the quadratic that replaces it peaks at
  10.5. `artBounds` is computed by sampling the curves, and the lockup and the
  favicon both crop to it. Hard-coding the vertex hangs the wordmark off a
  baseline the mark never reaches.

Corners are quadratics rather than arcs. An arc carries a sweep flag that has to
agree with the winding direction, so the same drawing would need two variants to
serve as both an outline and a hole; a quadratic has no handedness and
reversing the point order is enough.

The mark is single-colour on purpose: a silhouette with holes inverts correctly
on any ground, so one drawing serves a near-white mark on an ink tile and an ink
mark on paper. `dist/mark-accent-1024.png` exists for the occasions that want a
sand one.

## The small cut

`markSmall` is the same hexagon with a **fatter chevron and no underscore**,
used for the 16px favicon and the apple-touch icon.

At 16px the whole mark is about a dozen pixels across. The underscore is 24
units on a 200 grid — under two pixels — and it smears into the chevron rather
than reading as anything. The chevron then has to carry the mark alone, and
rendered side by side at true size, a 34-unit chevron was a smudge where a
44-unit one still reads. The apple-touch icon uses the same cut at 180px and
carries the heavier chevron perfectly well.

Always look at `dist/favicon-16x16.png` at 8× before deciding it was fine.

## The favicon is transparent

`build-favicon.mjs` runs last and **replaces** five files the skill's rasteriser
wrote as an opaque tile: `favicon.svg`, `favicon.ico` and the 16/32/48 PNGs.
They carry the mark alone, so it sits on whatever the browser's tab bar happens
to be rather than bringing its own dark slab.

A tile answered the light/dark question by containing it. Transparent, it has to
be answered:

- **`favicon.svg` adapts.** An SVG favicon may carry a stylesheet, and Chrome,
  Firefox and Safari 16.4+ honour `prefers-color-scheme` inside one — ink on a
  light tab, near-white on a dark one.
- **The PNG and ICO cannot**, so they are ink. That suits where they are
  actually used: Google Search renders favicons on white, and browsers old
  enough to ignore the SVG have light chrome. On a dark tab bar in such a
  browser the mark will be faint, and no one-colour raster avoids that.

**`apple-touch-icon.png` and `android-chrome-*.png` keep their tile on purpose.**
They are launcher icons, and iOS composites a transparent PNG onto **black** —
an ink mark on a black home screen is an invisible app.

## The palette

| Token | Value | On ink | Where |
|---|---|---|---|
| `ink` | `#0b1014` | — | Dark ground, and the mark on light |
| `light` | `#f7f8f8` | 17.97:1 | Light ground, and the mark on dark |
| `accent` | `#f2a33c` | 9.18:1 | Sand — for a sandbox |
| `muted` | `#8b949e` | 6.22:1 | Secondary copy |
| `onDark` | `#e9edf0` | 16.24:1 | Primary copy on dark |

The accent is the one warm note in a palette of slate, and it is sand for the
obvious reason. At 9.18:1 on the ink tile it survives being a small detail at a
small size, which the blue most infrastructure projects reach for does not.

**The bright sand is a dark-ground colour only.** On the light ground it is
1.96:1 — fine as a large fill, unreadable as text or a link, and nowhere near
the 4.5:1 that body-sized text needs. Anywhere it has to sit on light, use the
deeper cut:

| Token | Value | On light | Where |
|---|---|---|---|
| `accentDeep` | `#a3610b` | 4.62:1 | Links and small text on a light ground |

Same hue, walked down in lightness until it cleared the threshold. The pair is
what the docs theme wants: `accentDeep` as the light-mode primary, `accent` as
the dark-mode one.
