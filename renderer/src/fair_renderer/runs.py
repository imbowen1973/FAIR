"""Inline text -> styled runs.

Authors write a small markdown subset inside any text: **bold**,
*italic*, ***bold italic***. Colour is not inline syntax — it is declared
per item or per region in YAML and resolves to a theme colour slot, so
the palette stays owned by the template.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from lxml import etree

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

_EMPHASIS = re.compile(r"(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*)")


@dataclass
class RunSpec:
    text: str
    bold: bool = False
    italic: bool = False


def parse_emphasis(text: str) -> list[RunSpec]:
    runs: list[RunSpec] = []
    for token in _EMPHASIS.split(text):
        if not token:
            continue
        if token.startswith("***") and token.endswith("***") and len(token) > 6:
            runs.append(RunSpec(token[3:-3], bold=True, italic=True))
        elif token.startswith("**") and token.endswith("**") and len(token) > 4:
            runs.append(RunSpec(token[2:-2], bold=True))
        elif token.startswith("*") and token.endswith("*") and len(token) > 2:
            runs.append(RunSpec(token[1:-1], italic=True))
        else:
            runs.append(RunSpec(token))
    return runs or [RunSpec("")]


def _apply_scheme_color(run, scheme_color: str) -> None:
    rPr = run._r.get_or_add_rPr()
    for fill in rPr.findall(f"{{{A_NS}}}solidFill"):
        rPr.remove(fill)
    solid = rPr.makeelement(f"{{{A_NS}}}solidFill", {})
    etree.SubElement(solid, f"{{{A_NS}}}schemeClr").set("val", scheme_color)
    # rPr attributes are XML attributes; solidFill leads its child sequence.
    rPr.insert(0, solid)


def write_runs(paragraph, text: str, color: str | None = None) -> None:
    """Write text into a paragraph as emphasis-parsed, optionally coloured runs."""
    for spec in parse_emphasis(text):
        run = paragraph.add_run()
        run.text = spec.text
        if spec.bold:
            run.font.bold = True
        if spec.italic:
            run.font.italic = True
        if color:
            _apply_scheme_color(run, color)
