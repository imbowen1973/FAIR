"""`fair-doctemplate` — what a Word template offers, and the map to bind to.

The same job `fair-template` does for a .pptx, and for the same reason.
Before anything can render, somebody has to answer: which of this
template's styles is the body text, which is a callout, what is a figure
caption called here? That answer is `style-map.yaml`, and this writes a
draft of it from the template itself.

It also reports what the template does *not* have. A document bound to a
style the template lacks does not fail — Word silently falls back to
Normal — so it renders wrong instead of loudly. Saying so here is the
only place it can be caught cheaply.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

from .template import (
    STYLE_ROLES,
    WordTemplateError,
    draft_style_map,
    inspect_template,
)


def report_lines(report) -> list[str]:
    """The human half: what is here, what is missing, what to do."""
    lines = [
        f"{report.path.name}",
        f"  {len(report.paragraph_styles)} paragraph styles, "
        f"{len(report.character_styles)} character, {len(report.table_styles)} table",
    ]

    if report.controls:
        lines.append(f"  content controls: {', '.join(report.controls)}")
    else:
        lines.append(
            "  content controls: none. Add them for the title, project and "
            "funding statement and the renderer will fill them."
        )

    draft = draft_style_map(report)
    served = set(draft["styles"])
    unserved = [role for role in STYLE_ROLES if role not in served]
    if unserved:
        lines.append("")
        lines.append("  This template has no style for:")
        for role in unserved:
            lines.append(f"    {role}")
        lines.append(
            "  Define one in Word and name it in style-map.yaml, or those "
            "blocks will render as body text."
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="fair-doctemplate",
        description=(
            "Inspect a Word template (.docx, .dotx or .dotm) and emit a draft "
            "style-map.yaml plus a conformance report"
        ),
    )
    ap.add_argument("template", type=Path)
    ap.add_argument(
        "--styles",
        type=Path,
        default=None,
        metavar="OUT",
        help="write style-map.yaml here (default: stdout)",
    )
    ap.add_argument("--quiet", action="store_true", help="suppress the report")
    args = ap.parse_args(argv)

    try:
        report = inspect_template(args.template)
    except WordTemplateError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not args.quiet:
        for line in report_lines(report):
            print(line, file=sys.stderr)

    text = yaml.safe_dump(draft_style_map(report), sort_keys=False, allow_unicode=True)
    if args.styles:
        args.styles.write_text(text, encoding="utf-8")
        if not args.quiet:
            print(f"\nwrote {args.styles}", file=sys.stderr)
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
