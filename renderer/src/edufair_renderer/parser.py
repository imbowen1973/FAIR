"""Parser for the session.md format (docs/session-md-format.md)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import yamlio

RESERVED_SLIDE_KEYS = {"id", "layout", "notes", "develops", "outcomes", "dok", "role"}

# A slide with a role is filled from the library rather than typed. The
# session title and its learning outcomes are already written down --
# in block.yaml and outcomes.yaml -- and writing them again on a slide
# is how a deck comes to disagree with the course it belongs to.
SLIDE_ROLES = {"title", "outcomes"}
CONTENT_TYPES = {"ul", "ol", "p", "table", "image", "mermaid", "video", "smartart"}

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
class SmartArtNode:
    text: str
    children: list["SmartArtNode"] = field(default_factory=list)
    # An org chart's assistant: drawn beside its manager, not under.
    assistant: bool = False


SMARTART_FAMILIES = ("process", "cycle", "hierarchy", "list", "relationship", "matrix", "pyramid")


def _parse_smartart_nodes(raw, where: str, depth: int = 0) -> list[SmartArtNode]:
    if depth >= MAX_LIST_DEPTH:
        raise SessionParseError(f"{where}: SmartArt nesting exceeds {MAX_LIST_DEPTH} levels")
    if not isinstance(raw, list) or (depth == 0 and not raw):
        raise SessionParseError(f"{where}: smartart 'nodes' must be a non-empty list")
    out = []
    for entry in raw:
        if isinstance(entry, (str, int, float)) and not isinstance(entry, bool):
            out.append(SmartArtNode(text=str(entry)))
        elif isinstance(entry, dict) and "text" in entry:
            unknown = set(entry) - {"text", "items", "assistant"}
            if unknown:
                raise SessionParseError(
                    f"{where}: smartart node {entry['text']!r} has unknown key(s) "
                    f"{sorted(unknown)}; a node has text, items and assistant"
                )
            out.append(SmartArtNode(
                text=str(entry["text"]),
                children=_parse_smartart_nodes(entry.get("items") or [], where, depth + 1),
                assistant=bool(entry.get("assistant", False)),
            ))
        else:
            raise SessionParseError(
                f"{where}: smartart node must be a string or {{text, items}}, got {entry!r}"
            )
    return out


@dataclass
class ListItem:
    text: str
    children: list["ListItem"] = field(default_factory=list)
    color: str | None = None  # theme colour slot, e.g. "accent2"
    # What this line is marked with: "bullet", "number", or "none".
    # `None` means "whatever the region is", which is the ordinary case.
    #
    # Per line, because one placeholder often has to hold a lead-in
    # sentence, then the points, then a closing line. Splitting that
    # across regions is not possible when the layout offers one, and
    # inventing a second region would be a layout decision taken by the
    # content.
    marker: str | None = None
    # "left", "center", "right" or "justify" -- again per line, because a
    # centred heading above left-aligned points is one placeholder in
    # every real deck.
    align: str | None = None


@dataclass
class Region:
    name: str
    type: str  # "text" (plain string), "p", "ul", "ol", "image", "mermaid"
    text: str | None = None
    items: list[ListItem] = field(default_factory=list)
    src: str | None = None
    color: str | None = None  # default theme colour for the region's items
    url: str | None = None  # video: external hosting URL (https)
    # table: optional header row and the body rows, each a list of cell
    # strings (inline emphasis applies inside cells).
    header: list[str] | None = None
    rows: list[list[str]] = field(default_factory=list)
    # table: relative column widths (any positive numbers; only the
    # proportions matter). Absent = sized from the content.
    widths: list[float] | None = None
    # table: merged cells. (row, col) of each merge's top-left cell in
    # the full grid (header is row 0 when present) -> (rowspan, colspan).
    # Covered cells are "" in header/rows.
    spans: dict[tuple[int, int], tuple[int, int]] = field(default_factory=dict)
    # How a picture meets its frame: cover, contain, width, height.
    # The template knows the shape of the hole; only the author knows
    # whether this picture may lose its edges.
    fit: str | None = None
    # smartart: the content tree, which of PowerPoint's diagram layouts
    # draws it (short name, e.g. "process3"), and what kind of diagram
    # that is ("process", "cycle", "hierarchy", ...). `src` is the
    # definition file in media/ -- the layout, style and colours the
    # render hands PowerPoint.
    nodes: list["SmartArtNode"] = field(default_factory=list)
    layout: str | None = None
    family: str | None = None


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
    # The slide exactly as the file wrote it, before any of the above was
    # derived from it. Carried so a reader that wants to *draw* the slide
    # -- rather than render it to PowerPoint -- has the same thing the
    # workbench canvas draws from, instead of a Region tree it would have
    # to unpick.
    source: dict = field(default_factory=dict)


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


MARKERS = ("bullet", "number", "none")
ALIGNMENTS = ("left", "center", "right", "justify")


def _check_marker(entry: dict, where: str) -> str | None:
    """What this line is marked with, or None to follow the region.

    `bullet: false` came first and is kept: it is already written into
    libraries and into the authoring prompt, and it means exactly
    `marker: none`.
    """
    marker = entry.get("marker")
    if marker is None:
        bullet = entry.get("bullet")
        if bullet is None:
            return None
        if not isinstance(bullet, bool):
            raise SessionParseError(
                f"{where}: 'bullet' must be true or false, got {bullet!r}"
            )
        return None if bullet else "none"
    if marker not in MARKERS:
        raise SessionParseError(
            f"{where}: 'marker' must be one of {', '.join(MARKERS)}, got {marker!r}"
        )
    return marker


def _check_align(align, where: str) -> str | None:
    if align is None:
        return None
    if align not in ALIGNMENTS:
        raise SessionParseError(
            f"{where}: 'align' must be one of {', '.join(ALIGNMENTS)}, got {align!r}"
        )
    return align


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
            items.append(
                ListItem(
                    text=str(entry["text"]),
                    children=children,
                    color=_check_color(entry.get("color"), where),
                    marker=_check_marker(entry, where),
                    align=_check_align(entry.get("align"), where),
                )
            )
        else:
            raise SessionParseError(
                f"{where}: list item must be a string or {{text, items}}, got {entry!r}"
            )
    return items


MERGE_LEFT = "<"
MERGE_UP = "^"
_ESCAPED = {"\\<": "<", "\\^": "^"}


def _resolve_merges(grid: list[list[str]], where: str) -> dict:
    """Table merge markers -> spans, validated.

    A cell that is exactly "<" belongs to the cell on its left; exactly
    "^" to the cell above. Markers chain, so the interior of a 2x2 block
    may use either. Every merge must cover a whole rectangle with its
    text in the top-left cell. A literal "<" or "^" is written "\\<" or
    "\\^". Returns {(row, col): (rowspan, colspan)} for each merge.
    """
    n_rows, n_cols = len(grid), len(grid[0])

    def origin(r: int, c: int) -> tuple[int, int]:
        while True:
            value = grid[r][c]
            if value == MERGE_LEFT:
                if c == 0:
                    raise SessionParseError(
                        f"{where}: table row {r + 1}: '<' in the first column has "
                        "nothing to its left to merge into"
                    )
                c -= 1
            elif value == MERGE_UP:
                if r == 0:
                    raise SessionParseError(
                        f"{where}: table column {c + 1}: '^' in the first row has "
                        "nothing above it to merge into"
                    )
                r -= 1
            else:
                return r, c

    groups: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for r in range(n_rows):
        for c in range(n_cols):
            groups.setdefault(origin(r, c), []).append((r, c))

    spans = {}
    for (r0, c0), cells in groups.items():
        if len(cells) == 1:
            continue
        r1 = max(r for r, _ in cells)
        c1 = max(c for _, c in cells)
        if min(c for _, c in cells) < c0 or len(cells) != (r1 - r0 + 1) * (c1 - c0 + 1):
            raise SessionParseError(
                f"{where}: table merge starting at row {r0 + 1}, column {c0 + 1} is "
                "not a rectangle — every cell in the block must be '<' or '^'"
            )
        spans[(r0, c0)] = (r1 - r0 + 1, c1 - c0 + 1)
    return spans


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
    if ctype == "table":
        rows = raw.get("rows")
        if not isinstance(rows, list) or not rows:
            raise SessionParseError(
                f"{where}: region '{name}' of type table requires 'rows' (a list of rows)"
            )
        header = raw.get("header")
        if header is not None and not isinstance(header, list):
            raise SessionParseError(f"{where}: table 'header' must be a list of cells")
        width = len(header) if header else len(rows[0])
        cells_h = [str(c) for c in header] if header else None
        cells_rows = []
        for i, row in enumerate(rows):
            if not isinstance(row, list):
                raise SessionParseError(f"{where}: table row {i + 1} must be a list of cells")
            if len(row) != width:
                raise SessionParseError(
                    f"{where}: table row {i + 1} has {len(row)} cells; expected {width}"
                )
            cells_rows.append([str(c) for c in row])
        widths = raw.get("widths")
        if widths is not None:
            if (
                not isinstance(widths, list)
                or len(widths) != width
                or not all(
                    isinstance(w, (int, float)) and not isinstance(w, bool) and w > 0
                    for w in widths
                )
            ):
                raise SessionParseError(
                    f"{where}: table 'widths' must be {width} positive numbers, "
                    "one per column (only their proportions matter)"
                )
            widths = [float(w) for w in widths]
        grid = ([cells_h] if cells_h else []) + cells_rows
        spans = _resolve_merges(grid, f"{where}: region '{name}'")
        covered = {
            (r0 + i, c0 + j)
            for (r0, c0), (rs, cs) in spans.items()
            for i in range(rs)
            for j in range(cs)
            if (i, j) != (0, 0)
        }
        grid = [
            ["" if (r, c) in covered else _ESCAPED.get(v, v) for c, v in enumerate(row)]
            for r, row in enumerate(grid)
        ]
        if cells_h:
            cells_h, cells_rows = grid[0], grid[1:]
        else:
            cells_rows = grid
        return Region(
            name=name, type="table", header=cells_h, rows=cells_rows,
            widths=widths, spans=spans,
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
    if ctype == "smartart":
        definition = raw.get("definition")
        if not isinstance(definition, str) or not definition:
            raise SessionParseError(
                f"{where}: region '{name}' of type smartart requires 'definition' "
                "(the media/*.xml file import wrote beside it)"
            )
        family = raw.get("family")
        if family is not None and family not in SMARTART_FAMILIES:
            raise SessionParseError(
                f"{where}: smartart family {family!r} is not one of {list(SMARTART_FAMILIES)}"
            )
        layout = raw.get("layout")
        return Region(
            name=name, type="smartart", src=definition,
            nodes=_parse_smartart_nodes(raw.get("nodes"), f"{where}: region '{name}'"),
            layout=str(layout) if layout is not None else None, family=family,
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
        data = yamlio.safe_load(raw_yaml)
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
        source=data,
    )


def parse_session(path: Path) -> Session:
    text = path.read_text(encoding="utf-8")
    fm_yaml, blocks = _split_blocks(text, path)

    try:
        frontmatter = yamlio.safe_load(fm_yaml)
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
