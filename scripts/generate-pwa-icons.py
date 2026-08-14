from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "icons"
BASE_SIZE = 512
BG = "#f7faf8"
PRIMARY = "#006b55"
PRIMARY_DARK = "#004b3b"
PRIMARY_SOFT = "#c9ecdf"
SURFACE = "#ffffff"


def rounded_rectangle(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def package(draw, box):
    left, top, right, bottom = box
    radius = 18
    rounded_rectangle(draw, box, radius, SURFACE)
    draw.rounded_rectangle(
        (left + 10, top + 10, right - 10, top + 36),
        radius=9,
        fill=PRIMARY_SOFT,
    )
    draw.line((left + 22, top + 50, right - 22, top + 50), fill=PRIMARY, width=7)
    draw.line((left + 22, top + 70, right - 40, top + 70), fill=PRIMARY_DARK, width=7)


def render(maskable=False):
    image = Image.new("RGB", (BASE_SIZE, BASE_SIZE), PRIMARY if maskable else BG)
    draw = ImageDraw.Draw(image)
    if not maskable:
        rounded_rectangle(draw, (30, 30, 482, 482), 104, PRIMARY)

    draw.line((256, 220, 256, 258), fill=PRIMARY_SOFT, width=12)
    draw.line((256, 252, 184, 286), fill=PRIMARY_SOFT, width=12)
    draw.line((256, 252, 328, 286), fill=PRIMARY_SOFT, width=12)
    package(draw, (194, 112, 318, 220))
    package(draw, (116, 286, 240, 394))
    package(draw, (272, 286, 396, 394))
    return image


def save_resized(image, size, name):
    resized = image.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(OUTPUT / name, format="PNG", optimize=True)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    regular = render(maskable=False)
    maskable = render(maskable=True)
    save_resized(regular, 180, "labstock-180-v1.png")
    save_resized(regular, 192, "labstock-192-v1.png")
    save_resized(regular, 512, "labstock-512-v1.png")
    save_resized(maskable, 512, "labstock-maskable-512-v1.png")


if __name__ == "__main__":
    main()
