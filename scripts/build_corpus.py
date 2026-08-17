"""Build this repo's example corpus into the assembler's data directory.

Thin wrapper over `fair-corpus` (fair_renderer.corpus) with the FAIR
repo's paths. Library repos call `fair-corpus` directly from CI with
their own paths — see docs/platform-architecture.md.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "renderer" / "src"))

from fair_renderer.corpus import build_corpus, CorpusError  # noqa: E402


def main() -> int:
    try:
        summary = build_corpus(
            sessions_dir=REPO / "examples" / "sessions",
            template=REPO / "examples" / "template.pptx",
            layout_map=REPO / "examples" / "layout-map.yaml",
            out_dir=REPO / "assembler" / "web" / "data",
        )
    except CorpusError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(
        f"wrote {summary['catalog']}: {summary['sessions']} sessions, "
        f"{summary['slides']} slides, {summary['competencies']} competencies"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
