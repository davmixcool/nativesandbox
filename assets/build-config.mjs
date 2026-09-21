/**
 * Emit brand.config.json for the web-brand skill.
 *
 * The mark is computed rather than hand-authored because it depends on winding direction: the
 * prompt is a HOLE in the container, not a shape drawn on top of it. A hole only appears where
 * its path runs opposite to the outline enclosing it, and getting that right by hand — for
 * rounded corners as well as straight runs — is the kind of thing that silently renders a solid
 * blob instead.
 *
 * Single-colour on purpose. A silhouette with holes inverts correctly on any ground, which is
 * what lets one drawing serve a cream mark on an ink tile and an ink mark on paper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const round = (n) => Number(n.toFixed(2));

/**
 * Signed area, y-down. Positive means clockwise ON SCREEN, which is the opposite of the maths
 * convention and the reason this is a named function rather than an inline comparison.
 */
const isClockwise = (pts) => pts.reduce((sum, [x, y], i) => {
    const [nx, ny] = pts[(i + 1) % pts.length];
    return sum + (nx - x) * (ny + y);
}, 0) > 0;

const oriented = (pts, clockwise) => (isClockwise(pts) === clockwise ? pts : [...pts].reverse());

const polygon = (pts, clockwise) =>
    `M ${oriented(pts, clockwise).map(([x, y]) => `${round(x)},${round(y)}`).join(' L ')} Z`;

/**
 * A polygon with its corners cut back by `r` and bridged with a quadratic through the vertex.
 *
 * Quadratics rather than arcs: an arc carries a sweep flag that has to agree with the winding
 * direction, so the same drawing would need two variants to serve as both an outline and a
 * hole. A quadratic has no handedness — reversing the point order is enough.
 */
const roundedPolygon = (pts, r, clockwise) => {
    const p = oriented(pts, clockwise);
    const n = p.length;
    const at = (i) => p[(i + n) % n];

    const corner = (i) => {
        const [vx, vy] = at(i);
        const toward = ([px, py]) => {
            const [dx, dy] = [px - vx, py - vy];
            const len = Math.hypot(dx, dy);
            if (len < 2 * r) throw new Error(`corner radius ${r} does not fit an edge of ${round(len)}`);
            return [vx + (dx / len) * r, vy + (dy / len) * r];
        };
        return { from: toward(at(i - 1)), to: toward(at(i + 1)), v: [vx, vy] };
    };

    const c = p.map((_, i) => corner(i));
    const xy = ([x, y]) => `${round(x)},${round(y)}`;

    let d = `M ${xy(c[0].to)}`;
    for (let i = 1; i <= n; i++) {
        const k = c[i % n];
        d += ` L ${xy(k.from)} Q ${xy(k.v)} ${xy(k.to)}`;
    }
    return `${d} Z`;
};

// ── the container ─────────────────────────────────────────────────────────
// A hexagon, the shape the whole industry already reads as "a container". Deliberately NOT a
// rounded square: the generator composites the mark onto a rounded square tile for avatars and
// launcher icons, and a rounded square inside one reads as a framing mistake.
const hexagon = (R, cx = 100, cy = 100) =>
    [-90, -30, 30, 90, 150, 210].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return [cx + R * Math.cos(rad), cy + R * Math.sin(rad)];
    });

// ── the prompt, knocked out of it ─────────────────────────────────────────
// `>_`. What the sandbox is FOR is running commands, and a chevron is the one glyph that says
// so at 16 pixels.
const CCW = false;

/**
 * A chevron as ONE closed polygon.
 *
 * Not two overlapping bars. Under nonzero winding the outline counts +1 and each hole −1, so a
 * hole is transparent at 0 — but where two holes overlap the count reaches −1 again and the
 * overlap fills back in. Two bars meeting at an apex would put a solid wedge exactly at the
 * point of the chevron. Even-odd fill does not save it; a single outline does.
 *
 * `t` is VERTICAL thickness. With 45° arms that is a clean √2 relationship to the perpendicular
 * stroke width, and it keeps the arm ends as honest vertical cuts.
 */
const chevron = (bx, cy, L, t) => {
    const ax = bx + L;
    return polygon([
        [bx, cy - L], [ax, cy], [bx, cy + L],
        [bx, cy + L - t], [ax - t, cy], [bx, cy - L + t],
    ], CCW);
};

const rect = (x1, y1, x2, y2) => polygon([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], CCW);

/** Every edge of a polygon, for the separation check below. */
const edgesOf = (pts) => pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);

const segmentDistance = ([[ax, ay], [bx, by]], [[cx, cy], [dx, dy]]) => {
    const pointToSeg = (px, py, x1, y1, x2, y2) => {
        const [dx1, dy1] = [x2 - x1, y2 - y1];
        const len2 = dx1 * dx1 + dy1 * dy1;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx1 + (py - y1) * dy1) / len2));
        return Math.hypot(px - (x1 + t * dx1), py - (y1 + t * dy1));
    };
    return Math.min(
        pointToSeg(ax, ay, cx, cy, dx, dy), pointToSeg(bx, by, cx, cy, dx, dy),
        pointToSeg(cx, cy, ax, ay, bx, by), pointToSeg(dx, dy, ax, ay, bx, by),
    );
};

/**
 * The holes must stand apart, and this says so out loud rather than trusting the drawing.
 *
 * Same winding arithmetic as the chevron's own construction: where two holes touch, the count
 * returns to −1 and the overlap fills solid. A chevron and an underscore 14 units apart are
 * obviously fine — until someone nudges one of them.
 */
const assertApart = (a, b, name) => {
    let min = Infinity;
    for (const ea of edgesOf(a)) for (const eb of edgesOf(b)) min = Math.min(min, segmentDistance(ea, eb));
    if (min <= 0) throw new Error(`${name}: holes touch — the overlap will fill solid`);
    return min;
};

// ── the full cut ──────────────────────────────────────────────────────────
const R = 94, CHEV = { bx: 55, cy: 100, L: 38, t: 24 }, BAR = [107, 114, 145, 138];

const chevronPoints = ({ bx, cy, L, t }) => [
    [bx, cy - L], [bx + L, cy], [bx, cy + L],
    [bx, cy + L - t], [bx + L - t, cy], [bx, cy - L + t],
];
const rectPoints = ([x1, y1, x2, y2]) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];

const gap = assertApart(chevronPoints(CHEV), rectPoints(BAR), 'chevron/underscore');

const mark = [roundedPolygon(hexagon(R), 18, true), chevron(CHEV.bx, CHEV.cy, CHEV.L, CHEV.t), rect(...BAR)];

/**
 * The drawn bounds of the hexagon, measured rather than assumed.
 *
 * The lockup has to know where the ink actually is, and rounding the corners moves it: the top
 * vertex sits at y=6, but the quadratic that replaces it peaks at 10.5. Hard-coding the vertex
 * would hang the wordmark off a baseline the mark does not reach.
 */
const boundsOfHexagon = (radius, corner) => {
    const pts = hexagon(radius);
    const n = pts.length;
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    const see = ([x, y]) => {
        lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y);
        hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y);
    };
    for (let i = 0; i < n; i++) {
        const v = pts[i];
        const toward = (q) => {
            const [dx, dy] = [q[0] - v[0], q[1] - v[1]];
            const len = Math.hypot(dx, dy);
            return [v[0] + (dx / len) * corner, v[1] + (dy / len) * corner];
        };
        const a = toward(pts[(i - 1 + n) % n]);
        const b = toward(pts[(i + 1) % n]);
        see(a); see(b);
        // Sample the quadratic through the vertex; its own extreme lies between the cut points.
        for (let t = 0.1; t < 1; t += 0.1) {
            const u = 1 - t;
            see([u * u * a[0] + 2 * u * t * v[0] + t * t * b[0], u * u * a[1] + 2 * u * t * v[1] + t * t * b[1]]);
        }
    }
    return [round(lo[0]), round(lo[1]), round(hi[0] - lo[0]), round(hi[1] - lo[1])];
};

const artBounds = boundsOfHexagon(R, 18);

// ── the 16px cut ──────────────────────────────────────────────────────────
// A bigger hexagon and a fatter chevron, and NO underscore. At 16px the whole mark is about a
// dozen pixels across: a 24-unit bar is under two of them, and it smears into the chevron
// rather than reading as anything.
// Same hexagon as the full cut, so the two are one silhouette with different interiors. It is
// also what keeps the apple-touch icon off its own edges: that one is drawn square, and iOS
// rounds it afterwards, so a hexagon running to the viewBox edge loses its points.
// Fatter than it looks like it should be at full size. At 16px the hexagon becomes a solid
// badge and the chevron is what has to survive: rendered side by side, a 34-unit chevron was a
// smudge and a 44-unit one still reads. The apple-touch icon uses this cut too, and carries the
// heavier chevron perfectly well.
const SMALL = { bx: 68, cy: 100, L: 64, t: 44 };
const markSmall = [roundedPolygon(hexagon(R), 18, true), chevron(SMALL.bx, SMALL.cy, SMALL.L, SMALL.t)];

const config = {
    name: 'nativesandbox',
    shortName: 'nativesandbox',
    tagline: 'Sandboxes on any Linux host.',
    headline: 'Run untrusted code.\nNo KVM required.',
    blurb: 'Container-backed sandboxes for untrusted code, on any Linux host — no KVM, '
        + 'no nested virtualisation, and no daemon of its own.',
    domain: 'nativesandbox.dev',

    colors: {
        ink: '#0b1014',
        // Sand, for a sandbox — and the one warm note in a palette of slate. It also clears 8:1
        // against the ink tile, so unlike a blue accent it survives being a small detail.
        accent: '#f2a33c',
        // The same hue walked down until it clears 4.5:1 on the light ground, where the bright
        // one manages 1.96:1 — fine as a fill, unreadable as a link. Not used by the rasteriser
        // (every surface it draws is ink); it is here so the docs theme reads it from one place.
        accentDeep: '#a3610b',
        light: '#f7f8f8',
        muted: '#8b949e',
        onDark: '#e9edf0',
    },

    font: { family: 'Inter', weight: 600 },

    // The hexagon runs nearly edge to edge inside its viewBox, so it needs the tile to hold it
    // back. Tuned by looking at avatar-1024 and the 16px favicon, not by taste.
    inset: 0.9,
    cornerRadius: 0.24,

    // ONE path, not a list of them. The generator emits each array entry as its own <path>, and
    // separate elements cannot cut holes in one another — winding only resolves within a single
    // `d`. Listed separately, the prompt vanishes and the mark is a solid hexagon.
    // Not read by the generator; build-svg.mjs uses it to place the wordmark.
    artBounds,

    mark: { viewBox: '0 0 200 200', primary: [mark.join(' ')] },
    markSmall: { viewBox: '0 0 200 200', primary: [markSmall.join(' ')] },
};

fs.writeFileSync(path.join(here, 'brand.config.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`wrote brand.config.json  (hole gap ${gap.toFixed(1)}, art ${artBounds.join(' ')})`);
