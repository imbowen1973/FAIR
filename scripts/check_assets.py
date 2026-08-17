"""Wrapper for the packaged asset policy gate (fair_renderer.assets).

Kept so `python scripts/check_assets.py [dir]` and imports of
`check_assets` from this path keep working; the implementation lives in
the fair-renderer package so library repos get it too (`fair-assets`).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "renderer" / "src"))

from fair_renderer.assets import (  # noqa: E402,F401
    IMAGE_EXTS,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_EDGE,
    VIDEO_EXTS,
    check_assets,
    main,
)

if __name__ == "__main__":
    raise SystemExit(main())
