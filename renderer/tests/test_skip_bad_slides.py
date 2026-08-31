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


def _with_image(layout: str, region: str, src: str) -> str:
    return textwrap.dedent(
        f"""\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: has-a-picture
        layout: {layout}
        {region}:
          type: image
          src: {src}
        ---
        """
    )


def _picture_shape():
    """A layout and a region that can hold a picture."""
    layouts = yaml.safe_load((EXAMPLES / "layout-map.yaml").read_text(encoding="utf-8"))
    for name, entry in layouts.items():
        if name.startswith("_"):
            continue
        body = [r for r in ((entry or {}).get("regions") or {}) if r != "title"]
        if body:
            return name, body[0]
    return None, None


@pytest.mark.parametrize("spelling", ["media/pic.png", "blocks/01-b/media/pic.png"])
def test_both_spellings_of_a_media_path_render(tmp_path, spelling):
    # An upload writes the first; choosing an image already in the
    # library writes the second, and the renderer used to look for
    # blocks/01-b/blocks/01-b/media/pic.png and refuse the slide. The
    # canvas draws both, so the author sees a picture and a deck that
    # will not build.
    layout, region = _picture_shape()
    if layout is None:
        pytest.skip("no body region in the example layout map")

    root = _library(tmp_path / "lib", _with_image(layout, region, spelling))
    media = root / "blocks" / "01-b" / "media"
    media.mkdir(parents=True)
    # A real PNG, small: python-pptx opens it for its dimensions.
    media.joinpath("pic.png").write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
            "de0000000c4944415408d763f8cfc00000030101003c1c2d840000000049454e"
            "44ae426082"
        )
    )

    summary = build_corpus(
        library=root,
        template=root / "template.pptx",
        layout_map=root / "layout-map.yaml",
        out_dir=tmp_path / "out",
        warn=lambda m: None,
    )
    catalog = json.loads(Path(summary["catalog"]).read_text(encoding="utf-8"))
    assert catalog["problems"] == []
    assert [s["slideId"] for s in catalog["slides"]] == ["has-a-picture"]


def test_a_picture_that_is_genuinely_missing_still_fails(tmp_path):
    # The fallback must not become "look everywhere until something
    # turns up". A src naming nothing is still an error, and it names
    # the place a reader would look first.
    layout, region = _picture_shape()
    if layout is None:
        pytest.skip("no body region in the example layout map")
    root = _library(tmp_path / "lib", _with_image(layout, region, "media/absent.png"))
    with pytest.raises(RenderError, match="image not found"):
        build_corpus(
            library=root,
            template=root / "template.pptx",
            layout_map=root / "layout-map.yaml",
            out_dir=tmp_path / "out",
            warn=lambda m: None,
        )


def test_full_means_the_content_placeholder_whatever_it_is_called(tmp_path):
    # The point. A layout map names the same PowerPoint placeholder
    # differently in every layout — `full` in Title and Content,
    # `picture` in Picture with Caption — so a slide written for one was
    # undeclared in the next, for no reason but the name. Both are the
    # placeholder a picture goes into, so both answer to `full`.
    slides = textwrap.dedent(
        """\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: text-in-a-picture-layout
        layout: Picture
        title: A picture slide
        full: Words in the content placeholder
        ---

        --- slide
        id: image-in-a-picture-layout
        layout: Picture
        title: Another
        full:
          type: image
          src: media/pic.png
        ---

        --- slide
        id: still-works-in-full
        layout: Full
        full: The layout that already called it that
        ---
        """
    )
    root = _library(tmp_path / "lib", slides)
    media = root / "blocks" / "01-b" / "media"
    media.mkdir(parents=True)
    media.joinpath("pic.png").write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
            "de0000000c4944415408d763f8cfc00000030101003c1c2d840000000049454e"
            "44ae426082"
        )
    )

    summary = build_corpus(
        library=root,
        template=root / "template.pptx",
        layout_map=root / "layout-map.yaml",
        out_dir=tmp_path / "out",
        warn=lambda m: None,
    )
    catalog = json.loads(Path(summary["catalog"]).read_text(encoding="utf-8"))
    assert catalog["problems"] == []
    assert [s["slideId"] for s in catalog["slides"]] == [
        "text-in-a-picture-layout",
        "image-in-a-picture-layout",
        "still-works-in-full",
    ]


def test_a_layout_with_two_content_placeholders_still_asks(tmp_path):
    # Comparison has left and right, and guessing which column somebody
    # meant is worse than refusing. The alias exists to remove a naming
    # accident, not to make every layout accept everything.
    slides = textwrap.dedent(
        """\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: ambiguous
        layout: Comparison
        full: Which column did you mean?
        ---
        """
    )
    root = _library(tmp_path / "lib", slides)
    with pytest.raises(RenderError, match="not declared for layout 'Comparison'"):
        build_corpus(
            library=root,
            template=root / "template.pptx",
            layout_map=root / "layout-map.yaml",
            out_dir=tmp_path / "out",
            warn=lambda m: None,
        )


def test_an_empty_region_the_layout_has_not_got_is_ignored(tmp_path):
    # What the author's slide actually carried: `full: ""` on a
    # Comparison slide. Not orphaned content — an empty placeholder the
    # workbench started and left behind. Nothing can be placed from it,
    # so refusing the whole deck over it is a trade nobody would choose.
    slides = textwrap.dedent(
        """\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: wp52-26
        layout: Comparison
        title: TASK 1
        full: ""
        left_head: Teaching modules
        right_head: WBL Modules
        left: What are your three microcredentials
        right: Are the WBL modules aligned
        ---
        """
    )
    root = _library(tmp_path / "lib", slides)
    summary = build_corpus(
        library=root,
        template=root / "template.pptx",
        layout_map=root / "layout-map.yaml",
        out_dir=tmp_path / "out",
        warn=lambda m: None,
    )
    catalog = json.loads(Path(summary["catalog"]).read_text(encoding="utf-8"))
    assert catalog["problems"] == []
    assert [s["slideId"] for s in catalog["slides"]] == ["wp52-26"]


def test_an_undeclared_region_that_holds_something_still_fails(tmp_path):
    # The distinction that makes the above safe: words nobody can place
    # are still an error, because dropping them would lose them.
    slides = textwrap.dedent(
        """\
        ---
        session: '01'
        title: A block
        version: 1.0.0
        ---

        --- slide
        id: has-words
        layout: Comparison
        full: Words that would be lost
        ---
        """
    )
    root = _library(tmp_path / "lib", slides)
    with pytest.raises(RenderError, match="not declared for layout 'Comparison'"):
        build_corpus(
            library=root,
            template=root / "template.pptx",
            layout_map=root / "layout-map.yaml",
            out_dir=tmp_path / "out",
            warn=lambda m: None,
        )
