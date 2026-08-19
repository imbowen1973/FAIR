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
    # Notes ride in the index so the pane can search narration, not just
    # titles; slides without notes carry an explicit null, never a gap.
    assert "integrity pillars" in entry["notes"]
    assert all("notes" in s for s in doc["slides"])
    assert any(s["notes"] is None for s in doc["slides"])


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


def test_cards_layout_binds_four_tabbed_cards(tmp_path):
    """Cards slide binds title + 4 tab heads (idx 1-4) + 4 bodies (idx 5-8),
    and the layout styles tabs with per-card accent fills."""
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-03.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=tmp_path / "out",
    )
    assert _slide_layout_name(result["pptx"], 4) == "Cards"
    root = _slide_xml(result["pptx"], 4)
    text_by_idx = {}
    for sp in root.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None:
            continue
        idx = int(ph.get("idx") or 0)
        text_by_idx[idx] = [t.text or "" for t in sp.findall(f".//{{{A_NS}}}t")]
    assert set(text_by_idx) >= {0, 1, 2, 3, 4, 5, 6, 7, 8}
    assert text_by_idx[1] == ["Detect"]
    assert text_by_idx[4] == ["Report"]
    assert "Quarantine the stock" in text_by_idx[6]
    assert "File the excursion report" in text_by_idx[8]

    # Layout: tab placeholders carry rounded-top geometry and accent fills.
    with zipfile.ZipFile(EXAMPLES / "template.pptx") as z:
        cards_layout = None
        for name in z.namelist():
            if name.startswith("ppt/slideLayouts/slideLayout") and name.endswith(".xml"):
                xml = etree.fromstring(z.read(name))
                if xml.find(f"{{{P_NS}}}cSld").get("name") == "Cards":
                    cards_layout = xml
                    break
    assert cards_layout is not None
    fills = {}
    for sp in cards_layout.findall(f".//{{{P_NS}}}sp"):
        ph = sp.find(f".//{{{P_NS}}}ph")
        if ph is None or ph.get("idx") is None:
            continue
        idx = int(ph.get("idx"))
        if 1 <= idx <= 4:
            geom = sp.find(f".//{{{A_NS}}}prstGeom")
            assert geom is not None and geom.get("prst") == "round2SameRect"
            scheme = sp.find(f".//{{{A_NS}}}solidFill/{{{A_NS}}}schemeClr")
            fills[idx] = scheme.get("val")
    assert fills == {1: "accent1", 2: "accent2", 3: "accent3", 4: "accent4"}


def test_video_region_renders_linked_poster(tmp_path):
    """Video regions render a poster picture hyperlinked to the hosted URL;
    no video binary is involved anywhere."""
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-02.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=tmp_path / "out",
    )
    with zipfile.ZipFile(result["pptx"]) as z:
        root = etree.fromstring(z.read("ppt/slides/slide4.xml"))
        pics = root.findall(f".//{{{P_NS}}}pic")
        assert len(pics) == 1
        hlink = pics[0].find(f".//{{{A_NS}}}hlinkClick")
        assert hlink is not None, "poster picture must carry a hyperlink"
        rid = hlink.get(f"{{{R_NS}}}id")
        rels = etree.fromstring(z.read("ppt/slides/_rels/slide4.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels}
        assert targets[rid] == "https://youtu.be/fair-demo-audit-pack"


def test_asset_policy_gate(tmp_path):
    import sys

    sys.path.insert(0, str(REPO / "scripts"))
    from check_assets import check_assets
    from PIL import Image

    # clean directory passes
    assert check_assets(EXAMPLES / "sessions") == []

    bad = tmp_path / "assets"
    bad.mkdir()
    (bad / "clip.mp4").write_bytes(b"\x00" * 10)
    Image.new("RGB", (3000, 200), "white").save(bad / "huge.png")
    errors = check_assets(tmp_path)
    assert any("clip.mp4" in e and "video" in e for e in errors)
    assert any("huge.png" in e and "2200" in e for e in errors)


FAIR_NS = "urn:fair:attribution:1"


def test_attribution_stamp_locked_and_present(rendered):
    """Every slide carries the visible CC-BY stamp as an unselectable shape."""
    for n in range(1, 6):
        root = _slide_xml(rendered["pptx"], n)
        stamped = False
        for sp in root.findall(f".//{{{P_NS}}}sp"):
            texts = "".join(t.text or "" for t in sp.findall(f".//{{{A_NS}}}t"))
            if "CC-BY 4.0" in texts:
                locks = sp.find(f".//{{{A_NS}}}spLocks")
                assert locks is not None, f"slide{n}: stamp has no locks"
                for attr in ("noSelect", "noMove", "noResize", "noTextEdit"):
                    assert locks.get(attr) == "1", f"slide{n}: missing {attr}"
                stamped = True
        assert stamped, f"slide{n}: no visible attribution stamp"


def test_attribution_provenance_extension(rendered):
    """Machine-readable provenance rides in every slide's XML."""
    root = _slide_xml(rendered["pptx"], 3)
    node = root.find(f".//{{{FAIR_NS}}}attribution")
    assert node is not None
    assert node.get("creator") == "FAIR Consortium"
    assert node.get("license") == "CC-BY-4.0"
    assert node.get("session") == "01"
    assert node.get("slide") == "s01-03"


def test_attribution_notes_line(rendered):
    with zipfile.ZipFile(rendered["pptx"]) as z:
        notes = b"".join(
            z.read(n) for n in z.namelist() if n.startswith("ppt/notesSlides/notesSlide")
        )
    assert b"Source: Example Grant" in notes
    assert b"01/s01-03" in notes


def test_audit_reads_provenance(rendered):
    from fair_renderer.audit import audit_deck

    entries = audit_deck(rendered["pptx"])
    assert len(entries) == 5
    by_slide = {e["provenance"]["slide"]: e for e in entries if e["provenance"]}
    assert by_slide["s01-03"]["provenance"]["license"] == "CC-BY-4.0"
    assert all(e["creationId"] for e in entries)


def test_attribution_logo_stamped_with_metadata(tmp_path):
    """With a logo configured, every slide gets a locked picture whose PNG
    carries the attribution in its own metadata."""
    from PIL import Image

    lib = tmp_path / "lib"
    (lib / "branding").mkdir(parents=True)
    Image.new("RGBA", (120, 120), (44, 110, 158, 255)).save(lib / "branding" / "logo.png")
    # Explicit utf-8: the loader reads utf-8, and on Windows the default
    # locale encoding is cp1252, which mangles the middle dot on write.
    (lib / "attribution.yaml").write_text(
        'text: "CC-BY 4.0 · FAIR Consortium"\nlogo: branding/logo.png\n',
        encoding="utf-8",
    )
    out = tmp_path / "out"
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-02.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out,
        attribution_path=lib / "attribution.yaml",
    )
    root = _slide_xml(result["pptx"], 1)
    pics = root.findall(f".//{{{P_NS}}}pic")
    assert pics, "logo picture missing"
    lock_found = any(
        pic.find(f".//{{{A_NS}}}picLocks") is not None
        and pic.find(f".//{{{A_NS}}}picLocks").get("noSelect") == "1"
        for pic in pics
    )
    assert lock_found, "logo picture is not locked"

    stamped = Image.open(out / "build" / "attribution-logo.png")
    assert stamped.info.get("fair:license") or stamped.info.get("fair:text")


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


# --- nested delivery structure (credentials modules/days/blocks) ----------


def _corpus(tmp_path, credential: dict):
    """Build a one-session corpus with the given credential definition."""
    import shutil

    import yaml

    from fair_renderer.corpus import build_corpus

    sessions = tmp_path / "sessions"
    if not sessions.exists():
        # copytree brings assets/ along; session-01 references an image.
        shutil.copytree(EXAMPLES / "sessions", sessions)
        for stale in sessions.glob("session-0[23].md"):
            stale.unlink()
    creds = tmp_path / "credentials"
    creds.mkdir(exist_ok=True)
    (creds / "c.yaml").write_text(yaml.safe_dump(credential), encoding="utf-8")
    return build_corpus(
        sessions_dir=sessions,
        template=EXAMPLES / "template.pptx",
        layout_map=EXAMPLES / "layout-map.yaml",
        out_dir=tmp_path / "out",
        credentials_dir=creds,
        warn=lambda msg: None,
    )


def test_nested_credential_validates(tmp_path):
    """modules -> days -> blocks -> sessions is accepted and passed through."""
    summary = _corpus(
        tmp_path,
        {
            "id": "c",
            "title": "Course",
            "modules": [
                {
                    "title": "M1",
                    "days": [
                        {"title": "Day 1", "blocks": [{"title": "AM", "sessions": ["01"]}]}
                    ],
                }
            ],
        },
    )
    assert summary["credentials"] == 1
    catalog = json.loads((tmp_path / "out" / "catalog.json").read_text())
    block = catalog["credentials"][0]["modules"][0]["days"][0]["blocks"][0]
    assert block["sessions"] == ["01"]


def test_flat_credential_still_validates(tmp_path):
    """The pre-existing flat modules[].sessions[] shape must not break."""
    summary = _corpus(
        tmp_path,
        {"id": "c", "title": "Course", "modules": [{"title": "M1", "sessions": ["01"]}]},
    )
    assert summary["credentials"] == 1


def test_unknown_session_in_nested_block_raises(tmp_path):
    from fair_renderer.corpus import CorpusError

    with pytest.raises(CorpusError, match="unknown session"):
        _corpus(
            tmp_path,
            {
                "id": "c",
                "modules": [
                    {
                        "title": "M1",
                        "days": [
                            {"title": "D", "blocks": [{"title": "AM", "sessions": ["99"]}]}
                        ],
                    }
                ],
            },
        )


def test_container_with_both_sessions_and_days_raises(tmp_path):
    from fair_renderer.corpus import CorpusError

    with pytest.raises(CorpusError, match="one or the other"):
        _corpus(
            tmp_path,
            {
                "id": "c",
                "modules": [
                    {
                        "title": "M1",
                        "sessions": ["01"],
                        "days": [{"title": "D", "sessions": ["01"]}],
                    }
                ],
            },
        )


def test_attribution_opacity_and_scale_reach_the_xml(tmp_path):
    """Semi-transparency is a render concern: alpha lands in the slide XML."""
    from PIL import Image

    lib = tmp_path / "lib"
    (lib / "branding").mkdir(parents=True)
    Image.new("RGBA", (240, 80), (44, 110, 158, 255)).save(lib / "branding" / "logo.png")
    (lib / "attribution.yaml").write_text(
        'text: "Funded by the European Union · Agreement No: 101183898"\n'
        "logo: branding/logo.png\n"
        "corner: bottom-right\n"
        "opacity: 0.45\n"
        "scale: 0.9\n"
        # Fading a mark is opt-in: logo_opacity defaults to fully opaque
        # so an emblem is never altered by accident.
        "logo_opacity: 0.45\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-02.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out,
        attribution_path=lib / "attribution.yaml",
    )
    with zipfile.ZipFile(result["pptx"]) as z:
        xml = z.read("ppt/slides/slide1.xml").decode("utf-8")
    # 0.45 -> 45000 in DrawingML's 0-100000 alpha scale.
    assert 'alphaModFix amt="45000"' in xml, "logo is not faded"
    assert '<a:alpha val="45000"/>' in xml, "stamp text is not faded"


def test_attribution_rejects_out_of_range_opacity(tmp_path):
    from fair_renderer.attribution import AttributionError, load_attribution

    path = tmp_path / "attribution.yaml"
    path.write_text('text: "x"\nopacity: 1.5\n', encoding="utf-8")
    with pytest.raises(AttributionError, match="opacity"):
        load_attribution(path)


def test_attribution_defaults_to_opaque(tmp_path):
    from fair_renderer.attribution import load_attribution

    path = tmp_path / "attribution.yaml"
    path.write_text('text: "x"\n', encoding="utf-8")
    config = load_attribution(path)
    assert config["opacity"] == 1.0 and config["scale"] == 1.0


def test_catalog_carries_attribution_and_copies_the_logo(tmp_path):
    """The funder credit travels with the content, not with the tool."""
    import shutil

    from PIL import Image

    from fair_renderer.corpus import build_corpus

    lib = tmp_path / "lib"
    shutil.copytree(EXAMPLES / "sessions", lib / "sessions")
    for stale in (lib / "sessions").glob("session-0[23].md"):
        stale.unlink()
    (lib / "branding").mkdir()
    Image.new("RGBA", (200, 60), (0, 51, 153, 255)).save(lib / "branding" / "eu.png")
    (lib / "attribution.yaml").write_text(
        'text: "Funded by the European Union · Agreement No: 101183898"\n'
        "logo: branding/eu.png\nopacity: 0.45\n",
        encoding="utf-8",
    )

    out = tmp_path / "out"
    # attribution.yaml sits beside sessions/, so it is found without asking.
    build_corpus(
        sessions_dir=lib / "sessions",
        template=EXAMPLES / "template.pptx",
        layout_map=EXAMPLES / "layout-map.yaml",
        out_dir=out,
        warn=lambda msg: None,
    )
    catalog = json.loads((out / "catalog.json").read_text())
    credit = catalog["attribution"]
    assert "101183898" in credit["text"]
    assert credit["opacity"] == 0.45
    # Referenced relatively and actually present, so a consumer needs
    # nothing but the data directory.
    assert credit["logo"] == "attribution-logo.png"
    assert (out / "attribution-logo.png").exists()


def test_catalog_attribution_is_null_without_a_config(tmp_path):
    import shutil

    from fair_renderer.corpus import build_corpus

    lib = tmp_path / "lib"
    shutil.copytree(EXAMPLES / "sessions", lib / "sessions")
    out = tmp_path / "out"
    build_corpus(
        sessions_dir=lib / "sessions",
        template=EXAMPLES / "template.pptx",
        layout_map=EXAMPLES / "layout-map.yaml",
        out_dir=out,
        warn=lambda msg: None,
    )
    catalog = json.loads((out / "catalog.json").read_text())
    assert catalog["attribution"] is None


def test_logo_sizing_and_opacity_are_independent_of_the_text(tmp_path):
    """EU rules: emblem >= 1 cm and unaltered, while the wording stays faded."""
    from PIL import Image

    lib = tmp_path / "lib"
    (lib / "branding").mkdir(parents=True)
    # 4.75:1, the real emblem's aspect ratio.
    Image.new("RGBA", (1130, 238), (0, 51, 153, 255)).save(lib / "branding" / "eu.png")
    (lib / "attribution.yaml").write_text(
        'text: "Co-funded by the European Union · Agreement No: 101183898"\n'
        "logo: branding/eu.png\nopacity: 0.45\nscale: 0.9\n"
        "logo_height_cm: 1.0\nlogo_opacity: 1.0\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-02.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out,
        attribution_path=lib / "attribution.yaml",
    )
    with zipfile.ZipFile(result["pptx"]) as z:
        xml = z.read("ppt/slides/slide1.xml").decode("utf-8")

    # The wording is faded; the emblem is not touched.
    assert '<a:alpha val="45000"/>' in xml, "stamp text should be faded"
    assert "alphaModFix" not in xml, "the EU emblem must not be altered"

    # 1 cm = 360000 EMU, within rounding.
    root = etree.fromstring(xml.encode("utf-8"))
    ext = root.find(f".//{{{P_NS}}}pic/{{{P_NS}}}spPr/{{{A_NS}}}xfrm/{{{A_NS}}}ext")
    assert ext is not None, "no picture on the slide"
    cy = int(ext.get("cy"))
    assert abs(cy - 360000) < 2000, f"emblem is {cy / 360000:.2f} cm high, not 1 cm"


# --- template profile / fair-template ------------------------------------

STOCK = Path(__import__("pptx").__file__).parent / "templates" / "default.pptx"


def test_stock_powerpoint_template_conforms_to_the_core_profile():
    """The whole point: a plain PowerPoint template works unedited."""
    from fair_renderer.template_inspect import CORE, inspect_template

    results = {r.key: r for r in inspect_template(STOCK)}
    for spec in CORE:
        result = results[spec.key]
        assert result.layout_name is not None, f"{spec.key} unmatched in a stock template"
        assert not result.missing, f"{spec.key} unbound regions: {result.missing}"


def test_generated_map_renders_real_content_on_a_stock_template(tmp_path):
    from fair_renderer.layoutmap import load_layout_map
    from fair_renderer.template_inspect import inspect_template, to_layout_map

    map_path = tmp_path / "layout-map.yaml"
    map_path.write_text(to_layout_map(inspect_template(STOCK)), encoding="utf-8")
    # It must survive the same loader the build uses, then actually bind.
    load_layout_map(map_path)
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-02.md",
        template_path=STOCK,
        layout_map_path=map_path,
        out_dir=tmp_path / "out",
    )
    assert result["pptx"].exists()


def test_inspector_reproduces_the_hand_written_map():
    """The generator agrees with the map this repo has used all along."""
    import yaml

    from fair_renderer.template_inspect import inspect_template, to_layout_map

    generated = yaml.safe_load(to_layout_map(inspect_template(EXAMPLES / "template.pptx")))
    committed = yaml.safe_load((EXAMPLES / "layout-map.yaml").read_text(encoding="utf-8"))
    for key, entry in committed.items():
        assert key in generated, f"inspector lost layout {key}"
        assert generated[key]["layout_name"] == entry["layout_name"]
        assert generated[key]["regions"] == entry["regions"], key


def test_left_and_right_come_from_geometry_not_index_order(tmp_path):
    """A designer may ship Two Content with the right pane at the lower idx.

    Binding by index order would mirror every split slide silently.
    """
    from pptx import Presentation

    from fair_renderer.template_inspect import _by_x, _r_two_content, Placeholder

    # idx 1 sits on the RIGHT, idx 2 on the left.
    title = Placeholder(0, None, 0, 0, 100, 10)
    right_at_idx1 = Placeholder(1, None, 5_000_000, 1_000_000, 4_000_000, 3_000_000)
    left_at_idx2 = Placeholder(2, None, 500_000, 1_000_000, 4_000_000, 3_000_000)
    bound = _r_two_content(title, [right_at_idx1, left_at_idx2])
    assert bound["left"] == 2 and bound["right"] == 1
    assert [p.idx for p in _by_x([right_at_idx1, left_at_idx2])] == [2, 1]


def test_missing_picture_placeholder_is_reported_not_silently_bound():
    from fair_renderer.template_inspect import LayoutResult, report

    result = LayoutResult(
        key="Picture",
        layout_name="Picture with Caption",
        regions={"title": 0, "caption": 2},
        missing=["picture"],
        notes=["no PICTURE placeholder: images here would be free-positioned, not template-bound"],
    )
    text = report([result])
    assert "PARTIAL" in text and "picture" in text and "free-positioned" in text
