"""Mermaid source -> image resolution.

Order (docs/session-md-format.md):
1. Pre-rendered sibling PNG/SVG committed next to the .mmd source —
   preferred: offline and deterministic.
2. Mermaid CLI (mmdc) on PATH.

Mermaid Ink (network rendering) is deliberately unsupported.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class MermaidError(Exception):
    pass


def resolve_mermaid(src: Path, build_dir: Path) -> Path:
    """Return the path of a rendered image for the given .mmd source."""
    if not src.exists():
        raise MermaidError(f"mermaid source not found: {src}")

    for ext in (".png", ".svg"):
        candidate = src.with_suffix(ext)
        if candidate.exists():
            return candidate

    mmdc = shutil.which("mmdc")
    if mmdc is None:
        raise MermaidError(
            f"no pre-rendered image next to {src} and mmdc (Mermaid CLI) is not on PATH. "
            f"Commit {src.with_suffix('.png').name} beside the source, or install "
            f"@mermaid-js/mermaid-cli."
        )

    build_dir.mkdir(parents=True, exist_ok=True)
    out = build_dir / (src.stem + ".png")
    result = subprocess.run(
        [mmdc, "-i", str(src), "-o", str(out), "--quiet"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not out.exists():
        raise MermaidError(f"mmdc failed for {src}: {result.stderr.strip()}")
    return out
