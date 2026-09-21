"""
Convert the wordmark to outlines, once.

NOT part of `npm run build`. The build reads `wordmark.json`, which is the output of this
script — the outlines are data, and nothing that rasterises the kit needs Python or a font
file. Run this only when the word itself changes.

Why outlines rather than a <text> element: an SVG loaded through `<img>` is isolated and
cannot fetch a webfont, so `<text>` would render in whatever face the viewer happened to have
installed. The logo would silently be wrong on other people's machines.

Inter is SIL OFL, which permits shipping outlines like this.

    python3 -m venv fv && ./fv/bin/pip install fonttools brotli uharfbuzz
    curl -sL 'https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf' -o Inter.ttf
    ./fv/bin/python make-wordmark.py Inter.ttf nativesandbox > ../wordmark.json
"""
import json
import sys

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEIGHT = 600          # Inter SemiBold
OPTICAL_SIZE = 32     # display cut: slightly tighter spacing than the text cut
TRACKING_EM = -0.03   # a long lowercase word needs less negative tracking than a mixed-case one


def main(font_path: str, word: str) -> None:
    font = TTFont(font_path)
    # Pin the axes rather than leaving them variable: a static instance is what the outlines
    # have to come from, and the default instance is Regular, not SemiBold.
    font = instancer.instantiateVariableFont(font, {"wght": WEIGHT, "opsz": OPTICAL_SIZE})
    upem = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()

    # Shaped by HarfBuzz, so kerning and any substitutions are the font's own, not a guess
    # from bare advance widths.
    with open(font_path, "rb") as fh:
        blob = hb.Blob(fh.read())
    face = hb.Face(blob)
    hb_font = hb.Font(face)
    hb_font.set_variations({"wght": WEIGHT, "opsz": OPTICAL_SIZE})
    buf = hb.Buffer()
    buf.add_str(word)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf)

    order = font.getGlyphOrder()
    tracking = TRACKING_EM * upem

    parts, x = [], 0.0
    bounds = BoundsPen(glyphs)

    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        # y flipped: SVG is y-down, and the baseline sits at 0 so the lockup can place it.
        transform = (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)
        pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        glyphs[name].draw(TransformPen(pen, transform))
        if (d := pen.getCommands()):
            parts.append(d)
        glyphs[name].draw(TransformPen(bounds, transform))
        x += pos.x_advance + tracking

    xmin, ymin, xmax, ymax = bounds.bounds
    json.dump({
        "word": word,
        "font": f"Inter SemiBold (SIL OFL), opsz {OPTICAL_SIZE}, converted to outlines",
        "unitsPerEm": upem,
        "trackingEm": TRACKING_EM,
        "advance": round(x - tracking, 2),
        "bounds": [round(v, 2) for v in (xmin, ymin, xmax, ymax)],
        "path": " ".join(parts),
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
