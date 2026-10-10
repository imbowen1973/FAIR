"""`edufair-corpus --companion`: the private twin joins the build.

Its files become educator resources of their blocks, under educator/ in
the output; the bank is exported to Moodle XML beside them; the
cross-checks run first; and without --companion the public build is
byte-for-byte what it always was.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest
import yaml

from edufair_renderer.corpus import CorpusError, build_corpus, main

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"

DECK = """---
session: '01'
title: Foundations
version: 1.0.0
---

--- slide
id: s-01
layout: Full
title: Opening
full: {type: ul, items: [One, Two]}
---
"""

BANK = """questions:
  - id: q-01
    type: truefalse
    assesses: [O1]
    stem: An excursion always means disposal.
    answer: false
"""


def _library(root: Path) -> Path:
    root.mkdir(parents=True)
    shutil.copy(EXAMPLES / "template.pptx", root / "template.pptx")
    shutil.copy(EXAMPLES / "layout-map.yaml", root / "layout-map.yaml")
    block = root / "blocks" / "01-foundations"
    block.mkdir(parents=True)
    (block / "slides.md").write_text(DECK, encoding="utf-8")
    (block / "block.yaml").write_text(
        yaml.safe_dump({"title": "Foundations", "duration_minutes": 45, "resources": []})
    )
    (root / "course.yaml").write_text(
        yaml.safe_dump({"id": "c", "title": "Cold chain", "structure": [{"block": "01-foundations"}]})
    )
    (root / "outcomes.yaml").write_text("outcomes:\n  O1: {statement: Respond to a breach}\n")
    return root


def _companion(root: Path) -> Path:
    block = root / "blocks" / "01-foundations"
    block.mkdir(parents=True)
    (root / "companion.yaml").write_text("library: org/cold-chain\nlicense: consortium only\n")
    (block / "questions.yaml").write_text(BANK, encoding="utf-8")
    (block / "instructorguide.md").write_text("# Guide\n\nAnswers discussed.\n")
    return root


def _build(lib, out, companion=None):
    return build_corpus(
        library=lib, template=lib / "template.pptx", layout_map=lib / "layout-map.yaml",
        out_dir=out, companion=companion, warn=lambda m: None,
    )


def test_companion_files_join_their_block_as_educator_resources(tmp_path):
    lib = _library(tmp_path / "lib")
    twin = _companion(tmp_path / "companion")
    summary = _build(lib, tmp_path / "out", twin)
    catalog = json.loads((tmp_path / "out" / "catalog.json").read_text())

    assert catalog["companion"] == {
        "library": "org/cold-chain", "license": "consortium only", "questions": 1, "files": 3,
    }
    assert summary["companion"]["questions"] == 1
    resources = catalog["blocks"][0]["resources"]
    assert {(r["type"], r["path"], r["audience"]) for r in resources} == {
        ("questions", "educator/blocks/01-foundations/questions.yaml", "educator"),
        ("instructorguide", "educator/blocks/01-foundations/instructorguide.md", "educator"),
        ("moodle-xml", "educator/blocks/01-foundations/questions.moodle.xml", "educator"),
    }
    out = tmp_path / "out" / "educator" / "blocks" / "01-foundations"
    assert (out / "instructorguide.md").read_text().startswith("# Guide")
    assert "<quiz>" in (out / "questions.moodle.xml").read_text()


def test_public_build_is_unchanged_without_the_companion(tmp_path):
    lib = _library(tmp_path / "lib")
    _build(lib, tmp_path / "a")
    _build(lib, tmp_path / "b")
    digest = lambda d: {
        p.relative_to(d).as_posix(): hashlib.sha1(p.read_bytes()).hexdigest()
        for p in sorted(d.rglob("*")) if p.is_file()
    }
    assert digest(tmp_path / "a") == digest(tmp_path / "b")
    assert "companion" not in json.loads((tmp_path / "a" / "catalog.json").read_text())
    assert not (tmp_path / "a" / "educator").exists()


def test_a_companion_that_does_not_match_is_refused(tmp_path):
    lib = _library(tmp_path / "lib")
    twin = _companion(tmp_path / "companion")
    (twin / "blocks" / "01-foundations" / "questions.yaml").write_text(
        BANK.replace("[O1]", "[O9]")
    )
    ghost = twin / "blocks" / "99-ghost"
    ghost.mkdir()
    (ghost / "instructorguide.md").write_text("# x\n")
    with pytest.raises(CorpusError) as err:
        _build(lib, tmp_path / "out", twin)
    assert "unknown outcome 'O9'" in str(err.value)
    assert "99-ghost" in str(err.value)


def test_a_companion_of_guides_only_is_fine(tmp_path):
    lib = _library(tmp_path / "lib")
    twin = _companion(tmp_path / "companion")
    (twin / "blocks" / "01-foundations" / "questions.yaml").unlink()
    _build(lib, tmp_path / "out", twin)
    catalog = json.loads((tmp_path / "out" / "catalog.json").read_text())
    assert [r["type"] for r in catalog["blocks"][0]["resources"]] == ["instructorguide"]


def test_cli_flag(tmp_path, capsys):
    lib = _library(tmp_path / "lib")
    twin = _companion(tmp_path / "companion")
    assert main([str(lib), "--out", str(tmp_path / "out"), "--companion", str(twin)]) == 0
    assert "companion: 1 questions" in capsys.readouterr().out
