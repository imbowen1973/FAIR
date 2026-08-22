"""Inline marks, written as WordprocessingML runs.

The grammar is shared with the deck renderer: `parse_emphasis` in
`edufair_renderer.runs` is the one definition of what `**bold**`, `H~2~O`,
`x^2^`, `~~struck~~`, `__underlined__` and `` `code` `` mean, and a
workbook must not disagree with a slide about it.

What is *not* shared is the writing. `runs._apply_marks` speaks
DrawingML — `baseline="30000"`, `strike="sngStrike"`, `<a:latin>` — and
Word speaks a different dialect for the same ideas:

    superscript   <w:vertAlign w:val="superscript"/>
    subscript     <w:vertAlign w:val="subscript"/>
    strike        <w:strike/>
    code          <w:rFonts w:ascii="…" w:hAnsi="…"/>

Links are Word's own relationship-backed hyperlinks rather than a run
property, so they are built here too.
"""

from __future__ import annotations

import re

from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml.ns import qn
from lxml import etree

from ..runs import parse_emphasis

# The monospace face for inline code. Named because OOXML has no notion
# of "the monospace one" — a font has to be chosen, and layout-map.yaml
# already documents this as the single named-font exception.
DEFAULT_CODE_TYPEFACE = "Consolas"

# [text](url), and the image form, which the block parser has already
# lifted out when it stands alone in a paragraph.
LINK = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def _apply_marks(run, spec, code_typeface: str) -> None:
    """A parsed span's marks, as Word run properties."""
    if spec.bold:
        run.font.bold = True
    if spec.italic:
        run.font.italic = True
    if spec.underline:
        run.font.underline = True

    rPr = run._r.get_or_add_rPr()
    if spec.superscript or spec.subscript:
        for existing in rPr.findall(qn("w:vertAlign")):
            rPr.remove(existing)
        element = etree.SubElement(rPr, qn("w:vertAlign"))
        element.set(qn("w:val"), "superscript" if spec.superscript else "subscript")
    if spec.strike:
        etree.SubElement(rPr, qn("w:strike"))
    if spec.code:
        fonts = etree.SubElement(rPr, qn("w:rFonts"))
        for attribute in ("w:ascii", "w:hAnsi", "w:cs"):
            fonts.set(qn(attribute), code_typeface)


def _add_hyperlink(paragraph, text: str, url: str, code_typeface: str) -> None:
    """A real Word hyperlink: a relationship, not blue underlined text.

    Faking one with formatting produces something that looks like a link
    and does nothing when clicked, which is worse than plain text.
    """
    part = paragraph.part
    r_id = part.relate_to(url, RT.HYPERLINK, is_external=True)
    link = etree.SubElement(paragraph._p, qn("w:hyperlink"))
    link.set(qn("r:id"), r_id)

    run = paragraph.add_run()
    link.append(run._r)  # move it inside the hyperlink
    run.text = text
    # Word's built-in character style for links. Present in every
    # template; if a project renames it, the text is still a live link.
    try:
        run.style = paragraph.part.document.styles["Hyperlink"]
    except KeyError:
        run.font.underline = True


def write_runs(paragraph, text: str, code_typeface: str = DEFAULT_CODE_TYPEFACE) -> None:
    """Write marked-up text into a Word paragraph, links and all."""
    cursor = 0
    source = text or ""

    for match in LINK.finditer(source):
        _write_spans(paragraph, source[cursor:match.start()], code_typeface)
        _add_hyperlink(paragraph, match.group(1), match.group(2), code_typeface)
        cursor = match.end()
    _write_spans(paragraph, source[cursor:], code_typeface)


def _write_spans(paragraph, text: str, code_typeface: str) -> None:
    if not text:
        return
    for spec in parse_emphasis(text):
        run = paragraph.add_run()
        run.text = spec.text
        _apply_marks(run, spec, code_typeface)


def plain(text: str) -> str:
    """The text without its markers, for a caption or a table of contents."""
    stripped = LINK.sub(r"\1", text or "")
    return "".join(spec.text for spec in parse_emphasis(stripped))
