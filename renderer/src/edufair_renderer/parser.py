"""Parser for the session.md format (docs/session-md-format.md)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

RESERVED_SLIDE_KEYS = {"id", "layout", "notes", "develops", "outcomes", "dok", "role"}

# A slide with a role is filled from the library rather than typed. The
# session title and its learning outcomes are already written down --
# in block.yaml and outcomes.yaml -- and writing them again on a slide
# is how a deck comes to disagree with the course it belongs to.
SLIDE_ROLES = {"title", "outcomes"}
CONTENT_TYPES = {"ul", "ol", "p", "image", "mermaid", "video"}

# How a picture meets its frame. Mirrors render.IMAGE_FITS, and is
# declared here so the grammar can refuse an unknown one at parse time
# rather than silently falling back at render time.
IMAGE_FITS = ("cover", "contain", "width", "height")
MAX_LIST_DEPTH = 5

# Theme colour slots authors may reference. These resolve through the
# template's theme, so a rebrand recolours every deck without touching
# any session file. Raw hex is deliberately not allowed.
SCHEME_COLORS = {
    "dk1", "lt1", "dk2", "lt2",
    "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink",
}


def _check_color(color, where: str) -> str | None:
    if color is None:
        return None
    if color not in SCHEME_COLORS:
        raise SessionParseError(
            f"{where}: color {color!r} is not a theme colour; "
            f"use one of {sorted(SCHEME_COLORS)}"
        )
    return color


class SessionParseError(Exception):
    """Raised when a session file violates the session.md grammar."""


@dataclass
class ListItem:
    text: str
    children: list["ListItem"] = field(default_factory=list)
    color: str | None = None  # theme colour slot, e.g. "accent2"
    # A line inside a list that carries no bullet. One placeholder often
    # has to hold a lead-in sentence, then the points, then a closing
    # line -- splitting that across regions is not possible when the
    # layout offers one, and inventing a second region would be a layout
    # decision made by the content.
    bullet: bool = True


@dataclass
class Region:
    name: str
    type: str  # "text" (plain string), "p", "ul", "ol", "image", "mermaid"
    text: str | None = None
    items: list[ListItem] = field(default_factory=list)
    src: str | None = None
    color: str | None = None  # default theme colour for the region's items
    url: str | None = None  # video: external hosting URL (https)
    # How a picture meets its frame: cover, contain, width, height.
    # The template knows the shape of the hole; only the author knows
    # whether this picture may lose its edges.
    fit: str | None = None


@dataclass
class Slide:
    id: str
    layout: str
    regions: list[Region]
    notes: str | None = None
    # What the slide claims directly. The competencies it actually
    # develops are derived from this plus its outcomes — see
    # outcomes.derive_develops.
    develops: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)
    dok: int | None = None
    # "title" or "outcomes": filled from the library, not typed here.
    role: str | None = None


@dataclass
class Session:
    frontmatter: dict
    slides: list[Slide]
    source_path: Path

    @property
    def session_id(self) -> str:
        return str(self.frontmatter["session"])


def _split_blocks(text: str, path: Path) -> tuple[str, list[tuple[int, str]]]:
    """Split raw file text into (frontmatter_yaml, [(lineno, slide_yaml)])."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SessionParseError(f"{path}: file must begin with '---' frontmatter")

    fm_end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            fm_end = i
            break
    if fm_end is None:
        raise SessionParseError(f"{path}: unterminated frontmatter block")

    frontmatter = "\n".join(lines[1:fm_end])

    blocks: list[tuple[int, str]] = []
    i = fm_end + 1
    while i < len(lines):
        line = lines[i].strip()
        if line == "":
            i += 1
            continue
        if line != "--- slide":
            raise SessionParseError(
                f"{path}:{i + 1}: expected '--- slide' or blank line, got {lines[i]!r}"
            )
        start = i + 1
        end = None
        for j in range(start, len(lines)):
            if lines[j].strip() == "---":
                end = j
                break
        if end is None:
            raise SessionParseError(f"{path}:{i + 1}: unterminated slide block")
        blocks.append((start + 1, "\n".join(lines[start:end])))
        i = end + 1

    return frontmatter, blocks


def _parse_list_items(raw, where: str, depth: int = 0) -> list[ListItem]:
    if depth >= MAX_LIST_DEPTH:
        raise SessionParseError(f"{where}: list nesting exceeds {MAX_LIST_DEPTH} levels")
    if not isinstance(raw, list):
        raise SessionParseError(f"{where}: 'items' must be a list")
    items = []
    for entry in raw:
        if isinstance(entry, str):
            items.append(ListItem(text=entry))
        elif isinstance(entry, dict) and "text" in entry:
            children = _parse_list_items(entry.get("items", []), where, depth + 1)
            bullet = entry.get("bullet", True)
            if not isinstance(bullet, bool):
                raise SessionParseError(
                    f"{where}: 'bullet' must be true or false, got {bullet!r}"
                )
            items.append(
                ListItem(
                    text=str(entry["text"]),
                    children=children,
                    color=_check_color(entry.get("color"), where),
                    bullet=bullet,
                )
            )
        else:
            raise SessionParseError(
                f"{where}: list item must be a string or {{text, items}}, got {entry!r}"
            )
    return items


def _parse_region(name: str, raw, where: str) -> Region:
    # A plain string anywhere is a single unadorned text paragraph —
    # titles, column headings, captions.
    if isinstance(raw, str):
        return Region(name=name, type="text", text=raw)
    if name == "title":
        raise SessionParseError(f"{where}: 'title' must be a plain string")

    if not isinstance(raw, dict) or "type" not in raw:
        raise SessionParseError(f"{where}: region '{name}' must be a string or {{type: ...}}")
    ctype = raw["type"]
    if ctype not in CONTENT_TYPES:
        raise SessionParseError(
            f"{where}: region '{name}' has unknown type {ctype!r}; "
            f"expected one of {sorted(CONTENT_TYPES)}"
        )
    if ctype in ("ul", "ol"):
        return Region(
            name=name,
            type=ctype,
            items=_parse_list_items(raw.get("items"), where),
            color=_check_color(raw.get("color"), where),
        )
    if ctype == "p":
        text = raw.get("text")
        if not isinstance(text, str) or not text:
            raise SessionParseError(f"{where}: region '{name}' of type p requires 'text'")
        return Region(
            name=name, type="p", text=text, color=_check_color(raw.get("color"), where)
        )
    if ctype == "video":
        # Video is never embedded: it lives on a host (YouTube etc.) and
        # the slide carries a click-through poster. Keeps repos small.
        url = raw.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise SessionParseError(
                f"{where}: region '{name}' of type video requires an https 'url'"
            )
        poster = raw.get("poster")
        if poster is not None and (not isinstance(poster, str) or not poster):
            raise SessionParseError(f"{where}: video 'poster' must be a path")
        return Region(
            name=name, type="video", url=url, src=poster, fit=raw.get("fit")
        )
    # image / mermaid
    src = raw.get("src")
    if not isinstance(src, str) or not src:
        raise SessionParseError(f"{where}: region '{name}' of type {ctype} requires 'src'")
    fit = raw.get("fit")
    if fit is not None and fit not in IMAGE_FITS:
        raise SessionParseError(
            f"{where}: region '{name}': fit must be one of {sorted(IMAGE_FITS)}"
        )
    return Region(name=name, type=ctype, src=src, fit=fit)


def _parse_slide(lineno: int, raw_yaml: str, path: Path, seen_ids: set[str]) -> Slide:
    where = f"{path}:{lineno}"
    try:
        data = yaml.safe_load(raw_yaml)
    except yaml.YAMLError as e:
        raise SessionParseError(f"{where}: invalid YAML in slide block: {e}") from e
    if not isinstance(data, dict):
        raise SessionParseError(f"{where}: slide block must be a YAML mapping")

    for key in ("id", "layout"):
        if key not in data:
            raise SessionParseError(f"{where}: slide missing required key '{key}'")

    slide_id = str(data["id"])
    if slide_id in seen_ids:
        raise SessionParseError(f"{where}: duplicate slide id {slide_id!r}")
    seen_ids.add(slide_id)

    develops = data.get("develops", [])
    if not isinstance(develops, list):
        raise SessionParseError(f"{where}: 'develops' must be a list")

    outcomes = data.get("outcomes", [])
    if not isinstance(outcomes, list):
        # 'outcomes' used to be a legal region name, since a region is any
        # key that is not reserved. Say so, rather than silently treating
        # an author's region as metadata.
        raise SessionParseError(
            f"{where}: 'outcomes' must be a list of outcome ids from "
            "outcomes.yaml. It is metadata, not a region."
        )

    role = data.get("role")
    if role is not None:
        role = str(role)
        if role not in SLIDE_ROLES:
            raise SessionParseError(
                f"{where}: unknown role {role!r}; known: {sorted(SLIDE_ROLES)}"
            )

    dok = data.get("dok")
    if dok is not None and not isinstance(dok, int):
        raise SessionParseError(f"{where}: 'dok' must be an integer")

    regions = [
        _parse_region(key, value, where)
        for key, value in data.items()
        if key not in RESERVED_SLIDE_KEYS
    ]

    return Slide(
        id=slide_id,
        layout=str(data["layout"]),
        regions=regions,
        notes=data.get("notes"),
        develops=[str(c) for c in develops],
        outcomes=[str(o) for o in outcomes],
        dok=dok,
        role=role,
    )


def parse_session(path: Path) -> Session:
    text = path.read_text(encoding="utf-8")
    fm_yaml, blocks = _split_blocks(text, path)

    try:
        frontmatter = yaml.safe_load(fm_yaml)
    except yaml.YAMLError as e:
        raise SessionParseError(f"{path}: invalid YAML in frontmatter: {e}") from e
    if not isinstance(frontmatter, dict):
        raise SessionParseError(f"{path}: frontmatter must be a YAML mapping")
    for key in ("session", "title", "version"):
        if key not in frontmatter:
            raise SessionParseError(f"{path}: frontmatter missing required key '{key}'")

    seen_ids: set[str] = set()
    slides = [_parse_slide(lineno, raw, path, seen_ids) for lineno, raw in blocks]
    if not slides:
        raise SessionParseError(f"{path}: session contains no slides")

    return Session(frontmatter=frontmatter, slides=slides, source_path=path)
