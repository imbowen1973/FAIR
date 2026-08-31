"""One slide nobody can render should not cost the other forty.

A slide carrying a region its layout has no placeholder for stops the
whole corpus:

    slide 'wp52-25': region 'full' is not declared for layout 'Picture';
    expected one of ['caption', 'picture', 'title']

That is right for a build. It is wrong for somebody assembling a deck out
of a library they do not own, who then has no way to use any of it — and
wrong for an author who wants to see the other thirty-nine slides while
they work out what to do about this one.

So: strict by default, and skippable when the caller says so. The two
halves are tested together, because "carry on past a bad slide" is one
step away from "never fail", and that step must not be taken by accident.
"""

from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest
import yaml

from edufair_renderer.corpus import build_corpus
from edufair_renderer.render import RenderError, render_session

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def _library(root: Path, slides: str) -> Path:
    import shutil

    root.mkdir(parents=True, exist_ok=True)
    shutil.copy(EXAMPLES / "template.pptx", root / "template.pptx")
    shutil.copy(EXAMPLES / "layout-map.yaml", root / "layout-map.yaml")

    block = root / "blocks" / "01-b"
    block.mkdir(parents=True)
    (block / "slides.md").write_text(slides, encoding="utf-8")
    (block / "block.yaml").write_text(
        yaml.safe_dump({"title": "A block", "duration_minutes": 45, "resources": []}),
        encoding="utf-8",
    )
    (root / "course.yaml").write_text(
        yaml.safe_dump({"id": "c", "title": "C", "structure": [{"block": "01-b"}]}),
        encoding="utf-8",
    )
    return root


def _layouts() -> list[str]:
    return list(yaml.safe_load((EXAMPLES / "layout-map.yaml").read_text(encoding="utf-8")))


def _deck(good_layout: str, good_region: str) -> str:
    # Two slides that render, and one carrying a region its layout does
    # not declare — the author's actual failure.
    return textwrap.dedent(
        f"""\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: fine-before
        layout: {good_layout}
        {good_region}: Before
        ---

        --- slide
        id: wp52-25
        layout: {good_layout}
        nosuchregion: Words with nowhere to go
        ---

        --- slide
        id: fine-after
        layout: {good_layout}
        {good_region}: After
        ---
        """
    )


@pytest.fixture(scope="module")
def shape():
    """A layout from the example template, and a region it declares."""
    layouts = yaml.safe_load((EXAMPLES / "layout-map.yaml").read_text(encoding="utf-8"))
    for name, entry in layouts.items():
        if name.startswith("_"):
            continue
        regions = list((entry or {}).get("regions") or {})
        body = [r for r in regions if r != "title"]
        if body:
            return name, body[0]
    pytest.skip("the example layout map declares no body region")


def test_strict_is_still_strict(tmp_path, shape):
    layout, region = shape
    root = _library(tmp_path / "lib", _deck(layout, region))
    with pytest.raises(RenderError, match="nosuchregion"):
        build_corpus(
            library=root,
            template=root / "template.pptx",
            layout_map=root / "layout-map.yaml",
            out_dir=tmp_path / "out",
            warn=lambda m: None,
        )


def test_the_other_slides_still_render(tmp_path, shape):
    layout, region = shape
    root = _library(tmp_path / "lib", _deck(layout, region))
    warnings: list[str] = []
    summary = build_corpus(
        library=root,
        template=root / "template.pptx",
        layout_map=root / "layout-map.yaml",
        out_dir=tmp_path / "out",
        warn=warnings.append,
        skip_bad_slides=True,
    )

    catalog = json.loads(Path(summary["catalog"]).read_text(encoding="utf-8"))

    # The bad one is named, once, with the reason.
    assert len(catalog["problems"]) == 1
    problem = catalog["problems"][0]
    assert problem["slideId"] == "wp52-25"
    assert problem["blockId"] == "01-b"
    assert "nosuchregion" in problem["message"]

    # ...and it is not silent: a skipped slide is a warning too.
    assert any("nosuchregion" in w for w in warnings)

    # The others are there, and the deck was written.
    ids = [s["slideId"] for s in catalog["slides"]]
    assert "fine-before" in ids
    assert "fine-after" in ids
    assert "wp52-25" not in ids

    # The deck was written, and holds the two slides that rendered.
    session = catalog["sessions"][0]
    assert (Path(summary["catalog"]).parent / session["pptx"]).is_file()
    assert len([s for s in catalog["slides"] if s["sessionId"] == session["sessionId"]]) == 2


def test_a_clean_library_reports_no_problems(tmp_path, shape):
    # Asking to skip must not change what a good library produces.
    layout, region = shape
    good = textwrap.dedent(
        f"""\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: only
        layout: {layout}
        {region}: Fine
        ---
        """
    )
    root = _library(tmp_path / "lib", good)
    summary = build_corpus(
        library=root,
        template=root / "template.pptx",
        layout_map=root / "layout-map.yaml",
        out_dir=tmp_path / "out",
        warn=lambda m: None,
        skip_bad_slides=True,
    )
    catalog = json.loads(Path(summary["catalog"]).read_text(encoding="utf-8"))
    assert catalog["problems"] == []
    assert [s["slideId"] for s in catalog["slides"]] == ["only"]


def test_render_session_says_what_it_left_out(tmp_path, shape):
    layout, region = shape
    root = _library(tmp_path / "lib", _deck(layout, region))
    result = render_session(
        session_path=root / "blocks" / "01-b" / "slides.md",
        template_path=root / "template.pptx",
        layout_map_path=root / "layout-map.yaml",
        out_dir=tmp_path / "one",
        skip_bad_slides=True,
    )
    assert [s["slideId"] for s in result["skipped"]] == ["wp52-25"]
    assert result["slide_count"] == 2


def test_the_error_says_which_layout_does_declare_it(tmp_path):
    # "region 'full' is not declared for layout 'Picture'" reads as the
    # region name being wrong. It is not: a region is declared per
    # layout, so `full` working on one slide and not on another is not a
    # contradiction — the slide's layout is what is wrong. The message
    # now says where that region does live.
    layouts = yaml.safe_load((EXAMPLES / "layout-map.yaml").read_text(encoding="utf-8"))
    named = {}
    for name, entry in layouts.items():
        if name.startswith("_"):
            continue
        for region in (entry or {}).get("regions") or {}:
            named.setdefault(region, []).append(name)

    # A region one layout declares and another does not.
    pair = next(
        (
            (region, holders[0], other)
            for region, holders in named.items()
            for other in layouts
            if not other.startswith("_") and other not in holders
        ),
        None,
    )
    if pair is None:
        pytest.skip("every layout in the example map declares every region")
    region, holder, other = pair

    slides = textwrap.dedent(
        f"""\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: wrong-layout
        layout: {other}
        {region}: Words
        ---
        """
    )
    root = _library(tmp_path / "lib", slides)
    with pytest.raises(RenderError) as caught:
        build_corpus(
            library=root,
            template=root / "template.pptx",
            layout_map=root / "layout-map.yaml",
            out_dir=tmp_path / "out",
            warn=lambda m: None,
        )
    message = str(caught.value)
    assert repr(region) in message
    assert repr(holder) in message
    assert "instead" in message
