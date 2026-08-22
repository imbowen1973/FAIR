"""Command-line entry point: edufair-render."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .layoutmap import LayoutMapError
from .mermaid import MermaidError
from .parser import SessionParseError
from .render import RenderError, render_session


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="edufair-render",
        description="Render a session.md into a template-bound .pptx deck",
    )
    ap.add_argument("session", type=Path, help="path to session.md")
    ap.add_argument("--template", type=Path, required=True, help="path to template.pptx")
    ap.add_argument("--layout-map", type=Path, required=True, help="path to layout-map.yaml")
    ap.add_argument("--out-dir", type=Path, required=True, help="output directory")
    args = ap.parse_args(argv)

    try:
        result = render_session(args.session, args.template, args.layout_map, args.out_dir)
    except (SessionParseError, LayoutMapError, RenderError, MermaidError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    print(f"rendered {result['slide_count']} slides -> {result['pptx']}")
    print(f"  {result['slide_id_map']}")
    print(f"  {result['index']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
