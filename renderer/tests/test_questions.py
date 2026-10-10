"""The companion's question grammar and its Moodle XML export.

What matters most: the export is deterministic, every portable type
survives the trip into Moodle's format, the companion-side cross-checks
catch a bank pointing at outcomes or blocks the library does not have,
and the library-side gate refuses educator files in the public repo.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from lxml import etree

from edufair_renderer.moodlexml import block_xml, export_companion
from edufair_renderer.questions import (
    QuestionsError,
    educator_files_in_library,
    load_companion,
    load_questions,
    validate_against_library,
)

BANK = """\
questions:
  - id: q-01
    type: mcq
    assesses: [O1]
    stem: A logger shows 7.4 °C for 40 minutes. What is the **first** action?
    feedback: Containment precedes assessment.
    options:
      - text: Quarantine the affected stock
        correct: true
        feedback: Right.
      - text: File the excursion report
        feedback: Reporting comes after containment.
  - id: q-02
    type: multi
    assesses: [O1, O2]
    stem: Which records satisfy an audit?
    options:
      - {text: Logger export, correct: true}
      - {text: Handover signatures, correct: true}
      - {text: A verbal assurance}
  - id: q-03
    type: truefalse
    assesses: [O2]
    stem: An excursion always means disposal.
    answer: false
  - id: q-04
    type: short
    assesses: [O1]
    stem: Name the document completed after a breach.
    answers: [excursion report, breach report]
  - id: q-05
    type: numeric
    assesses: [O1]
    stem: Maximum vaccine storage temperature in °C?
    answer: 8
    tolerance: 0.5
  - id: q-06
    type: match
    assesses: [O2]
    stem: Match the role to the action.
    pairs:
      - {prompt: Warehouse lead, answer: Confirms the alarm}
      - {prompt: QA, answer: Rules on disposition}
  - id: q-07
    type: cloze
    assesses: [O1]
    text: On a breach, first [[quarantine]] the stock, then file the [[excursion report]].
"""


@pytest.fixture()
def companion(tmp_path) -> Path:
    root = tmp_path / "companion"
    block = root / "blocks" / "01-foundations"
    block.mkdir(parents=True)
    (root / "companion.yaml").write_text(
        "library: org/public-twin\nlicense: consortium agreement\n"
    )
    (block / "questions.yaml").write_text(BANK, encoding="utf-8")
    return root


@pytest.fixture()
def library(tmp_path) -> Path:
    root = tmp_path / "library"
    (root / "blocks" / "01-foundations").mkdir(parents=True)
    (root / "outcomes.yaml").write_text(
        "outcomes:\n  O1: {statement: Respond to a breach}\n"
        "  O2: {statement: Keep audit-ready records}\n"
    )
    return root


def test_all_portable_types_load(companion):
    loaded = load_companion(companion)
    items = loaded.banks["01-foundations"]
    assert [i.type for i in items] == [
        "mcq", "multi", "truefalse", "short", "numeric", "match", "cloze",
    ]
    assert loaded.library_ref == "org/public-twin"


def _bank_with(snippet: str) -> str:
    return f"questions:\n{snippet}"


@pytest.mark.parametrize(
    "snippet, message",
    [
        ("  - {id: x, type: wat, assesses: [O1], stem: s}", "unknown type"),
        ("  - {id: x, type: mcq, stem: s, options: [{text: a, correct: true}, {text: b}]}",
         "missing 'assesses'"),
        ("  - {id: x, type: mcq, assesses: [O1], stem: s, options: [{text: a}, {text: b}]}",
         "exactly one correct"),
        ("  - {id: x, type: multi, assesses: [O1], stem: s, "
         "options: [{text: a, correct: true}, {text: b, correct: true}]}",
         "every option is correct"),
        ("  - {id: x, type: truefalse, assesses: [O1], stem: s, answer: maybe}",
         "'answer: true' or 'answer: false'"),
        ("  - {id: x, type: numeric, assesses: [O1], stem: s, answer: eight}",
         "needs a number"),
        ("  - {id: x, type: match, assesses: [O1], stem: s, pairs: [{prompt: a, answer: b}]}",
         "at least two pairs"),
        ("  - {id: x, type: cloze, assesses: [O1], text: no gaps here}",
         "no gaps"),
        ("  - {id: x, type: mcq, assesses: [O1], stem: s, options: [{text: a, correct: true}, {text: b}]}\n"
         "  - {id: x, type: truefalse, assesses: [O1], stem: s, answer: true}",
         "duplicate question id"),
    ],
)
def test_grammar_refuses(tmp_path, snippet, message):
    path = tmp_path / "questions.yaml"
    path.write_text(_bank_with(snippet), encoding="utf-8")
    with pytest.raises(QuestionsError, match=message):
        load_questions(path)


def test_moodle_xml_structure(companion):
    loaded = load_companion(companion)
    xml = block_xml("01-foundations", loaded.banks["01-foundations"])
    root = etree.fromstring(xml.encode())

    types = [q.get("type") for q in root.findall("question")]
    assert types == [
        "category", "multichoice", "multichoice", "truefalse",
        "shortanswer", "numerical", "matching", "cloze",
    ]
    assert "$course$/top/eduFAIR/01-foundations" in xml

    # mcq: single, one 100 answer; emphasis became HTML.
    mcq = root.findall("question")[1]
    assert mcq.findtext("single") == "true"
    fractions = [a.get("fraction") for a in mcq.findall("answer")]
    assert "100" in fractions and "0" in fractions
    assert "<strong>first</strong>" in xml

    # multi: two correct at 50 each, wrong negative.
    multi = root.findall("question")[2]
    fr = sorted(a.get("fraction") for a in multi.findall("answer"))
    assert fr == ["-100", "50", "50"]

    # cloze compiled from [[...]] — authors never write the syntax.
    assert "{1:SHORTANSWER:=quarantine}" in xml
    assert "{1:SHORTANSWER:=excursion report}" in xml
    assert "[[" not in xml

    # provenance: idnumber for idempotent re-import, outcome tags.
    assert "<idnumber>q-01</idnumber>" in xml
    assert "<text>outcome:O1</text>" in xml
    assert "<text>block:01-foundations</text>" in xml


def test_export_is_deterministic(companion, tmp_path):
    loaded = load_companion(companion)
    a = export_companion(loaded, tmp_path / "a")[0].read_bytes()
    b = export_companion(loaded, tmp_path / "b")[0].read_bytes()
    assert a == b


def test_cross_checks_run_on_the_companion_side(companion, library):
    loaded = load_companion(companion)
    assert validate_against_library(loaded, library) == []

    # An unknown outcome and a missing block are both named precisely.
    bad_block = companion / "blocks" / "99-ghost"
    bad_block.mkdir(parents=True)
    (bad_block / "questions.yaml").write_text(
        _bank_with("  - {id: g1, type: truefalse, assesses: [O9], stem: s, answer: true}")
    )
    problems = validate_against_library(load_companion(companion), library)
    assert any("99-ghost: no such block" in p for p in problems)
    assert any("unknown outcome 'O9'" in p for p in problems)


def test_library_gate_refuses_educator_files(library):
    assert educator_files_in_library(library) == []
    (library / "blocks" / "01-foundations" / "questions.yaml").write_text("questions: []")
    leaked = educator_files_in_library(library)
    assert leaked == ["blocks/01-foundations/questions.yaml"]
