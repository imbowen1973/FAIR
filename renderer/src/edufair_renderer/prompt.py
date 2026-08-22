"""Instructions for a model, written from a library's own vocabulary.

A general prompt about "the eduFAIR grammar" produces content that
almost works. A model told to write slides will invent a `TwoColumn`
layout, tag a competency that does not exist, and put a `body:` region
in a layout that offers `full:` — because nothing told it what *this*
template has.

So the prompt is generated, not written. It carries the layouts this
template actually offers, the regions each one has, the competency ids
this course defines and the outcomes its sessions own. What comes back
then validates on the first attempt rather than the third.

    edufair-prompt path/to/library > prompt.md

The result is pasted into a custom GPT's instructions. It is per-library
by nature: a different template offers different layouts, and a prompt
that outlived its template would be worse than none.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

from .layoutmap import load_layout_map
from .outcomes import OUTCOMES_FILE, load_outcomes


def _framework(root: Path) -> dict[str, str]:
    path = root / "competencies" / "framework.yaml"
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out = {}
    for cid, entry in (data.get("competencies") or {}).items():
        out[str(cid)] = entry if isinstance(entry, str) else str(entry.get("label", cid))
    return out


def _course(root: Path) -> dict:
    path = root / "course.yaml"
    return (yaml.safe_load(path.read_text(encoding="utf-8")) or {}) if path.is_file() else {}


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


def build_prompt(root: Path) -> str:
    """The custom instructions for this library."""
    bindings = load_layout_map(root / "layout-map.yaml")
    competencies = _framework(root)
    outcomes = load_outcomes(root / OUTCOMES_FILE, set(competencies) or None)
    course = _course(root)

    title = course.get("title") or root.name
    lines: list[str] = []
    add = lines.append

    add(f"# Writing sessions for {title}")
    add("")
    add(
        "You write teaching content for this course. It is stored as markdown "
        "in git and rendered into a branded PowerPoint template, a Word "
        "template and Moodle XML. You never describe how anything should "
        "look: no fonts, no colours, no sizes, no positions. The template "
        "owns all of that. You choose **meaning** — which layout a slide "
        "wants, what goes in each region, what the session is for."
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

    # ---- the grammar ----------------------------------------------------
    add("## How a slide is written")
    add("")
    add("```markdown")
    add(_example_slide(bindings))
    add("```")
    add("")
    add("A region is either a plain string, or a mapping with a `type`:")
    add("")
    add("- `ul` / `ol` with `items:` — a list. Items may nest via `text:`/`items:`.")
    add("- `p` with `text:` — a paragraph.")
    add("- `image` with `src:` — a picture, and `fit:` cover, contain, width or height.")
    add("- `video` with `url:` — hosted video, never a file.")
    add("")
    add("Inside any text you may use, and nothing else:")
    add("")
    add("`**bold**`, `*italic*`, `H~2~O`, `x^2^`, `~~struck~~`, `__underlined__`, `` `code` ``")
    add("")
    add(
        "`notes:` are the speaker notes and they matter as much as the slide. "
        "Write what the teacher says and does — the question to ask, the thing "
        "to wait for, the mistake to expect — not a transcript of the bullets."
    )
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

    # ---- how to write ---------------------------------------------------
    add("## Writing a session")
    add("")
    add(
        "Ask who the learners are and how long the session is before you write. "
        "If you are not told, say what you have assumed at the top of your reply."
    )
    add("")
    add("Then produce, in this order:")
    add("")
    add(
        "1. **The deck.** Open with a `role: title` slide and a `role: outcomes` "
        "slide — both are filled from the library, so write neither. Then the "
        "content. One idea per slide. A slide with more than six bullets is "
        "two slides."
    )
    add(
        "2. **The lesson plan** — a markdown document: what happens, in what "
        "order, with timings that add up to the session length."
    )
    add(
        "3. **The assessment** — questions in Moodle XML, each tagged with the "
        "outcome it assesses."
    )
    add("")
    add(
        "Choose the layout from what the content is, not from variety. Two things "
        "being contrasted want `Comparison`; a list of points wants `Full`. "
        "Reaching for a layout because the last slide used a different one is "
        "how decks become noise."
    )
    add("")
    add(
        "Return the deck as one markdown code block containing only `--- slide` "
        "blocks, ready to paste into the workbench's import. Do not wrap it in "
        "commentary — anything outside the blocks will be pasted too."
    )
    add("")
    add("## What will be refused")
    add("")
    add("The import checks before anything is added, and will reject:")
    add("")
    add("- a layout not in the table above")
    add("- a region that layout does not offer")
    add("- an outcome id that does not exist")
    add("")
    add(
        "If that happens you will be shown the message. It names what the "
        "template does offer — read it and correct the slide rather than "
        "changing approach."
    )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="edufair-prompt",
        description=(
            "Write custom GPT instructions from a library's own layouts, "
            "competencies and outcomes"
        ),
    )
    ap.add_argument("library", type=Path)
    ap.add_argument("--out", type=Path, default=None, help="default: stdout")
    args = ap.parse_args(argv)

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
