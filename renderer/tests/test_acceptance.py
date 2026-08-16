"""Acceptance tests for spec A.6, plus the creationId contract.

Criterion numbering follows docs/md-to-powerpoint-pipeline.md section A.6.
"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

import pytest
from lxml import etree

from fair_renderer.render import render_session

REPO = Path(__file__).resolve().parents[2]
EXAMPLES = REPO / "examples"

P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"p": P_NS, "a": A_NS, "p14": P14_NS}


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    out_dir = tmp_path_factory.mktemp("out")
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-01.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out_dir,
    )
    return result


def _slide_xml(pptx_path: Path, n: int) -> etree._Element:
    with zipfile.ZipFile(pptx_path) as z:
        return etree.fromstring(z.read(f"ppt/slides/slide{n}.xml"))


def _slide_layout_name(pptx_path: Path, n: int) -> str:
    with zipfile.ZipFile(pptx_path) as z:
        rels = etree.fromstring(z.read(f"ppt/slides/_rels/slide{n}.xml.rels"))
        layout_target = None
        for rel in rels:
            if rel.get("Type").endswith("/slideLayout"):
                layout_target = rel.get("Target").replace("../", "ppt/")
        assert layout_target, f"slide{n} has no slideLayout relationship"
        layout = etree.fromstring(z.read(layout_target))
        return layout.find(f"{{{P_NS}}}cSld").get("name")


def test_a6_1_slide_references_split_layout(rendered):
    """Slide s01-03 (deck slide 3) must reference the Split layout."""
    assert _slide_layout_name(rendered["pptx"], 3) == "Split"


def test_a6_2_placeholder_indices_present(rendered):
    """Slide XML must carry <p:ph> references with idx 0, 1, 2.

    (idx attribute is omitted for idx 0 title placeholders per OOXML —
    a <p:ph type="title"> with no idx attribute IS idx 0.)
    """
    root = _slide_xml(rendered["pptx"], 3)
    phs = root.findall(f".//{{{P_NS}}}ph")
    indices = set()
    for ph in phs:
        idx = ph.get("idx")
        indices.add(int(idx) if idx is not None else 0)
    assert indices == {0, 1, 2}, f"expected placeholder idx {{0,1,2}}, got {indices}"


def test_a6_3_content_in_correct_placeholders(rendered):
    """Left content in idx 1, right content in idx 2 — not swapped or merged."""
    root = _slide_xml(rendered["pptx"], 3)
    text_by_idx = {}
    for sp in root.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None:
            continue
        idx = int(ph.get("idx") or 0)
        texts = [t.text or "" for t in sp.findall(f".//{{{A_NS}}}t")]
        text_by_idx[idx] = texts
    assert "Temperature logging" in text_by_idx[1]
    assert "Sensor thresholds" in text_by_idx[1]
    assert "Receive shipment" in text_by_idx[2]
    assert "Temperature logging" not in text_by_idx[2]
    assert "Receive shipment" not in text_by_idx[1]
    assert text_by_idx[0] == ["Cold chain integrity"]


def test_a6_3b_nesting_levels(rendered):
    """Nested ul items must carry paragraph level attributes."""
    root = _slide_xml(rendered["pptx"], 3)
    for sp in root.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None or int(ph.get("idx") or 0) != 1:
            continue
        levels = {}
        for p in sp.findall(f".//{{{A_NS}}}p"):
            texts = [t.text or "" for t in p.findall(f".//{{{A_NS}}}t")]
            pPr = p.find(f"{{{A_NS}}}pPr")
            lvl = int(pPr.get("lvl")) if pPr is not None and pPr.get("lvl") else 0
            if texts:
                levels["".join(texts)] = lvl
        assert levels["Temperature logging"] == 0
        assert levels["Sensor thresholds"] == 1
        assert levels["Manual inspection"] == 1
        assert levels["Audit trail"] == 0
        return
    pytest.fail("left placeholder (idx 1) not found")


def test_a6_4_text_is_editable_runs(rendered):
    """Text must be <a:t> runs inside <p:sp> shapes, not rasterised images."""
    root = _slide_xml(rendered["pptx"], 3)
    runs = root.findall(f".//{{{P_NS}}}sp//{{{A_NS}}}t")
    assert len(runs) >= 7
    pics = root.findall(f".//{{{P_NS}}}pic")
    assert pics == [], "text slide must not contain rasterised pictures"


def test_a6_5_deterministic_output(rendered, tmp_path):
    """Two runs of the same input must produce byte-identical files."""
    out2 = tmp_path / "run2"
    result2 = render_session(
        session_path=EXAMPLES / "sessions" / "session-01.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out2,
    )
    assert rendered["pptx"].read_bytes() == result2["pptx"].read_bytes()
    assert (
        rendered["slide_id_map"].read_text() == result2["slide_id_map"].read_text()
    )
    assert rendered["index"].read_text() == result2["index"].read_text()


def test_creation_id_present_and_mapped(rendered):
    """Every slide carries p14:creationId, and slide-id-map.json matches the XML."""
    slide_id_map = json.loads(rendered["slide_id_map"].read_text())
    assert set(slide_id_map) == {"s01-01", "s01-02", "s01-03", "s01-04", "s01-05"}

    with zipfile.ZipFile(rendered["pptx"]) as z:
        # presentation.xml gives authored order of slide ids
        pres = etree.fromstring(z.read("ppt/presentation.xml"))
        sld_ids = [
            int(el.get("id"))
            for el in pres.findall(f".//{{{P_NS}}}sldIdLst/{{{P_NS}}}sldId")
        ]
        creation_ids = []
        for n in range(1, 6):
            root = etree.fromstring(z.read(f"ppt/slides/slide{n}.xml"))
            cid = root.find(f".//{{{P14_NS}}}creationId")
            assert cid is not None, f"slide{n} missing p14:creationId"
            creation_ids.append(int(cid.get("val")))

    expected_refs = {f"{sid}#{cid}" for sid, cid in zip(sld_ids, creation_ids)}
    assert set(slide_id_map.values()) == expected_refs
    for ref in slide_id_map.values():
        assert re.fullmatch(r"\d+#\d+", ref), f"bad sourceRef format: {ref}"


def test_creation_id_is_stable():
    from fair_renderer.creation_id import derive_creation_id

    a = derive_creation_id("01", "s01-03")
    b = derive_creation_id("01", "s01-03")
    assert a == b
    assert 1 <= a <= 0x7FFFFFFF
    assert derive_creation_id("01", "s01-04") != a


def test_index_json_contract(rendered):
    """index.json carries the semantic fields the assembler and graph need."""
    doc = json.loads(rendered["index"].read_text())
    assert doc["session"]["session"] == "01"
    slides = {s["slideId"]: s for s in doc["slides"]}
    entry = slides["s01-03"]
    assert entry["sessionId"] == "01"
    assert entry["sourcePptx"] == "session-01.pptx"
    assert entry["title"] == "Cold chain integrity"
    assert entry["develops"] == ["C1", "C4"]
    assert entry["dok"] == 2
    assert re.fullmatch(r"\d+#\d+", entry["sourceRef"])


def test_notes_written(rendered):
    with zipfile.ZipFile(rendered["pptx"]) as z:
        names = [n for n in z.namelist() if n.startswith("ppt/notesSlides/notesSlide")]
        assert names, "no notes slides emitted"
        found = any(
            b"integrity pillars" in z.read(n) for n in names
        )
    assert found, "speaker notes text not found in any notes slide"


def test_picture_placeholder_keeps_binding(rendered):
    """The Picture layout's image binds into the picture placeholder —
    the <p:pic> itself carries <p:ph idx=1>, no free-positioning."""
    root = _slide_xml(rendered["pptx"], 4)
    pics = root.findall(f".//{{{P_NS}}}pic")
    assert len(pics) == 1
    ph = pics[0].find(f".//{{{P_NS}}}ph")
    assert ph is not None, "picture must retain its placeholder reference"
    assert int(ph.get("idx") or 0) == 1


def test_caption_plain_text_suppresses_bullets(rendered):
    """The p-type caption renders paragraphs with buNone and bold emphasis."""
    root = _slide_xml(rendered["pptx"], 4)
    for sp in root.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None or int(ph.get("idx") or 0) != 2:
            continue
        paragraphs = sp.findall(f".//{{{A_NS}}}p")
        assert len(paragraphs) == 2
        for p in paragraphs:
            assert p.find(f"{{{A_NS}}}pPr/{{{A_NS}}}buNone") is not None
        bold_runs = [
            r for r in sp.findall(f".//{{{A_NS}}}r")
            if r.find(f"{{{A_NS}}}rPr") is not None
            and r.find(f"{{{A_NS}}}rPr").get("b") == "1"
        ]
        assert any((r.find(f"{{{A_NS}}}t").text or "") == "red line" for r in bold_runs)
        return
    pytest.fail("caption placeholder (idx 2) not found on Picture slide")


def test_theme_color_and_emphasis_on_lists(rendered):
    """Region/item colours resolve to schemeClr runs; ** renders as bold."""
    root = _slide_xml(rendered["pptx"], 5)
    for sp in root.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None or int(ph.get("idx") or 0) != 1:
            continue
        colors_by_text = {}
        bold_texts = set()
        for r in sp.findall(f".//{{{A_NS}}}r"):
            text = r.find(f"{{{A_NS}}}t").text or ""
            rPr = r.find(f"{{{A_NS}}}rPr")
            if rPr is None:
                continue
            scheme = rPr.find(f"{{{A_NS}}}solidFill/{{{A_NS}}}schemeClr")
            if scheme is not None:
                colors_by_text[text] = scheme.get("val")
            if rPr.get("b") == "1":
                bold_texts.add(text)
        # region default accent1; item override accent2
        assert colors_by_text["In range"] == "accent1"
        assert colors_by_text["Excursion"] == "accent2"
        assert "In range" in bold_texts and "Excursion" in bold_texts
        return
    pytest.fail("left placeholder (idx 1) not found on slide 5")


def test_comparison_layout_binds_heads_and_bodies(tmp_path):
    """Comparison slide binds all five placeholder indices."""
    out = tmp_path / "cmp-out"
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-02.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out,
    )
    assert _slide_layout_name(result["pptx"], 3) == "Comparison"
    root = _slide_xml(result["pptx"], 3)
    text_by_idx = {}
    for sp in root.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None:
            continue
        idx = int(ph.get("idx") or 0)
        text_by_idx[idx] = [t.text or "" for t in sp.findall(f".//{{{A_NS}}}t")]
    assert set(text_by_idx) == {0, 1, 2, 3, 4}
    assert text_by_idx[1] == ["Paper"]
    assert text_by_idx[3] == ["Digital"]
    assert "Manual transcription errors" in text_by_idx[2]
    assert "Automatic logger export" in text_by_idx[4]


def test_master_bullet_levels_colored():
    """Template master colour-codes list levels 1-3 (accent1/2/3)."""
    with zipfile.ZipFile(EXAMPLES / "template.pptx") as z:
        master = etree.fromstring(z.read("ppt/slideMasters/slideMaster1.xml"))
    body = master.find(f"{{{P_NS}}}txStyles/{{{P_NS}}}bodyStyle")
    for level, expected in ((1, "accent1"), (2, "accent2"), (3, "accent3")):
        lvl = body.find(f"{{{A_NS}}}lvl{level}pPr")
        scheme = lvl.find(f"{{{A_NS}}}buClr/{{{A_NS}}}schemeClr")
        assert scheme is not None and scheme.get("val") == expected


def test_layout_map_validation_fails_loudly(tmp_path):
    """A stale placeholder index must abort the build, not misbind."""
    from fair_renderer.layoutmap import LayoutMapError

    bad_map = tmp_path / "bad-map.yaml"
    bad_map.write_text(
        "Split:\n  layout_name: 'Split'\n  regions:\n    title: 0\n    left: 1\n    right: 9\n"
    )
    with pytest.raises(LayoutMapError, match="idx 9"):
        render_session(
            session_path=EXAMPLES / "sessions" / "session-01.md",
            template_path=EXAMPLES / "template.pptx",
            layout_map_path=bad_map,
            out_dir=tmp_path / "out",
        )
