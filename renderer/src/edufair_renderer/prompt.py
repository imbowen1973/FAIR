"""Instructions for a model that writes eduFAIR sessions.

Two halves, and both are needed.

The **generic** half is `docs/gpt-prompt.md`: how to interview before
writing — the subject and the problem behind it, the audience, how long,
what shape — then how long is how many slides, what a speaker note is
for, and how to hand the work over. It is the same for every library and
it is where the quality comes from.

The **specific** half is generated here: the layouts this template
actually offers with their real regions, the competency ids this course
defines, the outcomes its sessions own. Without it a model invents a
`TwoColumn` layout and tags a competency that does not exist, because
nothing told it otherwise.

    edufair-prompt path/to/library --out prompt.md   # both halves
    edufair-prompt --generic                         # the first only

The result is pasted into a custom GPT's instructions. The specific half
is per-library by nature: a prompt that outlived its template would be
worse than none.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

from . import yamlio

from .layoutmap import load_layout_map
from .outcomes import OUTCOMES_FILE, load_outcomes


def _framework(root: Path) -> dict[str, str]:
    path = root / "competencies" / "framework.yaml"
    if not path.is_file():
        return {}
    data = yamlio.safe_load(path.read_text(encoding="utf-8")) or {}
    out = {}
    for cid, entry in (data.get("competencies") or {}).items():
        out[str(cid)] = entry if isinstance(entry, str) else str(entry.get("label", cid))
    return out


def _course(root: Path) -> dict:
    path = root / "course.yaml"
    return (yamlio.safe_load(path.read_text(encoding="utf-8")) or {}) if path.is_file() else {}


def _example_slide(bindings) -> str:
    """A worked slide using a layout this template really has."""
    for key in ("Split", "Comparison", "Full"):
        binding = bindings.get(key)
        if not binding:
            continue
        regions = [r for r in binding.regions if r != "title"]
        if not regions:
            continue
        lines = [
            "--- slide",
            "id: s-02",
            f"layout: {key}",
            "title: What could go wrong",
        ]
        lines.append(f"{regions[0]}:")
        lines.append("  type: ul")
        lines.append("  items:")
        lines.append("    - Re-identification from *anonymised* records")
        lines.append("    - Bias baked into a model nobody audits")
        if len(regions) > 1:
            lines.append(f"{regions[1]}:")
            lines.append("  type: p")
            lines.append("  text: A single re-identified herd is a **notifiable** breach.")
        lines += [
            "notes: |",
            "  Ask who in the room has shared a spreadsheet of client data.",
            "  Wait for the silence. That is the point of the slide.",
            "---",
        ]
        return "\n".join(lines)
    return "--- slide\nid: s-02\nlayout: Full\ntitle: …\n---"


GENERIC_PROMPT = Path(__file__).resolve().parents[3] / "docs" / "gpt-prompt.md"


def generic_prompt() -> str:
    """The half that is the same for every library.

    Read from `docs/gpt-prompt.md` rather than duplicated here. It is a
    document people edit — how to interview before writing, how long is
    how many slides, what a speaker note is for — and a second copy in
    code is the one that goes stale.
    """
    if not GENERIC_PROMPT.is_file():
        return ""
    text = GENERIC_PROMPT.read_text(encoding="utf-8")
    # The file opens by saying where to paste it; the instructions
    # themselves start after the first rule.
    marker = "\n---\n"
    return text.split(marker, 1)[1].lstrip() if marker in text else text


def build_prompt(root: Path, generic: bool = True) -> str:
    """The instructions: how to write a session, and what this one has."""
    bindings = load_layout_map(root / "layout-map.yaml")
    competencies = _framework(root)
    outcomes = load_outcomes(root / OUTCOMES_FILE, set(competencies) or None)
    course = _course(root)

    title = course.get("title") or root.name
    lines: list[str] = []
    add = lines.append

    if generic:
        base = generic_prompt()
        if base:
            add(base.rstrip())
            add("")
            add("---")
            add("")

    add(f"# This library: {title}")
    add("")
    add(
        "Everything above is how to write a session. What follows is what "
        "*this* course has to write it with. Use these names and no others."
    )
    add("")

    # ---- layouts --------------------------------------------------------
    add("## The layouts this template offers")
    add("")
    add("Use these and only these. A layout that is not listed does not exist.")
    add("")
    add("| Layout | Regions | Use it for |")
    add("|---|---|---|")
    hints = {
        "Title": "the opening slide of a session",
        "Section": "a divider between parts of a session",
        "Full": "one idea, as a list or a paragraph",
        "Split": "two things side by side",
        "Comparison": "two things being contrasted, each with its own heading",
        "Picture": "an image that carries the point",
        "Caption": "an image or diagram that needs explaining",
        "Cards": "three or four short parallel points",
        "Quote": "somebody else's words",
    }
    for key, binding in bindings.items():
        if key.startswith("_"):
            continue
        regions = ", ".join(f"`{r}`" for r in binding.regions)
        add(f"| `{key}` | {regions} | {hints.get(key, 'general content')} |")
    add("")
    add(
        "A region not listed against its layout is an error. Putting `body:` "
        "into a layout that offers `full:` will be refused on import."
    )
    add("")

    # The grammar itself is in the generic half; this is a worked slide
    # using a layout that exists here, which is the part that cannot be
    # written generically.
    add("### A slide in this template")
    add("")
    add("```markdown")
    add(_example_slide(bindings))
    add("```")
    add("")

    # ---- meaning --------------------------------------------------------
    if outcomes:
        add("## The outcomes a slide may serve")
        add("")
        add("A slide says `outcomes: [O1]`. Use these ids and no others.")
        add("")
        for oid, outcome in sorted(outcomes.items()):
            develops = ", ".join(outcome.develops) or "—"
            add(f"- `{oid}` — {outcome.statement}  _(develops {develops})_")
        add("")
        add(
            "The competencies a slide develops follow from its outcomes. Do not "
            "write `develops:` yourself."
        )
        add("")
    elif competencies:
        add("## The competencies this course defines")
        add("")
        add("A slide says `develops: [C1]`. Use these ids and no others.")
        add("")
        for cid, label in sorted(competencies.items()):
            add(f"- `{cid}` — {label}")
        add("")

    add("`dok:` is depth of knowledge, 1 to 4: recall, apply, analyse, create.")
    add("")

    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="edufair-prompt",
        description=(
            "Write custom GPT instructions: how to author a session, plus "
            "this library's own layouts, competencies and outcomes"
        ),
    )
    ap.add_argument("library", type=Path, nargs="?", default=None)
    ap.add_argument("--generic", action="store_true",
                    help="the library-independent half only")
    ap.add_argument("--out", type=Path, default=None, help="default: stdout")
    args = ap.parse_args(argv)

    if args.generic or args.library is None:
        text = generic_prompt()
        if not text:
            print("error: docs/gpt-prompt.md is not where it should be",
                  file=sys.stderr)
            return 1
    else:
        try:
            text = build_prompt(args.library)
        except Exception as exc:  # a missing layout map is the usual cause
            print(f"error: {exc}", file=sys.stderr)
            return 1

    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
