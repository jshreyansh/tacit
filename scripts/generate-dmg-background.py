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

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

# Matches the window size declared in electron-builder.yml. If one changes the
# other must, or macOS scales the background and the text lands off-centre.
WIDTH, HEIGHT = 560, 400

# The icon card colour, so the window reads as part of the app rather than as a
# system dialog that happens to contain it.
BACKGROUND = (250, 249, 246, 255)
HEADING = (28, 28, 30, 255)
SUBDUED = (128, 128, 134, 255)
ARROW = (188, 188, 194, 255)

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


def build(scale: int) -> Image.Image:
    w, h = WIDTH * scale, HEIGHT * scale
    canvas = Image.new("RGBA", (w, h), BACKGROUND)
    draw = ImageDraw.Draw(canvas)

    centered(draw, 52 * scale, "Install Tacit", font(21 * scale, "Bold"), HEADING, scale)
    centered(
        draw,
        88 * scale,
        "Drag the app onto the Applications folder.",
        font(13 * scale),
        SUBDUED,
        scale,
    )

    # Sits between the two icon slots positioned in electron-builder.yml.
    arrow_y = 232 * scale
    x0, x1 = 250 * scale, 310 * scale
    draw.line([(x0, arrow_y), (x1, arrow_y)], fill=ARROW, width=max(2, 2 * scale))
    head = 9 * scale
    draw.polygon(
        [(x1 + head, arrow_y), (x1 - head // 2, arrow_y - head), (x1 - head // 2, arrow_y + head)],
        fill=ARROW,
    )

    centered(
        draw,
        340 * scale,
        "Then open it from Applications or Spotlight.",
        font(11 * scale),
        SUBDUED,
        scale,
    )
    return canvas


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    build(1).convert("RGB").save(BUILD / "dmg-background.png")
    build(2).convert("RGB").save(BUILD / "dmg-background@2x.png")
    print("wrote build/dmg-background.png and @2x")


if __name__ == "__main__":
    main()
