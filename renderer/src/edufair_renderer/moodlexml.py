"""edufair-moodle-questions: the companion's banks as Moodle XML.

One category per block, importable into any partner Moodle's question
bank — quizzes are assembled and marked inside Moodle, where delivery
belongs. This merges the assessment into Moodle WITHOUT flattening the
slides: content stays git-rendered; only the question bank crosses
(companion-repo.md).

    edufair-moodle-questions path/to/companion --out bank/
    edufair-moodle-questions path/to/companion --library path/to/library --out bank/

With --library, the cross-checks run first (block ids exist, every
`assesses` hits a real outcome) and a violation stops the export.

Output is deterministic: the same companion produces byte-identical XML,
so the bank diffs cleanly and re-imports idempotently (items carry
idnumber, which Moodle uses to match on re-import).
"""

from __future__ import annotations

import sys
from pathlib import Path
from xml.sax.saxutils import escape

from .questions import (
    CLOZE_GAP,
    Companion,
    Item,
    QuestionsError,
    load_companion,
    validate_against_library,
)
from .runs import parse_emphasis


def _html(text: str) -> str:
    """Inline emphasis to HTML, everything else escaped."""
    parts = []
    for run in parse_emphasis(text or ""):
        piece = escape(run.text)
        if getattr(run, "italic", False):
            piece = f"<em>{piece}</em>"
        if getattr(run, "bold", False):
            piece = f"<strong>{piece}</strong>"
        parts.append(piece)
    return "".join(parts)


def _text_el(tag: str, html: str, indent: str) -> str:
    return (
        f"{indent}<{tag} format=\"html\">\n"
        f"{indent}  <text><![CDATA[{html}]]></text>\n"
        f"{indent}</{tag}>\n"
    )


def _header(item: Item, qtype: str) -> str:
    out = f'  <question type="{qtype}">\n'
    out += f"    <name><text>{escape(item.id)}</text></name>\n"
    out += _text_el("questiontext", f"<p>{_html(item.stem)}</p>", "    ")
    if item.feedback:
        out += _text_el("generalfeedback", _html(item.feedback), "    ")
    out += f"    <defaultgrade>{item.points:g}</defaultgrade>\n"
    out += f"    <idnumber>{escape(item.id)}</idnumber>\n"
    return out


def _tags(item: Item, block_id: str) -> str:
    tags = [f"block:{block_id}"] + [f"outcome:{o}" for o in item.assesses]
    rows = "".join(f"      <tag><text>{escape(t)}</text></tag>\n" for t in tags)
    return f"    <tags>\n{rows}    </tags>\n"


def _answer(html: str, fraction: str, feedback: str | None, fmt: str = "html") -> str:
    out = f'    <answer fraction="{fraction}" format="{fmt}">\n'
    out += f"      <text><![CDATA[{html}]]></text>\n"
    if feedback:
        out += _text_el("feedback", _html(feedback), "      ")
    out += "    </answer>\n"
    return out


def _choice(item: Item) -> str:
    single = item.type == "mcq"
    correct = [o for o in item.options if o.get("correct")]
    wrong = [o for o in item.options if not o.get("correct")]
    out = _header(item, "multichoice")
    out += f"    <single>{'true' if single else 'false'}</single>\n"
    out += "    <shuffleanswers>true</shuffleanswers>\n"
    out += "    <answernumbering>abc</answernumbering>\n"
    for opt in item.options:
        if single:
            fraction = "100" if opt.get("correct") else "0"
        elif opt.get("correct"):
            fraction = f"{100 / len(correct):.5f}".rstrip("0").rstrip(".")
        else:
            # The standard guard against ticking everything.
            fraction = f"{-100 / len(wrong):.5f}".rstrip("0").rstrip(".") if wrong else "0"
        out += _answer(f"<p>{_html(str(opt['text']))}</p>", fraction, opt.get("feedback"))
    return out


def _truefalse(item: Item) -> str:
    out = _header(item, "truefalse")
    out += _answer("true", "100" if item.answer else "0", None, "moodle_auto_format")
    out += _answer("false", "0" if item.answer else "100", None, "moodle_auto_format")
    return out


def _short(item: Item) -> str:
    out = _header(item, "shortanswer")
    out += f"    <usecase>{1 if item.case else 0}</usecase>\n"
    for accepted in item.answers:
        out += _answer(escape(accepted), "100", None, "moodle_auto_format")
    return out


def _numeric(item: Item) -> str:
    out = _header(item, "numerical")
    out += f'    <answer fraction="100" format="moodle_auto_format">\n'
    out += f"      <text>{item.answer:g}</text>\n"
    out += f"      <tolerance>{item.tolerance:g}</tolerance>\n"
    out += "    </answer>\n"
    return out


def _match(item: Item) -> str:
    out = _header(item, "matching")
    out += "    <shuffleanswers>true</shuffleanswers>\n"
    for pair in item.pairs:
        out += "    <subquestion format=\"html\">\n"
        out += f"      <text><![CDATA[<p>{_html(str(pair['prompt']))}</p>]]></text>\n"
        out += f"      <answer><text>{escape(str(pair['answer']))}</text></answer>\n"
        out += "    </subquestion>\n"
    return out


def _cloze(item: Item) -> str:
    # Authors write [[answer]]; Moodle wants {1:SHORTANSWER:=answer}.
    # The compilation lives here so nobody ever writes cloze syntax.
    compiled = CLOZE_GAP.sub(lambda m: "{1:SHORTANSWER:=" + m.group(1) + "}", item.text or "")
    out = f'  <question type="cloze">\n'
    out += f"    <name><text>{escape(item.id)}</text></name>\n"
    out += _text_el("questiontext", f"<p>{escape(compiled)}</p>", "    ")
    if item.feedback:
        out += _text_el("generalfeedback", _html(item.feedback), "    ")
    out += f"    <idnumber>{escape(item.id)}</idnumber>\n"
    return out


_RENDERERS = {
    "mcq": _choice,
    "multi": _choice,
    "truefalse": _truefalse,
    "short": _short,
    "numeric": _numeric,
    "match": _match,
    "cloze": _cloze,
}


def block_xml(block_id: str, items: list[Item], course_name: str = "eduFAIR") -> str:
    """One block's bank as a Moodle XML document, category included."""
    out = '<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n'
    out += '  <question type="category">\n'
    out += "    <category>\n"
    out += f"      <text>$course$/top/{escape(course_name)}/{escape(block_id)}</text>\n"
    out += "    </category>\n"
    out += "  </question>\n"
    for item in items:
        out += _RENDERERS[item.type](item)
        out += _tags(item, block_id)
        out += "  </question>\n"
    out += "</quiz>\n"
    return out


def export_companion(companion: Companion, out_dir: Path, course_name: str = "eduFAIR") -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for block_id, items in sorted(companion.banks.items()):
        path = out_dir / f"{block_id}.xml"
        path.write_text(block_xml(block_id, items, course_name), encoding="utf-8")
        written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="edufair-moodle-questions",
        description="Export a companion repo's question banks as Moodle XML, one file per block",
    )
    ap.add_argument("companion", type=Path, help="companion repo root")
    ap.add_argument("--out", type=Path, default=Path("bank"))
    ap.add_argument("--library", type=Path, default=None,
                    help="public twin's root: run the cross-checks before exporting")
    ap.add_argument("--course-name", default="eduFAIR",
                    help="top-level category name in Moodle's question bank")
    args = ap.parse_args(argv)

    try:
        companion = load_companion(args.companion)
        if args.library:
            problems = validate_against_library(companion, args.library)
            if problems:
                print("companion does not match its library:", file=sys.stderr)
                for p in problems:
                    print(f"  {p}", file=sys.stderr)
                return 1
        written = export_companion(companion, args.out, args.course_name)
    except QuestionsError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    total = sum(len(v) for v in companion.banks.values())
    print(f"{total} question(s) in {len(written)} bank(s) -> {args.out}")
    for path in written:
        print(f"  {path}")
    print("Import in Moodle: Question bank → Import → Moodle XML format.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
