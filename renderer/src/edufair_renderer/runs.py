"""Inline text -> styled runs.

Authors write a small markdown subset inside any text:

    **bold**  *italic*  ***bold italic***
    x^2^      superscript          H~2~O     subscript
    ~~struck~~                     __underlined__
    `code`

Marks nest — `**CO~2~ uptake**` is ordinary scientific prose — so this is
a tokenizer, not a split regex: a regex that splits on delimiters cannot
express a mark inside a mark.

Colour is not inline syntax. It is declared per item or per region in
YAML and resolves to a theme colour slot, so the palette stays owned by
the template.

Typeface is the one exception, and only for `code`: OOXML themes define
major and minor fonts but no monospace slot, so a code run has to name a
font. That name belongs to the library, not to this renderer — it comes
from `_style.code_typeface` in layout-map.yaml.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from pathlib import Path

from lxml import etree

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

# DrawingML expresses super/subscript as a baseline shift in per-mille.
SUPERSCRIPT_BASELINE = "30000"
SUBSCRIPT_BASELINE = "-25000"

DEFAULT_CODE_TYPEFACE = "Consolas"


@dataclass
class RunSpec:
    text: str
    bold: bool = False
    italic: bool = False
    superscript: bool = False
    subscript: bool = False
    strike: bool = False
    underline: bool = False
    code: bool = False


_MARKS = tuple(f.name for f in fields(RunSpec) if f.name != "text")

# Longest delimiter first, so ** is not read as two *, and ~~ is tried
# before ~ — otherwise strikethrough would swallow subscript.
_DELIMITERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("***", ("bold", "italic")),
    ("**", ("bold",)),
    ("~~", ("strike",)),
    ("__", ("underline",)),
    ("*", ("italic",)),
    ("~", ("subscript",)),
    ("^", ("superscript",)),
    ("`", ("code",)),
)


def _parse(text: str, marks: dict[str, bool]) -> list[RunSpec]:
    runs: list[RunSpec] = []
    literal: list[str] = []
    i, n = 0, len(text)

    def flush() -> None:
        if literal:
            runs.append(RunSpec("".join(literal), **marks))
            literal.clear()

    while i < n:
        for delimiter, names in _DELIMITERS:
            if not text.startswith(delimiter, i):
                continue
            close = text.find(delimiter, i + len(delimiter))
            if close == -1:
                continue  # unclosed: treat as ordinary text
            inner = text[i + len(delimiter) : close]
            if not inner:
                continue  # empty span, e.g. "**" alone
            flush()
            applied = {**marks, **{name: True for name in names}}
            if "code" in names:
                # A code span is literal: markers inside it are content.
                runs.append(RunSpec(inner, **applied))
            else:
                runs.extend(_parse(inner, applied))
            i = close + len(delimiter)
            break
        else:
            literal.append(text[i])
            i += 1

    flush()
    return runs


def parse_emphasis(text: str) -> list[RunSpec]:
    """Split text into runs, one per distinct combination of marks.

    Also the way plain text is recovered for the semantic index: joining
    the runs' text drops every marker.
    """
    return _parse(text, {name: False for name in _MARKS}) or [RunSpec("")]


def _apply_scheme_color(run, scheme_color: str) -> None:
    rPr = run._r.get_or_add_rPr()
    for fill in rPr.findall(f"{{{A_NS}}}solidFill"):
        rPr.remove(fill)
    solid = rPr.makeelement(f"{{{A_NS}}}solidFill", {})
    etree.SubElement(solid, f"{{{A_NS}}}schemeClr").set("val", scheme_color)
    # rPr attributes are XML attributes; solidFill leads its child sequence.
    rPr.insert(0, solid)


def _apply_marks(run, spec: RunSpec, code_typeface: str) -> None:
    if spec.bold:
        run.font.bold = True
    if spec.italic:
        run.font.italic = True
    if spec.underline:
        run.font.underline = True

    rPr = run._r.get_or_add_rPr()
    if spec.superscript:
        rPr.set("baseline", SUPERSCRIPT_BASELINE)
    elif spec.subscript:
        rPr.set("baseline", SUBSCRIPT_BASELINE)
    if spec.strike:
        rPr.set("strike", "sngStrike")
    if spec.code:
        # <a:latin> must follow the fill children, so append rather than
        # insert; python-pptx keeps rPr's child order otherwise valid.
        for existing in rPr.findall(f"{{{A_NS}}}latin"):
            rPr.remove(existing)
        etree.SubElement(rPr, f"{{{A_NS}}}latin").set("typeface", code_typeface)


def write_runs(
    paragraph,
    text: str,
    color: str | None = None,
    code_typeface: str = DEFAULT_CODE_TYPEFACE,
) -> None:
    """Write text into a paragraph as emphasis-parsed, optionally coloured runs.

    A newline inside the text is a line break within the paragraph, and
    becomes `<a:br/>`. Putting it in a run instead makes PowerPoint show
    a space: the break an author typed simply was not there.
    """
    for spec in parse_emphasis(text):
        pieces = spec.text.split(chr(10))
        for i, piece in enumerate(pieces):
            if i:
                etree.SubElement(paragraph._p, f"{{{A_NS}}}br")
            if not piece:
                continue
            run = paragraph.add_run()
            run.text = piece
            _apply_marks(run, spec, code_typeface)
            if color:
                _apply_scheme_color(run, color)


def plain_text(text: str) -> str:
    """The text with every marker removed — what the index stores."""
    return "".join(spec.text for spec in parse_emphasis(text))
