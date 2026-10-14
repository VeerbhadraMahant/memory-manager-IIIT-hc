#!/usr/bin/env python3
"""Draws the brand art as SVG: public/brand/hero.svg and public/brand/mark.svg.

Run:  python3 frontend/scripts/build_brand_art.py

Why code and not an image model: the style (refero "Tableland") asks for flat polygons with
no outlines, no texture and no gradients inside the mountains. That is exactly what SVG is,
it is a few KB instead of a megabyte, it stays sharp at any size, and it is reproducible.
Deterministic: same input, same file.

Rules carried over from the style: coral peaks with darker shadow planes over a smooth
lavender-to-pink sky; ridge bleeds off the right edge; one mint signal light above the tallest peak;
nothing else.
"""

from __future__ import annotations

from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "public" / "brand"

SKY_TOP, SKY_BOT = "#e4cbf2", "#f5d4e8"  # lavender mist -> pale pink
MINT = "#0be291"


def mix(a: str, b: str, t: float) -> str:
    pa = [int(a[i : i + 2], 16) for i in (1, 3, 5)]
    pb = [int(b[i : i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(pa, pb, strict=True))


def poly(points: list[tuple[float, float]], fill: str) -> str:
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return f'<polygon points="{pts}" fill="{fill}"/>'


def range_layer(peaks, base_y, lit, shade, accent):
    """One mountain range. `peaks` = [(x, apex_y, valley_y_left, shade_dx)] left to right.

    Each peak is split down a slanted spine into a lit left face and a shadowed right face;
    one extra facet on each face breaks the flat look the way a low-poly painting does.
    """
    out = []
    n = len(peaks)
    for i, (x, y, vy, dx) in enumerate(peaks):
        # Interior valleys are shared with the neighbour so the ridge line is continuous.
        # The outer feet slope all the way down to the baseline instead of ending in a cliff.
        span = (peaks[1][0] - peaks[0][0]) if n > 1 else 300
        lx = (peaks[i - 1][0] + x) / 2 if i else x - span * 0.9
        rx = (x + peaks[i + 1][0]) / 2 if i < n - 1 else x + span * 0.9
        ly = vy if i else base_y
        ry = peaks[i + 1][2] if i < n - 1 else base_y
        spine = (x + dx, base_y)
        A, L, R = (x, y), (lx, ly), (rx, ry)
        out.append(poly([L, A, spine, (lx, base_y)], lit))
        out.append(poly([A, R, (rx, base_y), spine], shade))
        # extra facets
        m1 = (x - (x - lx) * 0.42, y + (ly - y) * 0.46)
        out.append(poly([A, m1, (x + dx * 0.55, y + (base_y - y) * 0.52)], accent[0]))
        m2 = (x + (rx - x) * 0.46, y + (ry - y) * 0.40)
        out.append(poly([A, m2, (x + dx * 0.9, y + (base_y - y) * 0.7)], accent[1]))
    return "\n  ".join(out)


def hero() -> str:
    w, h = 2100, 900
    coral, deep, peach, rose = "#f4706b", "#d9525f", "#f9988f", "#e8605f"
    far_lit, far_shade = mix(coral, SKY_BOT, 0.55), mix(deep, SKY_BOT, 0.50)
    mid_lit, mid_shade = mix(coral, SKY_BOT, 0.22), mix(deep, SKY_BOT, 0.18)
    back = [(960, 560, 640, 30), (1230, 400, 600, 40), (1500, 500, 640, 30),
            (1760, 330, 620, 50), (2010, 450, 650, 30), (2250, 360, 640, 40)]
    mid = [(1090, 640, 720, 30), (1390, 520, 700, 36), (1680, 590, 740, 30),
           (1960, 470, 720, 44), (2240, 560, 760, 30)]
    front = [(1230, 740, 810, 24), (1530, 640, 790, 36), (1840, 700, 820, 28),
             (2130, 600, 800, 40), (2400, 690, 830, 24)]
    # a gentle low ridge on the left so the horizon reads without competing with the text
    low = [(120, 800, 850, 14), (420, 770, 850, 20), (760, 805, 855, 14)]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" preserveAspectRatio="xMaxYMax slice" role="img" aria-label="Faceted coral mountain peaks over a lavender sky, one green light on the horizon">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{SKY_TOP}"/><stop offset="1" stop-color="{SKY_BOT}"/>
    </linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="{MINT}" stop-opacity=".55"/><stop offset="1" stop-color="{MINT}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#sky)"/>
  {range_layer(back, h, far_lit, far_shade, (mix(far_lit, '#ffffff', .18), mix(far_shade, SKY_TOP, .2)))}
  {range_layer(mid, h, mid_lit, mid_shade, (mix(mid_lit, '#ffffff', .15), mix(mid_shade, SKY_TOP, .12)))}
  {range_layer(low, h, mix(coral, SKY_BOT, .38), mix(deep, SKY_BOT, .34), (mix(coral, SKY_BOT, .3), mix(deep, SKY_BOT, .26)))}
  {range_layer(front, h, coral, deep, (peach, rose))}
  <circle cx="1760" cy="286" r="38" fill="url(#glow)"/>
  <circle cx="1760" cy="286" r="7" fill="{MINT}"/>
</svg>
"""


def mark() -> str:
    coral, deep, peach, rose = "#f4706b", "#d9525f", "#f9988f", "#e8605f"
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Negotiated AI Memory">
  <rect width="128" height="128" rx="24" fill="{SKY_TOP}"/>
  {poly([(18, 104), (60, 30), (60, 104)], coral)}
  {poly([(60, 30), (112, 104), (60, 104)], deep)}
  {poly([(60, 30), (38, 70), (60, 74)], peach)}
  {poly([(60, 30), (84, 66), (62, 80)], rose)}
  <circle cx="60" cy="19" r="5" fill="{MINT}"/>
</svg>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hero.svg").write_text(hero(), encoding="utf-8")
    (OUT / "mark.svg").write_text(mark(), encoding="utf-8")
    print("wrote", OUT / "hero.svg", OUT / "mark.svg")


if __name__ == "__main__":
    main()
