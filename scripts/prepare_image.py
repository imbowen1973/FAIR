"""Prepare an image for the repo: resize, compress, strip metadata.

    python scripts/prepare_image.py photo.jpg sessions/assets/photo.jpg
    python scripts/prepare_image.py photo.jpg            # in place

- resizes to <= 2000 px on the long edge (under the 2200 px CI cap)
- re-encodes: JPEG quality 82 for photos, optimized PNG for graphics
  with transparency
- strips ALL metadata, including EXIF — clinical photos must not carry
  GPS coordinates, capture timestamps, or device identifiers into a
  public repo
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

TARGET_EDGE = 2000
JPEG_QUALITY = 82


def prepare(src: Path, dst: Path) -> None:
    with Image.open(src) as im:
        im.load()
        edge = max(im.size)
        if edge > TARGET_EDGE:
            scale = TARGET_EDGE / edge
            im = im.resize(
                (round(im.width * scale), round(im.height * scale)), Image.LANCZOS
            )

        has_alpha = im.mode in ("RGBA", "LA", "P") and (
            im.mode != "P" or "transparency" in im.info
        )
        # Re-creating the image drops EXIF and all other metadata.
        if has_alpha:
            clean = im.convert("RGBA")
            out = dst.with_suffix(".png")
            clean.save(out, format="PNG", optimize=True)
        else:
            clean = im.convert("RGB")
            out = dst.with_suffix(dst.suffix.lower() if dst.suffix.lower() in (".jpg", ".jpeg") else ".jpg")
            clean.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)

    before = src.stat().st_size
    after = out.stat().st_size
    print(f"{src} ({before // 1024} KB) -> {out} ({after // 1024} KB)")
    if out != dst and dst.exists() and dst != src:
        print(f"note: wrote {out.name} (format chosen by content), not {dst.name}")


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) == 3 else src
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 1
    dst.parent.mkdir(parents=True, exist_ok=True)
    prepare(src, dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
