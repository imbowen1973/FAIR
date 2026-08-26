"""Reading back the YAML this project once wrote badly.

The workbench's inliner used to stop at the first item it could not fold
and inline the ones before it, leaving the rest as block entries under a
flow sequence. PyYAML refuses that, so a build failed on a file whose
content was entirely present:

    /fairlib/blocks/01-introduction-to-the-workshop/slides.md:388:
    invalid YAML in slide block: expected <block end>, but found
    '<block sequence start>'

Fixing the writer does nothing for the branches already carrying it, and
a renderer that cannot read the files this project's own editor produced
is not much of a renderer.
"""

from __future__ import annotations

import textwrap

import pytest
import yaml

from edufair_renderer import yamlio
from edufair_renderer.parser import SessionParseError, parse_session


def test_a_stranded_list_is_read_whole():
    broken = textwrap.dedent(
        """\
        card4:
          type: ul
          items: [SAFFT4EU]
            - REGE FARMS
            - FARMS 5.0
        notes: Say them.
        """
    )
    assert yamlio.safe_load(broken) == {
        "card4": {"type": "ul", "items": ["SAFFT4EU", "REGE FARMS", "FARMS 5.0"]},
        "notes": "Say them.",
    }


def test_pyyaml_really_does_refuse_it():
    # Without the repair this is not a matter of taste: it is a parse
    # error, and the whole slide is lost with it.
    broken = "items: [SAFFT4EU]\n  - REGE FARMS\n"
    with pytest.raises(yaml.YAMLError):
        yaml.safe_load(broken)
    assert yamlio.safe_load(broken) == {"items": ["SAFFT4EU", "REGE FARMS"]}


@pytest.mark.parametrize(
    "text, expected",
    [
        ("develops: [AP1, AP3]\n", {"develops": ["AP1", "AP3"]}),
        ("empty: []\n", {"empty": []}),
        ("a:\n  - one\n  - two\n", {"a": ["one", "two"]}),
        ("nested:\n  inner: [p, q]\n  after: yes\n", {"nested": {"inner": ["p", "q"], "after": True}}),
        ('quoted: "[not, a, list]"\n', {"quoted": "[not, a, list]"}),
        (
            "text: |\n  a line with [brackets] in it\n  and a - dash\n",
            {"text": "a line with [brackets] in it\nand a - dash\n"},
        ),
        ("items: [a, b]\nother:\n  - x\n", {"items": ["a", "b"], "other": ["x"]}),
    ],
)
def test_valid_yaml_is_untouched(text, expected):
    # The claim that makes this safe to run over every document: the
    # shape it repairs is invalid YAML in every case, so nothing valid
    # can be changed by it.
    assert yamlio.repair_inlined_lists(text) == text
    assert yamlio.safe_load(text) == expected


def test_windows_line_endings_survive():
    broken = "items: [A]\r\n  - B and C\r\n"
    assert yamlio.safe_load(broken) == {"items": ["A", "B and C"]}
    assert "\r\n" in yamlio.repair_inlined_lists(broken)


def test_a_deck_carrying_it_renders(tmp_path):
    # The failure as it reached the author: a whole slide block refused.
    deck = tmp_path / "slides.md"
    deck.write_text(
        textwrap.dedent(
            """\
            ---
            session: '01'
            title: Introduction to the workshop
            version: 1.0.0
            ---

            --- slide
            id: s-01
            layout: Cards
            title: Climate-Resilient & Regenerative Agriculture Specialist
            card1:
              type: ul
              items: [AGFORWEB, NECTAR, OFAFFU]
            card4:
              type: ul
              items: [SAFFT4EU]
                - REGE FARMS
                - FARMS 5.0
            notes: |
              Introduce the project names only.
            ---
            """
        ),
        encoding="utf-8",
    )

    session = parse_session(deck)
    assert len(session.slides) == 1
    slide = session.slides[0]
    assert slide.id == "s-01"
    assert slide.layout == "Cards"
    assert [r.name for r in slide.regions if r.name == "card4"]
    card4 = next(r for r in slide.regions if r.name == "card4")
    assert [item.text for item in card4.items] == ["SAFFT4EU", "REGE FARMS", "FARMS 5.0"]


def test_yaml_broken_for_any_other_reason_still_fails(tmp_path):
    # The repair must not become "make it parse somehow". A file somebody
    # hand-edited badly has to say so, with its line.
    deck = tmp_path / "slides.md"
    deck.write_text(
        textwrap.dedent(
            """\
            ---
            session: '01'
            title: Broken
            version: 1.0.0
            ---

            --- slide
            id: s-01
            layout: Full
            title: "unclosed
            ---
            """
        ),
        encoding="utf-8",
    )
    with pytest.raises(SessionParseError, match="invalid YAML"):
        parse_session(deck)
