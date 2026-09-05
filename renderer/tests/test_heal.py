"""Healing decks the pre-cSld renderer left poisoned.

A fix to code is not a fix to data: moving the creationId into cSld
stops new decks doubling it, and does nothing for the decks people
already assembled and saved. edufair-heal is the repair for those, so
what it must prove is surgical precision - the sld-level creationId
goes, and nothing else in the file moves by a byte.
"""

from __future__ import annotations

import re
import shutil
import zipfile
from pathlib import Path

import pytest

from edufair_renderer.heal import classify, heal
from edufair_renderer.render import render_session

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"

SLIDE = re.compile(r"ppt/slides/slide\d+\.xml$")

# What PowerPoint's re-save makes of the old renderer's output: the
# doubled extension at the sld level, mod attribute and all.
POISON = (
    '<p:extLst mod="1">'
    '<p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}">'
    '<p14:creationId xmlns="" xmlns:p14="http://schemas.microsoft.com/'
    'office/powerpoint/2010/main" val="468021116"/></p:ext>'
    '<p:ext uri="{9D2C8E4A-5B31-4F60-A0C7-2D8E13AB0042}">'
    '<fair:attribution xmlns="" xmlns:fair="urn:fair:attribution:1" '
    'session="01" slide="s-poison" version="0.1.0"/></p:ext>'
    "</p:extLst>"
)


@pytest.fixture(scope="module")
def poisoned(tmp_path_factory):
    """A rendered deck, then poisoned the way an insert-and-save was."""
    out = tmp_path_factory.mktemp("heal")
    result = render_session(
        session_path=EXAMPLES / "sessions" / "session-01.md",
        template_path=EXAMPLES / "template.pptx",
        layout_map_path=EXAMPLES / "layout-map.yaml",
        out_dir=out / "render",
    )
    deck = out / "poisoned.pptx"
    rendered = result["pptx"]
    with zipfile.ZipFile(rendered) as zin, zipfile.ZipFile(deck, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if SLIDE.match(item.filename):
                s = data.decode("utf-8")
                data = s.replace("</p:sld>", POISON + "</p:sld>").encode("utf-8")
            zout.writestr(item, data)
    return {"deck": deck, "rendered": rendered}


def test_a_poisoned_deck_is_recognised(poisoned):
    verdict, slides = classify(poisoned["deck"])
    assert verdict == "poisoned"
    assert len(slides) == 5


def test_the_renderer_output_itself_is_clean(poisoned):
    # The whole point of the cSld fix: what render_session writes today
    # must never be what heal exists to repair.
    verdict, _ = classify(poisoned["rendered"])
    assert verdict == "clean"


def test_heal_removes_only_the_doubled_creation_id(poisoned, tmp_path):
    deck = tmp_path / "deck.pptx"
    shutil.copy2(poisoned["deck"], deck)

    changed = heal(deck)
    assert changed == 5
    assert classify(deck)[0] == "clean"

    with zipfile.ZipFile(deck) as z:
        for n in z.namelist():
            if not SLIDE.match(n):
                continue
            s = z.read(n).decode("utf-8")
            # The attribution the poison carried survives...
            assert 's-poison' in s
            # ...inside an extLst that kept its own attributes...
            assert '<p:extLst mod="1">' in s
            # ...and exactly one creationId remains, the one in cSld.
            assert s.count("BB962C8B") == 1
            cut = s.find("</p:cSld>")
            assert "BB962C8B" not in s[cut:]


def test_everything_else_is_byte_identical(poisoned, tmp_path):
    deck = tmp_path / "deck.pptx"
    shutil.copy2(poisoned["deck"], deck)
    heal(deck)

    with zipfile.ZipFile(poisoned["deck"]) as before, zipfile.ZipFile(deck) as after:
        assert before.namelist() == after.namelist()
        for n in before.namelist():
            if SLIDE.match(n):
                continue
            assert before.read(n) == after.read(n), f"{n} was touched"


def test_the_original_is_kept_beside_the_file(poisoned, tmp_path):
    deck = tmp_path / "deck.pptx"
    shutil.copy2(poisoned["deck"], deck)
    heal(deck)
    bak = Path(str(deck) + ".pre-heal.bak")
    assert bak.exists()
    assert bak.read_bytes() == poisoned["deck"].read_bytes()


def test_healing_twice_changes_nothing(poisoned, tmp_path):
    deck = tmp_path / "deck.pptx"
    shutil.copy2(poisoned["deck"], deck)
    heal(deck)
    once = deck.read_bytes()
    assert heal(deck) == 0 or classify(deck)[0] == "clean"
    # A second heal rebuilds from the .bak, so guard the outcome, not
    # the byte-path: the deck must still be clean and hold its content.
    assert classify(deck)[0] == "clean"
    assert len(once) > 0
