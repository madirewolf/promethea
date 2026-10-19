"""Draws the app icon into promethea/assets: the UI's logo (ui/public/favicon.svg), a violet to
pink rounded square with a white crystal flame. Run it again after changing the logo:

    python tools/make_icon.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "promethea" / "assets"
SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)

# favicon.svg, in its 32 x 32 box: the flame's two facets and how opaque each is.
CORNER = 9
FACETS = [
    ([(16, 3.8), (16, 17), (13.4, 22), (16, 27.8), (10.2, 24.6), (8, 17.8), (11.4, 10.6)], 0.67),
    ([(16, 3.8), (20.6, 10.6), (24, 17.8), (21.8, 24.6), (16, 27.8), (18.6, 22), (16, 17)], 1.0),
]
START, END = (0x8B, 0x5C, 0xF6), (0xEC, 0x48, 0x99)


def render(size: int) -> Image.Image:
    """The icon at `size` pixels, drawn 8 times bigger and shrunk so the edges stay smooth."""
    s = size * 8
    k = s / 32
    # The gradient runs corner to corner, as CSS's 135deg does on a square.
    across = Image.linear_gradient("L").rotate(90).resize((s, s))
    down = Image.linear_gradient("L").resize((s, s))
    mix = ImageChops.add(across, down, scale=2)
    art = Image.composite(Image.new("RGB", (s, s), END), Image.new("RGB", (s, s), START), mix)
    art = art.convert("RGBA")
    for points, opacity in FACETS:
        facet = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        ImageDraw.Draw(facet).polygon([(x * k, y * k) for x, y in points], fill=(255, 255, 255, round(255 * opacity)))
        art.alpha_composite(facet)
    shape = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shape).rounded_rectangle((0, 0, s - 1, s - 1), radius=CORNER * k, fill=255)
    art.putalpha(shape)
    return art.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    frames = [render(n) for n in SIZES]
    big = frames[-1]
    big.save(ASSETS / "promethea.ico", format="ICO", sizes=[(n, n) for n in SIZES], append_images=frames[:-1])
    big.save(ASSETS / "promethea.png")
    print(f"wrote {ASSETS / 'promethea.ico'} and promethea.png")


if __name__ == "__main__":
    main()
