"""questions.yaml: the companion repo's question bank, one file per block.

The portable item subset — the intersection that survives export to
Moodle XML today and QTI later, so an item authored once is never
trapped in one platform (companion-repo.md):

    questions:
      - id: q-01
        type: mcq
        assesses: [O1]
        stem: A logger shows 7.4 °C for 40 minutes. What is the **first** action?
        options:
          - text: Quarantine the affected stock
            correct: true
            feedback: Right — containment precedes assessment.
          - text: File the excursion report
            feedback: Reporting comes after containment.

Types and their extra fields:

    mcq        options: exactly one correct
    multi      options: one or more correct (graded with Moodle's
               usual fractions: +100/#correct, −100/#incorrect)
    truefalse  answer: true|false
    short      answers: [accepted strings]; case: false by default
    numeric    answer: number; tolerance: 0 by default
    match      pairs: [{prompt, answer}], at least two
    cloze      text with gaps written [[answer]] — compiled to Moodle's
               cloze syntax at export, so authors never write it

Every item names the outcomes it `assesses` — the question side of the
slide → outcome → competency chain (outcomes.py). Validation against the
public twin's outcomes.yaml runs on the companion's side, because the
companion can always read its public library and never the reverse.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml


class QuestionsError(Exception):
    pass


ITEM_TYPES = {"mcq", "multi", "truefalse", "short", "numeric", "match", "cloze"}

CLOZE_GAP = re.compile(r"\[\[([^\[\]]+)\]\]")

COMPANION_FILE = "companion.yaml"
QUESTIONS_FILE = "questions.yaml"
# Files that must never appear in the PUBLIC library — the cheap
# catastrophic mistake has to fail in CI, not be found by a student.
EDUCATOR_ONLY_FILES = ("questions.yaml", "instructorguide.md")


@dataclass
class Item:
    id: str
    type: str
    stem: str
    assesses: list[str]
    points: float = 1.0
    feedback: str | None = None
    options: list[dict] = field(default_factory=list)  # mcq, multi
    answer: object = None  # truefalse, numeric
    answers: list[str] = field(default_factory=list)  # short
    case: bool = False  # short: case-sensitive?
    tolerance: float = 0.0  # numeric
    pairs: list[dict] = field(default_factory=list)  # match
    text: str | None = None  # cloze


def _need(raw: dict, key: str, where: str):
    if key not in raw or raw[key] in (None, "", []):
        raise QuestionsError(f"{where}: missing '{key}'")
    return raw[key]


def _parse_item(raw, where: str) -> Item:
    if not isinstance(raw, dict):
        raise QuestionsError(f"{where}: an item must be a mapping")
    item_id = str(_need(raw, "id", where))
    where = f"{where} ({item_id})"
    itype = _need(raw, "type", where)
    if itype not in ITEM_TYPES:
        raise QuestionsError(
            f"{where}: unknown type {itype!r}; expected one of {sorted(ITEM_TYPES)}"
        )

    assesses = _need(raw, "assesses", where)
    if not isinstance(assesses, list) or not all(isinstance(a, str) for a in assesses):
        raise QuestionsError(f"{where}: 'assesses' must be a list of outcome ids")

    stem = raw.get("stem")
    if itype != "cloze" and (not isinstance(stem, str) or not stem.strip()):
        raise QuestionsError(f"{where}: missing 'stem'")

    points = raw.get("points", 1)
    if not isinstance(points, (int, float)) or points <= 0:
        raise QuestionsError(f"{where}: 'points' must be a positive number")

    item = Item(
        id=item_id, type=itype, stem=stem or "", assesses=[str(a) for a in assesses],
        points=float(points), feedback=raw.get("feedback"),
    )

    if itype in ("mcq", "multi"):
        options = _need(raw, "options", where)
        if not isinstance(options, list) or len(options) < 2:
            raise QuestionsError(f"{where}: needs at least two options")
        correct = 0
        for i, opt in enumerate(options, start=1):
            if not isinstance(opt, dict) or not str(opt.get("text", "")).strip():
                raise QuestionsError(f"{where}: option {i} needs 'text'")
            if opt.get("correct"):
                correct += 1
        if itype == "mcq" and correct != 1:
            raise QuestionsError(f"{where}: mcq needs exactly one correct option, has {correct}")
        if itype == "multi" and correct < 1:
            raise QuestionsError(f"{where}: multi needs at least one correct option")
        if correct == len(options):
            raise QuestionsError(f"{where}: every option is correct — nothing is being asked")
        item.options = options

    elif itype == "truefalse":
        answer = raw.get("answer")
        if not isinstance(answer, bool):
            raise QuestionsError(f"{where}: truefalse needs 'answer: true' or 'answer: false'")
        item.answer = answer

    elif itype == "short":
        answers = _need(raw, "answers", where)
        if not isinstance(answers, list) or not all(
            isinstance(a, str) and a.strip() for a in answers
        ):
            raise QuestionsError(f"{where}: 'answers' must be a list of accepted strings")
        item.answers = answers
        item.case = bool(raw.get("case", False))

    elif itype == "numeric":
        answer = raw.get("answer")
        if not isinstance(answer, (int, float)) or isinstance(answer, bool):
            raise QuestionsError(f"{where}: numeric needs a number in 'answer'")
        tolerance = raw.get("tolerance", 0)
        if not isinstance(tolerance, (int, float)) or tolerance < 0:
            raise QuestionsError(f"{where}: 'tolerance' must be a non-negative number")
        item.answer = float(answer)
        item.tolerance = float(tolerance)

    elif itype == "match":
        pairs = _need(raw, "pairs", where)
        if not isinstance(pairs, list) or len(pairs) < 2:
            raise QuestionsError(f"{where}: match needs at least two pairs")
        for i, pair in enumerate(pairs, start=1):
            if (
                not isinstance(pair, dict)
                or not str(pair.get("prompt", "")).strip()
                or not str(pair.get("answer", "")).strip()
            ):
                raise QuestionsError(f"{where}: pair {i} needs 'prompt' and 'answer'")
        item.pairs = pairs

    elif itype == "cloze":
        text = raw.get("text")
        if not isinstance(text, str) or not text.strip():
            raise QuestionsError(f"{where}: cloze needs 'text'")
        if not CLOZE_GAP.search(text):
            raise QuestionsError(
                f"{where}: cloze text has no gaps — write them as [[answer]]"
            )
        item.text = text

    return item


def load_questions(path: Path) -> list[Item]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise QuestionsError(f"{path}: invalid YAML: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("questions"), list):
        raise QuestionsError(f"{path}: needs a top-level 'questions' list")
    items, seen = [], set()
    for i, raw in enumerate(data["questions"], start=1):
        item = _parse_item(raw, f"{path}: question {i}")
        if item.id in seen:
            raise QuestionsError(f"{path}: duplicate question id {item.id!r}")
        seen.add(item.id)
        items.append(item)
    if not items:
        raise QuestionsError(f"{path}: no questions")
    return items


@dataclass
class Companion:
    root: Path
    library_ref: str | None  # "owner/repo" of the public twin
    license: str | None
    banks: dict[str, list[Item]]  # block id -> items


def load_companion(root: Path) -> Companion:
    """The private twin: companion.yaml plus one bank per block."""
    meta = {}
    meta_path = root / COMPANION_FILE
    if meta_path.exists():
        loaded = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise QuestionsError(f"{meta_path}: must be a mapping")
        meta = loaded

    banks: dict[str, list[Item]] = {}
    blocks = root / "blocks"
    if blocks.is_dir():
        for bank in sorted(blocks.glob(f"*/{QUESTIONS_FILE}")):
            banks[bank.parent.name] = load_questions(bank)
    if not banks:
        raise QuestionsError(
            f"{root}: no blocks/*/{QUESTIONS_FILE} — not a companion repo, or an empty one"
        )
    return Companion(
        root=root,
        library_ref=meta.get("library"),
        license=meta.get("license"),
        banks=banks,
    )


def validate_against_library(companion: Companion, library_root: Path) -> list[str]:
    """Cross-checks that only the companion's side can run (it can always
    read its public twin; the public build never sees the companion).
    Returns problems; empty means clean."""
    problems: list[str] = []

    block_dirs = {p.name for p in (library_root / "blocks").glob("*") if p.is_dir()}
    for block_id in companion.banks:
        if block_id not in sorted(block_dirs):
            problems.append(
                f"blocks/{block_id}: no such block in the library "
                f"(it has: {', '.join(sorted(block_dirs)) or 'none'})"
            )

    outcomes_path = library_root / "outcomes.yaml"
    known: set[str] | None = None
    if outcomes_path.exists():
        data = yaml.safe_load(outcomes_path.read_text(encoding="utf-8")) or {}
        known = set((data.get("outcomes") or {}).keys())
    for block_id, items in companion.banks.items():
        for item in items:
            if known is None:
                if item.assesses:
                    continue  # nothing to check against
            else:
                for oid in item.assesses:
                    if oid not in known:
                        problems.append(
                            f"blocks/{block_id}/{QUESTIONS_FILE} ({item.id}): "
                            f"assesses unknown outcome {oid!r}"
                        )
    return problems


def educator_files_in_library(library_root: Path) -> list[str]:
    """The no-answers gate: educator-only files found in a PUBLIC library.
    Run by the library's own CI so the cheap mistake fails loudly."""
    found = []
    for name in EDUCATOR_ONLY_FILES:
        for path in sorted(library_root.glob(f"blocks/*/{name}")):
            found.append(str(path.relative_to(library_root)))
    return found
