"""Asset policy gate: keep the repo small and the builds honest.

Rules (docs/session-md-format.md):
- no video binaries in the repo, ever — video is hosted (YouTube etc.)
  and referenced with the `video` content type
- committed images: <= 500 KB and <= 2200 px on the long edge; run
  scripts/prepare_image.py to get any image under the caps

Run standalone (scans examples/sessions) or via build_corpus, which
refuses to build a corpus that violates policy. Exit code 1 on any
violation, listing every offender.
"""

from __future__ import annotations

import sys
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_IMAGE_BYTES = 500_000
MAX_IMAGE_EDGE = 2200


def check_assets(root: Path) -> list[str]:
    errors: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        rel = path.relative_to(root)
        if ext in VIDEO_EXTS:
            errors.append(
                f"{rel}: video files are not allowed in the repo — host it "
                f"(YouTube etc.) and reference it with a {{type: video, url: ...}} region"
            )
        elif ext in IMAGE_EXTS:
            size = path.stat().st_size
            if size > MAX_IMAGE_BYTES:
                errors.append(
                    f"{rel}: {size // 1024} KB exceeds the {MAX_IMAGE_BYTES // 1000} KB cap — "
                    f"run scripts/prepare_image.py on it"
                )
            try:
                from PIL import Image

                with Image.open(path) as im:
                    edge = max(im.size)
                if edge > MAX_IMAGE_EDGE:
                    errors.append(
                        f"{rel}: {edge} px long edge exceeds {MAX_IMAGE_EDGE} px — "
                        f"run scripts/prepare_image.py on it"
                    )
            except Exception:
                errors.append(f"{rel}: unreadable as an image")
    return errors


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parents[1] / "examples" / "sessions"
    )
    errors = check_assets(root)
    if errors:
        print("asset policy violations:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    print(f"asset policy OK under {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
