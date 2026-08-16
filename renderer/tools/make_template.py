"""Generate examples/template.pptx from python-pptx's default template.

Stand-in for the consortium's branded template. The spec layouts map onto
default layouts whose placeholder indices already match layout-map.yaml:

    Title      <- "Title Slide"          (idx 0 title, 1 subtitle)
    Full       <- "Title and Content"    (idx 0 title, 1 content)
    Split      <- "Two Content"          (idx 0 title, 1 left, 2 right)
    Section    <- "Section Header"       (idx 0 title, 1 text)
    Comparison <- "Comparison"           (idx 0 title, 1/3 heads, 2/4 bodies)
    Caption    <- "Content with Caption" (idx 0 title, 1 content, 2 caption)
    Picture    <- "Picture with Caption" (idx 0 title, 1 PICTURE, 2 caption)
    TitleOnly  <- "Title Only"           (idx 0 title)
    Blank      <- "Blank"                (chrome only)

The Picture layout's idx 1 is a real PICTURE placeholder, so images bind
via insert_picture() and keep their <p:ph> reference.

The master's body list styles get theme-bound bullet colours per level
(accent1/2/3 for levels 1-3), so lists and sub-lists are colour-coded on
every layout without any per-slide styling. A branded template replaces
all of this wholesale; only the layout names and indices are contract.

Usage: python tools/make_template.py <output.pptx>
"""

import sys
from pathlib import Path

from lxml import etree
from pptx import Presentation

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

RENAMES = {
    "Title Slide": "Title",
    "Title and Content": "Full",
    "Two Content": "Split",
    "Section Header": "Section",
    "Comparison": "Comparison",
    "Content with Caption": "Caption",
    "Picture with Caption": "Picture",
    "Title Only": "TitleOnly",
    "Blank": "Blank",
}

# Theme colour of the bullet glyph per list level (1-based).
LEVEL_BULLET_COLORS = {1: "accent1", 2: "accent2", 3: "accent3"}

# Members that must follow buClr inside CT_TextParagraphProperties, in
# schema order — buClr has to be inserted before the first one present.
_AFTER_BUCLR = [
    "buSzTx", "buSzPct", "buSzPts", "buFontTx", "buFont",
    "buNone", "buAutoNum", "buChar", "tabLst", "defRPr", "extLst",
]


def _set_bullet_color(lvl_pPr, scheme_color: str) -> None:
    for existing in lvl_pPr.findall(f"{{{A_NS}}}buClr"):
        lvl_pPr.remove(existing)
    bu_clr = etree.SubElement(lvl_pPr, f"{{{A_NS}}}buClr")
    etree.SubElement(bu_clr, f"{{{A_NS}}}schemeClr").set("val", scheme_color)
    anchor = None
    for tag in _AFTER_BUCLR:
        anchor = lvl_pPr.find(f"{{{A_NS}}}{tag}")
        if anchor is not None:
            break
    if anchor is not None:
        anchor.addprevious(bu_clr)
    # else: already appended at the end, which is schema-valid there


def color_master_list_levels(prs: Presentation) -> None:
    for master in prs.slide_masters:
        body_style = master.element.find(
            f"{{{P_NS}}}txStyles/{{{P_NS}}}bodyStyle"
        )
        if body_style is None:
            continue
        for level, color in LEVEL_BULLET_COLORS.items():
            lvl_pPr = body_style.find(f"{{{A_NS}}}lvl{level}pPr")
            if lvl_pPr is not None:
                _set_bullet_color(lvl_pPr, color)


def main(out_path: Path) -> None:
    prs = Presentation()
    renamed = set()
    for master in prs.slide_masters:
        for layout in master.slide_layouts:
            if layout.name in RENAMES:
                new_name = RENAMES[layout.name]
                layout.element.cSld.set("name", new_name)
                renamed.add(new_name)
    missing = set(RENAMES.values()) - renamed
    if missing:
        raise SystemExit(f"default template lacked expected layouts: {missing}")

    color_master_list_levels(prs)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))
    print(f"wrote {out_path} with layouts: {sorted(renamed)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
