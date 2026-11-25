#!/usr/bin/env python3
"""
Build the disk-image background.

The default DMG window is two unlabelled icons and an arrow between them. It is
a convention people who install a lot of Mac software read instantly and
everyone else squints at, so this states the instruction in words and names the
version being installed — the one question someone has when they find an old
DMG in their Downloads folder months later.

Two sizes are produced. macOS picks `@2x` on a Retina display; without it the
text is visibly soft on exactly the machines this ships to.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

# Matches the window size declared in electron-builder.yml. If one changes the
# other must, or macOS scales the background and the text lands off-centre.
WIDTH, HEIGHT = 560, 400

# Tacit's canvas, in daylight: a warm paper ground with its dot grid. Finder
# draws the icon labels in black, so the ground stays light.
BACKGROUND = (247, 245, 240, 255)
DOT = (214, 210, 202, 255)
HEADING = (28, 27, 25, 255)
SUBDUED = (118, 114, 108, 255)
ARROW = (176, 170, 160, 255)
PEDESTAL = (255, 255, 255, 255)
PEDESTAL_EDGE = (226, 222, 214, 255)
FOLDER_BACK = (88, 160, 232, 255)
FOLDER_FRONT = (118, 184, 246, 255)
FOLDER_MARK = (232, 243, 255, 255)

# The icon slots in electron-builder.yml (centres, in points) and their size.
APP_AT, APPS_AT, ICON = (150, 225), (410, 225), 96

SF = "/System/Library/Fonts/SFNS.ttf"


def font(size: int, weight: str = "Regular") -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(SF, size)
    try:
        f.set_variation_by_name(weight)
    except (OSError, ValueError):
        # A non-variable fallback still renders; only the weight is lost.
        pass
    return f


def centered(draw: ImageDraw.ImageDraw, y: int, text: str, f, fill, scale: int) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
    draw.text((((WIDTH * scale) - (right - left)) / 2 - left, y - top), text, font=f, fill=fill)


def pedestal(canvas: Image.Image, at: tuple[int, int], scale: int) -> None:
    """A soft card under an icon slot and the name Finder writes below it, so each reads as a place to drag from or to."""
    size, r = 136 * scale, 30 * scale
    x, y = at[0] * scale - size // 2, (at[1] - 70) * scale
    height = 158 * scale
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x, y + 6 * scale, x + size, y + height + 6 * scale], r, fill=(60, 50, 30, 28))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10 * scale)))
    ImageDraw.Draw(canvas).rounded_rectangle([x, y, x + size, y + height], r, fill=PEDESTAL, outline=PEDESTAL_EDGE, width=max(1, scale))


def folder(draw: ImageDraw.ImageDraw, at: tuple[int, int], scale: int) -> None:
    """
    An Applications folder of our own drawing, under the real one. macOS 26
    Finder sometimes doesn't draw the icon of a disk image's Applications link
    (create-dmg#202); then this is what shows instead of an empty square. When
    Finder does draw it, it covers this.
    """
    s = scale
    w, h = 80 * s, 62 * s
    x0, y0 = at[0] * s - w // 2, at[1] * s - h // 2 + 4 * s
    draw.rounded_rectangle([x0, y0 - 8 * s, x0 + 32 * s, y0 + 8 * s], 5 * s, fill=FOLDER_BACK)
    draw.rounded_rectangle([x0, y0, x0 + w, y0 + h], 7 * s, fill=FOLDER_BACK)
    draw.rounded_rectangle([x0, y0 + 9 * s, x0 + w, y0 + h], 7 * s, fill=FOLDER_FRONT)
    # The mark on the front: an "A" of three strokes, as on the real one.
    cx, cy = at[0] * s, at[1] * s + 13 * s
    lw = max(2, 4 * s)
    draw.line([(cx - 12 * s, cy + 12 * s), (cx, cy - 13 * s), (cx + 12 * s, cy + 12 * s)], fill=FOLDER_MARK, width=lw, joint="curve")
    draw.line([(cx - 7 * s, cy + 3 * s), (cx + 7 * s, cy + 3 * s)], fill=FOLDER_MARK, width=lw)


def build(scale: int) -> Image.Image:
    w, h = WIDTH * scale, HEIGHT * scale
    canvas = Image.new("RGBA", (w, h), BACKGROUND)
    draw = ImageDraw.Draw(canvas)

    # The dot grid, fading out under the words at the top.
    step, dot = 18 * scale, 1.1 * scale
    for gy in range(step // 2, h, step):
        # Under the words at the top and the line at the bottom, none.
        fade = min(1.0, max(0.0, (gy / scale - 120) / 70), max(0.0, (330 - gy / scale) / 30))
        if fade <= 0:
            continue
        colour = tuple(round(BACKGROUND[i] + (DOT[i] - BACKGROUND[i]) * fade) for i in range(3)) + (255,)
        for gx in range(step // 2, w, step):
            draw.ellipse([gx - dot, gy - dot, gx + dot, gy + dot], fill=colour)

    centered(draw, 46 * scale, "Install Tacit", font(22 * scale, "Bold"), HEADING, scale)
    centered(draw, 82 * scale, "Drag Tacit onto the Applications folder.", font(13 * scale), SUBDUED, scale)

    pedestal(canvas, APP_AT, scale)
    pedestal(canvas, APPS_AT, scale)
    draw = ImageDraw.Draw(canvas)
    folder(draw, APPS_AT, scale)

    # A dashed arc from one card to the other, the way a drag goes.
    x0, x1, base, lift = 226, 334, 214, 18
    points = []
    for i in range(41):
        t = i / 40
        points.append(((x0 + (x1 - x0) * t) * scale, (base - lift * 4 * t * (1 - t)) * scale))
    for i in range(0, 40, 4):
        draw.line(points[i : i + 3], fill=ARROW, width=max(2, 2 * scale), joint="curve")
    ex, ey = points[-1]
    head = 7 * scale
    draw.polygon([(ex + head, ey + head * 0.35), (ex - head * 0.6, ey - head * 0.8), (ex - head * 0.2, ey + head * 0.9)], fill=ARROW)

    centered(draw, 352 * scale, "Then open it from Applications or Spotlight.", font(11 * scale), SUBDUED, scale)
    return canvas


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    build(1).convert("RGB").save(BUILD / "dmg-background.png")
    build(2).convert("RGB").save(BUILD / "dmg-background@2x.png")
    print("wrote build/dmg-background.png and @2x")


if __name__ == "__main__":
    main()
