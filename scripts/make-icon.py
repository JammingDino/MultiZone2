#!/usr/bin/env python3
"""
Generate the MultiZone app icon source (1024x1024 PNG).

The mark is an M built from two overlapping chevron strokes rather than a
single flat letter: the left and right halves are drawn as separate translucent
planes, so where they meet in the middle the colour builds up into a brighter
seam. That overlap is the whole point — it's the app's premise (several zones
answering the same question, side by side) rendered as a letterform, and it
gives the glyph depth that the old flat "M" placeholder didn't have.

Geometry is kept in step with `src/lib/appIcon.ts`, which redraws the same mark
on a canvas at runtime so the window icon can follow the user's accent colour.
Both files reference ICON_GEOMETRY below; change one, change the other.

Run:  python scripts/make-icon.py
Then: npx tauri icon src-tauri/icons/source.png
"""
from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw

SIZE = 1024
# Drawn 3x oversized and downsampled — PIL has no antialiased polygon fill, so
# supersampling is what keeps the diagonals from stair-stepping.
SS = 3

# ── ICON_GEOMETRY (mirrored in src/lib/appIcon.ts) ────────────────────────────
# All values are fractions of the icon's edge, so both renderers can scale them
# to whatever size they're drawing at.
TILE_INSET = 0.0            # the tile fills the canvas; platform masks round it
TILE_RADIUS = 0.2148        # 220/1024
STROKE = 0.1367             # 140/1024 — chevron thickness
M_LEFT = 0.2461             # 252/1024
M_RIGHT = 1.0 - M_LEFT
M_TOP = 0.2930              # 300/1024
M_BOTTOM = 0.7266           # 744/1024
M_VALLEY = 0.6055           # 620/1024 — y of the middle vertex

# Dark tile, top-to-bottom.
BG_TOP = (0x18, 0x1D, 0x26)
BG_BOTTOM = (0x0D, 0x10, 0x15)
# Default accent (matches the app's default theme accent #4F9CF9). The runtime
# renderer substitutes the user's own.
ACCENT = (0x4F, 0x9C, 0xF9)


def lighten(c: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    return tuple(round(v + (255 - v) * amount) for v in c)  # type: ignore[return-value]


def rounded_rect_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    px = grad.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))  # type: ignore[index]
    return grad.resize((size, size), Image.BILINEAR)


def thick_segment(draw: ImageDraw.ImageDraw, a, b, width: float, fill) -> None:
    """A capsule: the segment as a quad plus round caps, so joins stay smooth."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy)
    if length == 0:
        return
    nx, ny = -dy / length * width / 2, dx / length * width / 2
    draw.polygon(
        [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)],
        fill=fill,
    )
    for cx, cy in (a, b):
        draw.ellipse([cx - width / 2, cy - width / 2, cx + width / 2, cy + width / 2], fill=fill)


def chevron(points, width: float, fill, canvas: int) -> Image.Image:
    """One half of the M on its own layer, so overlaps composite rather than cover."""
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for i in range(len(points) - 1):
        thick_segment(draw, points[i], points[i + 1], width, fill)
    return layer


def main() -> None:
    canvas = SIZE * SS
    s = lambda frac: frac * canvas  # noqa: E731 — fraction → pixels at this scale

    # Tile.
    icon = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    tile = vertical_gradient(canvas, BG_TOP, BG_BOTTOM).convert("RGBA")
    icon.paste(tile, (0, 0), rounded_rect_mask(canvas, round(s(TILE_RADIUS))))

    stroke = s(STROKE)
    left, right = s(M_LEFT), s(M_RIGHT)
    top, bottom, valley = s(M_TOP), s(M_BOTTOM), s(M_VALLEY)
    mid = canvas / 2

    # Two planes. Each is a full half of the letter and they share the middle
    # vertex, so the seam is where both land — the brighter overlap. The tones
    # are pulled well apart: at 16px the halves blur together anyway, and at
    # desktop sizes the split is what stops this reading as a plain letter.
    pale = lighten(ACCENT, 0.46)
    left_half = chevron([(left, bottom), (left, top), (mid, valley)], stroke, ACCENT + (235,), canvas)
    right_half = chevron([(mid, valley), (right, top), (right, bottom)], stroke, pale + (200,), canvas)

    icon.alpha_composite(left_half)
    icon.alpha_composite(right_half)

    # Re-mask: the strokes are inside the tile, but round the edge anyway so a
    # platform that doesn't mask for us still gets clean corners.
    icon.putalpha(
        Image.composite(icon.getchannel("A"), Image.new("L", (canvas, canvas), 0),
                        rounded_rect_mask(canvas, round(s(TILE_RADIUS))))
    )

    out = icon.resize((SIZE, SIZE), Image.LANCZOS)
    dest = os.path.join("src-tauri", "icons", "source.png")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    out.save(dest)
    print(f"wrote {dest} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
