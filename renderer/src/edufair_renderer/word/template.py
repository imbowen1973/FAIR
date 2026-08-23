"""Loading a Word template, and finding out what it offers.

A project's branding arrives as whatever Word saved it as — `.docx`,
`.dotx`, `.dotm`. Which of those it is should not be something an author
has to think about, so the loader takes any of them.

python-docx will only open a file whose main part is typed as a
*document*, and refuses a template outright:

    ValueError: file '…' is not a Word file, content type is
    'application/vnd.ms-word.template.macroEnabledTemplate.main+xml'

The fix is small and entirely mechanical: rewrite that one content type
in an in-memory copy of the package before opening it. Everything else —
styles, numbering, headers, footers, section setup, theme — comes through
untouched, which is the whole point of using the template at all.

What the renderer needs from a template is a *contract*: which of its
styles play which semantic role. That contract is `style-map.yaml`, and
this module discovers what is available to put in one.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# The main document part, as a document and as any flavour of template.
DOCUMENT_CT = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)
TEMPLATE_CTS = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
    "application/vnd.ms-word.document.macroEnabled.main+xml",
)

# The semantic roles a document can ask for. A template must name a style
# for each one it wants used; anything missing is reported rather than
# guessed at, because guessing produces a document that looks wrong
# instead of a build that says why.
STYLE_ROLES = (
    "title",
    "h1",
    "h2",
    "h3",
    "body",
    "quote",
    "callout",
    "caption",
    "code",
    "bullets",
    "numbers",
)

# What Word calls these by default. A plain Word template has most of
# them, so a project that has not defined its own still renders.
DEFAULT_STYLES = {
    "title": "Title",
    "h1": "Heading 1",
    "h2": "Heading 2",
    "h3": "Heading 3",
    "body": "Normal",
    "quote": "Quote",
    "callout": "Intense Quote",
    "caption": "Caption",
    "code": "No Spacing",
    "bullets": "List Bullet",
    "numbers": "List Number",
}


class WordTemplateError(Exception):
    pass


@dataclass
class TemplateReport:
    """What a template offers, and where it falls short of the map."""

    path: Path
    paragraph_styles: list[str] = field(default_factory=list)
    character_styles: list[str] = field(default_factory=list)
    table_styles: list[str] = field(default_factory=list)
    controls: list[str] = field(default_factory=list)
    missing: dict[str, str] = field(default_factory=dict)  # role -> wanted style

    @property
    def ok(self) -> bool:
        return not self.missing


def _retyped(data: bytes) -> bytes:
    """The same package, with its main part typed as a document."""
    source = io.BytesIO(data)
    out = io.BytesIO()
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(
        out, "w", zipfile.ZIP_DEFLATED
    ) as zout:
        for item in zin.infolist():
            payload = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                text = payload.decode("utf-8")
                for template_ct in TEMPLATE_CTS:
                    text = text.replace(template_ct, DOCUMENT_CT)
                payload = text.encode("utf-8")
            zout.writestr(item, payload)
    return out.getvalue()


def load_template(path: Path | None):
    """Open a Word template of any flavour, keeping everything but its type.

    `None` is the ordinary case, not a fallback. A .docx carries its own
    styles.xml, and Word's built-in styles are defined against the theme
    rather than against literal fonts and colours:

        Heading 1  <w:rFonts w:asciiTheme="majorHAnsi"/>
                   <w:color w:themeColor="accent1"/>

    So a document that names built-in styles picks up whatever theme is
    in play -- the reader's own Word set-up, or one they apply later. A
    template is for a house style that differs from those built-ins. It
    is never needed to render, and nothing has to ship one.
    """
    if path is None:
        return Document()
    if not path.is_file():
        raise WordTemplateError(f"no such template: {path}")
    data = path.read_bytes()
    if not data.startswith(b"PK"):
        raise WordTemplateError(
            f"{path}: not a Word file (a .doc from before 2007 will not work; "
            "open it in Word and save as .docx)"
        )
    try:
        return Document(io.BytesIO(_retyped(data)))
    except Exception as exc:  # python-docx raises bare ValueError here
        raise WordTemplateError(f"{path}: cannot be opened as a Word file: {exc}") from exc


def style_names(document) -> dict[str, list[str]]:
    """Every style the template defines, by what it can be applied to."""
    kinds: dict[str, list[str]] = {"paragraph": [], "character": [], "table": []}
    for style in document.styles:
        # WD_STYLE_TYPE: 1 paragraph, 2 character, 3 table, 4 list.
        kind = {1: "paragraph", 2: "character", 3: "table"}.get(int(style.type or 0))
        if kind:
            kinds[kind].append(style.name)
    for names in kinds.values():
        names.sort()
    return kinds


def control_tags(document) -> list[str]:
    """Content control tags the template exposes, body and headers alike.

    A tag is the contract: the renderer fills `FAIR.DocumentTitle`
    wherever the template chose to put it, which may be a cover page, a
    header, or nowhere at all.
    """
    tags: list[str] = []
    parts = [document.element.body]
    for section in document.sections:
        for part in (section.header, section.footer,
                     section.even_page_header, section.even_page_footer,
                     section.first_page_header, section.first_page_footer):
            element = getattr(part, "_element", None)
            if element is not None:
                parts.append(element)

    for root in parts:
        for sdt in root.iter(qn("w:sdt")):
            tag = sdt.find(f".//{qn('w:tag')}")
            value = tag.get(qn("w:val")) if tag is not None else None
            if value and value not in tags:
                tags.append(value)
    return sorted(tags)


def inspect_template(path: Path, style_map: dict | None = None) -> TemplateReport:
    """What this template offers, and what a style map would be missing."""
    document = load_template(path)
    kinds = style_names(document)
    wanted = {**DEFAULT_STYLES, **((style_map or {}).get("styles") or {})}

    available = set(kinds["paragraph"])
    missing = {}
    for role in STYLE_ROLES:
        if style_map and role in ((style_map or {}).get("styles") or {}):
            # An explicit map is a promise; check exactly what it names.
            name = style_map["styles"][role]
            if name not in available:
                missing[role] = name
        elif style_for_role(role, available) is None:
            missing[role] = wanted.get(role, role)
    return TemplateReport(
        path=path,
        paragraph_styles=kinds["paragraph"],
        character_styles=kinds["character"],
        table_styles=kinds["table"],
        controls=control_tags(document),
        missing=missing,
    )


# A template brands a role by defining a style named for it. Nothing has
# to be configured: define "FAIR Callout" in Word and callouts use it.
ROLE_PREFIX = "FAIR "

ROLE_TITLES = {
    "title": "Title",
    "h1": "Heading 1",
    "h2": "Heading 2",
    "h3": "Heading 3",
    "body": "Body",
    "quote": "Quote",
    "callout": "Callout",
    "caption": "Caption",
    "code": "Code",
    "bullets": "Bullets",
    "numbers": "Numbers",
}


def style_for_role(role: str, available: set[str]) -> str | None:
    """The template's own style for a role, or Word's default for it.

    A style the template named for the role wins, because defining
    "FAIR Callout" is how a project says what a callout looks like here
    without having to edit a map at all.
    """
    named = f"{ROLE_PREFIX}{ROLE_TITLES.get(role, role.title())}"
    if named in available:
        return named
    fallback = DEFAULT_STYLES.get(role)
    return fallback if fallback in available else None


def draft_style_map(report: TemplateReport) -> dict:
    """A style map this template can actually satisfy.

    Roles the template cannot serve are left out rather than pointed at a
    style that is not there — a map that names a missing style is a
    document that renders wrong.
    """
    available = set(report.paragraph_styles)
    styles = {}
    for role in STYLE_ROLES:
        name = style_for_role(role, available)
        if name:
            styles[role] = name
    out: dict = {"styles": styles}
    if report.table_styles:
        # Word's own default is "Table Grid"; prefer it when present so a
        # plain template produces readable tables without configuration.
        default = "Table Grid" if "Table Grid" in report.table_styles else report.table_styles[0]
        out["tables"] = {"default": default}
    if report.controls:
        out["controls"] = list(report.controls)
    return out
