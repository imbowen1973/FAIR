"""The Word renderer: loading a template and reading what it offers."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest
from docx import Document
from docx.oxml.ns import qn
from lxml import etree

from fair_renderer.word.template import (
    DOCUMENT_CT,
    TEMPLATE_CTS,
    WordTemplateError,
    control_tags,
    draft_style_map,
    inspect_template,
    load_template,
    style_for_role,
)


def _branded(path: Path, *, styles=(), controls=()) -> Path:
    """A Word file with named styles and content controls, as a project would brand one."""
    document = Document()
    for name in styles:
        document.styles.add_style(name, 1)  # 1 = paragraph style
    body = document.element.body
    for tag_value in controls:
        sdt = etree.SubElement(body, qn("w:sdt"))
        properties = etree.SubElement(sdt, qn("w:sdtPr"))
        tag = etree.SubElement(properties, qn("w:tag"))
        tag.set(qn("w:val"), tag_value)
        content = etree.SubElement(sdt, qn("w:sdtContent"))
        etree.SubElement(content, qn("w:p"))
    document.save(path)
    return path


def _retype(src: Path, dst: Path, content_type: str) -> Path:
    """The same package, typed as a template rather than a document."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(DOCUMENT_CT.encode(), content_type.encode())
            zout.writestr(item, data)
    return dst


@pytest.mark.parametrize("content_type", TEMPLATE_CTS[:2], ids=["dotx", "dotm"])
def test_a_template_opens_whatever_word_saved_it_as(tmp_path, content_type):
    """python-docx refuses a template outright; the loader retypes it first.

    Which flavour the branding arrives in is not something an author
    should have to think about.
    """
    src = _branded(tmp_path / "brand.docx", styles=["FAIR Callout"])
    template = _retype(src, tmp_path / "brand.template", content_type)

    document = load_template(template)
    assert "FAIR Callout" in [s.name for s in document.styles], (
        "the template's own styles must survive the retype — they are the point of it"
    )


def test_a_plain_docx_opens_too(tmp_path):
    src = _branded(tmp_path / "brand.docx", styles=["FAIR Callout"])
    assert "FAIR Callout" in [s.name for s in load_template(src).styles]


def test_an_old_binary_doc_is_refused_with_a_way_out(tmp_path):
    old = tmp_path / "handbook.doc"
    old.write_bytes(b"\xd0\xcf\x11\xe0 an OLE2 document from 2003")
    with pytest.raises(WordTemplateError, match="save as .docx"):
        load_template(old)


def test_content_controls_are_found_by_tag(tmp_path):
    # The tag is the contract: the renderer fills FAIR.DocumentTitle
    # wherever the template chose to put it.
    src = _branded(
        tmp_path / "brand.docx",
        controls=["FAIR.DocumentTitle", "FAIR.FundingStatement"],
    )
    assert control_tags(load_template(src)) == [
        "FAIR.DocumentTitle",
        "FAIR.FundingStatement",
    ]


def test_a_template_brands_a_role_by_naming_a_style_for_it(tmp_path):
    """Define "FAIR Callout" in Word and callouts use it — no map to edit."""
    src = _branded(tmp_path / "brand.docx", styles=["FAIR Callout", "FAIR Body"])
    styles = draft_style_map(inspect_template(src))["styles"]

    assert styles["callout"] == "FAIR Callout"
    assert styles["body"] == "FAIR Body"
    # Roles the project has not branded fall back to Word's own.
    assert styles["h1"] == "Heading 1"
    assert styles["quote"] == "Quote"


def test_a_role_the_template_cannot_serve_is_left_out_not_guessed(tmp_path):
    # A map naming a style that is not there renders wrong rather than
    # failing: Word silently falls back to Normal.
    available = {"Heading 1", "Normal"}
    assert style_for_role("h1", available) == "Heading 1"
    assert style_for_role("callout", available) is None

    src = _branded(tmp_path / "brand.docx")
    report = inspect_template(src)
    styles = draft_style_map(report)["styles"]
    for role, name in styles.items():
        assert name in report.paragraph_styles, f"{role} points at a style that is not there"


def test_an_explicit_map_is_checked_exactly_as_written(tmp_path):
    """A map is a promise, so it is checked against the template as given."""
    src = _branded(tmp_path / "brand.docx")
    report = inspect_template(src, {"styles": {"callout": "House Callout"}})
    assert report.missing.get("callout") == "House Callout"
    assert not report.ok


def test_a_plain_word_template_still_renders(tmp_path):
    """A project that has branded nothing must still get a document."""
    src = _branded(tmp_path / "plain.docx")
    styles = draft_style_map(inspect_template(src))["styles"]
    for role in ("title", "h1", "h2", "body", "quote", "caption", "bullets", "numbers"):
        assert role in styles, f"Word's own default for {role} should have been found"
