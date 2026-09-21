/**
 * Assemble the vector logo and icon.
 *
 * The web-brand skill produces PNGs; these are the same artwork as real vectors, for the places
 * that scale — a docs header, a nav bar, a README, a retina display.
 *
 * Neither file needs a font. The wordmark is committed as outlines in `wordmark.json`, converted
 * once by `tools/make-wordmark.py` from Inter SemiBold (SIL OFL, which permits it). An SVG that
 * referenced the font instead would render in whatever face the viewer happened to have — and
 * inside an <img> it cannot even reach the network to fetch one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, 'brand.config.json'), 'utf8'));
const wordmark = JSON.parse(fs.readFileSync(path.join(here, 'wordmark.json'), 'utf8'));

const MARK = config.mark.primary[0];
const INK = config.colors.ink;
const LIGHT = config.colors.light;

const [ARTX, ARTY, ARTW, ARTH] = config.artBounds;
const round = (n) => Number(n.toFixed(3));

const svg = (viewBox, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="none" role="img">\n${body}\n</svg>\n`;

/** The mark alone, cropped to its own ink so it drops into a layout without stray padding. */
const icon = (fill) =>
    svg(`${round(ARTX)} ${round(ARTY)} ${round(ARTW)} ${round(ARTH)}`, `  <path d="${MARK}" fill="${fill}"/>`);

/**
 * Mark + wordmark.
 *
 * Centred on the word's own ink box rather than on a cap height. "nativesandbox" is all
 * lowercase and has no descenders, so its ink box runs from the ascenders to a hair below the
 * baseline — the overshoot of the round letters — and centring on that is honest. A word WITH a
 * descender would sit visibly high this way and would need the cap-height treatment instead.
 */
const lockup = (fill) => {
    const H = 100;
    const scale = H / ARTH;
    const markW = ARTW * scale;

    const [xMin, yMin, xMax, yMax] = wordmark.bounds;
    // The word's ascender-to-overshoot height, as a fraction of the mark's. Tuned by looking at
    // the rendered lockup: the mark is a solid silhouette and reads heavier than lowercase text
    // of the same height, so the word is set well below full height.
    const inkHeight = H * 0.46;
    const fontScale = inkHeight / (yMax - yMin);
    const gap = H * 0.2;

    const wordX = markW + gap;
    // yMin is the topmost ink (SVG y-down, above the baseline), so this puts the baseline where
    // the ink box ends up centred on the mark.
    const baseline = (H - inkHeight) / 2 - yMin * fontScale;
    const total = round(wordX + (xMax - xMin) * fontScale);

    return svg(`0 0 ${total} ${H}`,
        `  <path transform="scale(${round(scale)}) translate(${round(-ARTX)} ${round(-ARTY)})" `
        + `d="${MARK}" fill="${fill}"/>\n`
        + `  <path transform="translate(${round(wordX)} ${round(baseline)}) `
        + `scale(${round(fontScale)}) translate(${round(-xMin)} 0)" `
        + `d="${wordmark.path}" fill="${fill}"/>`);
};

const files = {
    // Named for the ground they sit ON: logo-light goes on a light background, so it is ink.
    'icon.svg': icon(INK),
    'icon-dark.svg': icon(LIGHT),
    'logo.svg': lockup(INK),
    'logo-light.svg': lockup(INK),
    'logo-dark.svg': lockup(LIGHT),
};

const out = path.join(here, 'dist');
fs.mkdirSync(out, { recursive: true });

for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), body);
    console.log(`  ${name.padEnd(18)} ${body.length} bytes`);
}

/**
 * Place the copies the docs actually serve.
 *
 * `dist/` is gitignored, so anything the site loads has to be written where that site keeps its
 * assets and committed there. Listed explicitly rather than copied wholesale.
 */
const placements = [
    ['logo-light.svg', '../docs/assets/logo-light.svg'],
    ['logo-dark.svg', '../docs/assets/logo-dark.svg'],
    ['icon.svg', '../docs/assets/icon.svg'],
];

for (const [from, to] of placements) {
    const dest = path.join(here, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[from]);
    console.log(`  → ${path.relative(path.join(here, '..'), dest)}`);
}
