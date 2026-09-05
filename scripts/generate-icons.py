#!/usr/bin/env python3
"""
Build the app icon set from the Tacit mark.

The mark itself is an asset (docs/logo-light.png), not something this script
draws. An earlier version rendered the old logo procedurally from rectangle
coordinates, which meant the icon and the brand could drift apart without
anyone noticing; compositing the real file makes the artwork the single source.

The macOS convention is a rounded card with the mark inset, so that is what is
produced for every platform rather than a bare transparent glyph — an icon with
no ground disappears against a matching wallpaper.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "build"
DOCS_DIR = ROOT / "docs"
SOURCE_MARK = DOCS_DIR / "logo-light.png"

CANVAS_SIZE = 1024
BG_MARGIN = 72
BG_RADIUS = 224
CARD_COLOR = (250, 249, 246, 255)
SHADOW_COLOR = (0, 0, 0, 36)

# How much of the canvas the mark occupies. Sized against the canvas rather than
# the card so the optical weight stays put if the card margin is ever retuned.
MARK_SIZE = 512


def ensure_dirs() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)


def build_master_png() -> Image.Image:
    if not SOURCE_MARK.exists():
        raise SystemExit(f"Missing {SOURCE_MARK}. The icon is built from the brand mark.")

    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (
            BG_MARGIN,
            BG_MARGIN + 18,
            CANVAS_SIZE - BG_MARGIN,
            CANVAS_SIZE - BG_MARGIN + 18,
        ),
        radius=BG_RADIUS,
        fill=SHADOW_COLOR,
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(24)))

    ImageDraw.Draw(canvas).rounded_rectangle(
        (BG_MARGIN, BG_MARGIN, CANVAS_SIZE - BG_MARGIN, CANVAS_SIZE - BG_MARGIN),
        radius=BG_RADIUS,
        fill=CARD_COLOR,
    )

    mark = Image.open(SOURCE_MARK).convert("RGBA")
    mark = mark.resize((MARK_SIZE, MARK_SIZE), Image.LANCZOS)
    offset = (CANVAS_SIZE - MARK_SIZE) // 2
    canvas.alpha_composite(mark, (offset, offset))
    return canvas


def write_pngs(master: Image.Image) -> None:
    master.save(BUILD_DIR / "icon.png")
    master.resize((256, 256), Image.LANCZOS).save(DOCS_DIR / "icon.png")


def write_ico(master: Image.Image) -> None:
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(BUILD_DIR / "icon.ico", sizes=sizes)


def write_icns(master: Image.Image) -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        iconset = Path(temp_dir) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            if size != 512:
                master.resize((size * 2, size * 2), Image.LANCZOS).save(
                    iconset / f"icon_{size}x{size}@2x.png"
                )
        master.save(iconset / "icon_512x512@2x.png")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD_DIR / "icon.icns")],
            check=True,
        )


def main() -> None:
    ensure_dirs()
    master = build_master_png()
    write_pngs(master)
    write_ico(master)
    write_icns(master)


if __name__ == "__main__":
    main()
