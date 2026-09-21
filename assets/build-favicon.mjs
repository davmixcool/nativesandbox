/**
 * The favicon, transparent.
 *
 * The web-brand rasteriser draws favicons as a filled tile — the mark knocked out of a dark
 * rounded square. This replaces those files with the mark alone on transparency, so the icon
 * sits on whatever the browser's tab bar happens to be instead of carrying its own slab.
 *
 * ── Which colour, when there is no tile ──
 *
 * A tile answered that question by containing it. Transparent, the mark has to be one colour,
 * and one colour cannot suit both a light and a dark tab bar.
 *
 * `favicon.svg` solves it properly: an SVG favicon may carry a stylesheet, and Chrome, Firefox
 * and Safari 16.4+ honour `prefers-color-scheme` inside one. So it is ink on a light tab and
 * near-white on a dark one.
 *
 * The PNG and ICO fallbacks cannot adapt, so they are ink. That is the right bet for where they
 * are actually used — Google Search renders favicons on white, and browsers old enough to
 * ignore the SVG are the ones with light chrome. On a dark tab bar in such a browser the mark
 * will be faint, and no one-colour raster avoids that.
 *
 * ── What is deliberately NOT made transparent ──
 *
 * `apple-touch-icon.png` and `android-chrome-*.png` keep their tile. They are launcher icons,
 * and iOS composites a transparent PNG onto BLACK — an ink mark on a black home screen is an
 * invisible app. Those two want the opaque tile the skill already gives them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, 'brand.config.json'), 'utf8'));

const MARK = config.markSmall.primary[0];       // the bolder cut, drawn to survive 16px
const INK = config.colors.ink;
const LIGHT = config.colors.light;

// Square the mark's own bounds and centre on them, so it fills the frame rather than floating
// in the middle of a 200-unit box with the viewBox's padding baked in.
const [ax, ay, aw, ah] = config.artBounds;
const side = Math.max(aw, ah);
const r3 = (n) => Number(n.toFixed(3));
const VIEW_BOX = `${r3(ax - (side - aw) / 2)} ${r3(ay - (side - ah) / 2)} ${r3(side)} ${r3(side)}`;

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}">
  <style>
    path { fill: ${INK} }
    @media (prefers-color-scheme: dark) { path { fill: ${LIGHT} } }
  </style>
  <path d="${MARK}"/>
</svg>
`;

/** Flat ink, for rasterising — a media query means nothing in a screenshot. */
const flatSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}"><path d="${MARK}" fill="${INK}"/></svg>`;

const CHROME = process.env.CHROME_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SIZES = [16, 32, 48];

// The ICO container has allowed embedded PNG data since Vista, so the PNGs go in verbatim —
// no ImageMagick, no PIL, neither of which is reliably installed.
const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];

const buildIco = (pngs) => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(pngs.length, 4);

    let offset = 6 + 16 * pngs.length;
    const entries = [];

    for (const data of pngs) {
        const [w, h] = pngSize(data);
        const e = Buffer.alloc(16);
        e.writeUInt8(w >= 256 ? 0 : w, 0);
        e.writeUInt8(h >= 256 ? 0 : h, 1);
        e.writeUInt8(0, 2);
        e.writeUInt8(0, 3);
        e.writeUInt16LE(1, 4);
        e.writeUInt16LE(32, 6);
        e.writeUInt32LE(data.length, 8);
        e.writeUInt32LE(offset, 12);
        entries.push(e);
        offset += data.length;
    }

    return Buffer.concat([header, ...entries, ...pngs]);
};

const out = path.join(here, 'dist');
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
const pngs = [];

for (const size of SIZES) {
    const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${flatSvg}`;

    const file = path.join(out, `.favicon-${size}.html`);
    fs.writeFileSync(file, html);

    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.goto(`file://${file}`, { waitUntil: 'load' });

    const dest = path.join(out, `favicon-${size}x${size}.png`);
    // omitBackground is the whole point: without it the screenshot is opaque white.
    await page.screenshot({ path: dest, omitBackground: true });
    fs.unlinkSync(file);

    pngs.push(fs.readFileSync(dest));
    console.log(`  favicon-${size}x${size}.png  transparent`);
}

await browser.close();

fs.writeFileSync(path.join(out, 'favicon.svg'), faviconSvg);
console.log(`  favicon.svg            transparent, adapts to dark tabs`);

const ico = buildIco(pngs);
fs.writeFileSync(path.join(out, 'favicon.ico'), ico);
console.log(`  favicon.ico            ${pngs.length} sizes, ${ico.length} bytes`);

// Overwrite the opaque copies the skill's generator placed, and give the docs theirs.
const placements = [
    ['favicon.svg', 'dist/public/favicon.svg'],
    ['favicon.ico', 'dist/public/favicon.ico'],
    ['favicon-16x16.png', 'dist/public/favicon-16x16.png'],
    ['favicon-32x32.png', 'dist/public/favicon-32x32.png'],
    ['favicon-48x48.png', 'dist/public/favicon-48x48.png'],
    ['favicon.svg', '../docs/assets/favicon.svg'],
    ['favicon-48x48.png', '../docs/assets/favicon.png'],
];

for (const [from, to] of placements) {
    const dest = path.join(here, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(out, from), dest);
    console.log(`  → ${path.relative(path.join(here, '..'), dest)}`);
}
