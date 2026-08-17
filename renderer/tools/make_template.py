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
    Cards      <- rebuilt from "Title and Vertical Text":
                  title 0, tab heads idx 1-4, card bodies idx 5-8

The Picture layout's idx 1 is a real PICTURE placeholder, so images bind
via insert_picture() and keep their <p:ph> reference.

Cards is constructed placeholder by placeholder: four tab-topped cards
in a row, each a rounded-top tab (accent1-4 fill, centred bold light
text) over a body panel (bg2 fill). Slides inherit all of that styling
through normal placeholder inheritance, so the renderer just writes
text into idx 1-8.

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

CARDS_SOURCE_LAYOUT = "Title and Vertical Text"

NSMAP = (
    f'xmlns:a="{A_NS}" '
    f'xmlns:p="{P_NS}"'
)

_CARD_TAB_XML = """\
<p:sp {ns}>
  <p:nvSpPr>
    <p:cNvPr id="{id}" name="Card {n} Tab"/>
    <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
    <p:nvPr><p:ph type="body" sz="quarter" idx="{idx}"/></p:nvPr>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
    <a:prstGeom prst="round2SameRect">
      <a:avLst><a:gd name="adj1" fmla="val 25000"/><a:gd name="adj2" fmla="val 0"/></a:avLst>
    </a:prstGeom>
    <a:solidFill><a:schemeClr val="{accent}"/></a:solidFill>
  </p:spPr>
  <p:txBody>
    <a:bodyPr anchor="ctr" lIns="91440" rIns="91440" tIns="0" bIns="0"/>
    <a:lstStyle>
      <a:lvl1pPr algn="ctr" marL="0" indent="0"><a:buNone/>
        <a:defRPr sz="1500" b="1"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:defRPr>
      </a:lvl1pPr>
    </a:lstStyle>
    <a:p><a:endParaRPr/></a:p>
  </p:txBody>
</p:sp>
"""

_CARD_BODY_XML = """\
<p:sp {ns}>
  <p:nvSpPr>
    <p:cNvPr id="{id}" name="Card {n} Body"/>
    <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
    <p:nvPr><p:ph type="body" sz="quarter" idx="{idx}"/></p:nvPr>
  </p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    <a:solidFill><a:schemeClr val="bg2"/></a:solidFill>
  </p:spPr>
  <p:txBody>
    <a:bodyPr lIns="91440" rIns="91440" tIns="82296" bIns="82296">
      <a:normAutofit/>
    </a:bodyPr>
    <a:lstStyle>
      <a:lvl1pPr><a:defRPr sz="1300"/></a:lvl1pPr>
      <a:lvl2pPr><a:defRPr sz="1100"/></a:lvl2pPr>
    </a:lstStyle>
    <a:p><a:endParaRPr/></a:p>
  </p:txBody>
</p:sp>
"""


def build_cards_layout(prs: Presentation) -> None:
    """Turn the unused vertical-text layout into the Cards layout."""
    EMU_PER_IN = 914400
    layout = next(
        (
            lo
            for master in prs.slide_masters
            for lo in master.slide_layouts
            if lo.name == CARDS_SOURCE_LAYOUT
        ),
        None,
    )
    if layout is None:
        raise SystemExit(f"layout {CARDS_SOURCE_LAYOUT!r} not found for Cards rebuild")
    layout.element.cSld.set("name", "Cards")

    # Drop the vertical body placeholder; keep title and chrome.
    for ph in list(layout.placeholders):
        fmt = ph.placeholder_format
        if fmt.idx not in (0,) and fmt.idx < 10:
            el = ph._element
            el.getparent().remove(el)

    sp_tree = layout.element.cSld.find(f"{{{P_NS}}}spTree")
    slide_w = prs.slide_width

    margin = int(0.33 * EMU_PER_IN)
    gap = int(0.17 * EMU_PER_IN)
    card_w = (slide_w - 2 * margin - 3 * gap) // 4
    top = int(1.80 * EMU_PER_IN)
    tab_h = int(0.55 * EMU_PER_IN)
    body_h = int(4.75 * EMU_PER_IN)

    for n in range(1, 5):
        x = margin + (n - 1) * (card_w + gap)
        tab = _CARD_TAB_XML.format(
            ns=NSMAP, id=20 + n, n=n, idx=n,
            x=x, y=top, cx=card_w, cy=tab_h, accent=f"accent{n}",
        )
        body = _CARD_BODY_XML.format(
            ns=NSMAP, id=24 + n, n=n, idx=4 + n,
            x=x, y=top + tab_h, cx=card_w, cy=body_h,
        )
        sp_tree.append(etree.fromstring(tab))
        sp_tree.append(etree.fromstring(body))


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

    build_cards_layout(prs)
    color_master_list_levels(prs)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))
    print(f"wrote {out_path} with layouts: {sorted(renamed)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
