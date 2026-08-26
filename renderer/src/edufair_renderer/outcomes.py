"""Learning outcomes: the link between a slide and a competency.

A slide used to say `develops: [AP1]` — straight from a slide to a
competency, with nothing in between. That cannot express what a course
actually claims, because the thing a session is *for* is a learning
outcome, and a competency is what an outcome builds towards:

    slide ─┐
           ├─▶ outcome ─▶ competency ─▶ credential
    question ┘

So outcomes are tagged items with stable ids, held in one catalogue at
the library root:

    outcomes:
      O1:
        statement: Distinguish andragogy from pedagogy in a clinical context
        develops: [AP1]
        dok: 2

Two consequences, and both are the point:

- **A slide's competencies are derived.** It names outcomes; what it
  develops comes from them. A slide therefore cannot claim a competency
  its own outcomes do not cover.
- **The catalogue does not list its blocks.** A block declares which
  outcomes it addresses, so the catalogue stays stable while content
  churns — the same reason `course.yaml` holds no content.

The catalogue is optional. A library without one builds exactly as it
did before.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import yamlio

OUTCOMES_FILE = "outcomes.yaml"


class OutcomeError(Exception):
    pass


@dataclass
class Outcome:
    outcome_id: str
    statement: str
    develops: list[str] = field(default_factory=list)
    dok: int | None = None  # the level this outcome targets


def load_outcomes(path: Path, competencies: set[str] | None = None) -> dict[str, Outcome]:
    """Read the catalogue, checking every competency it names exists.

    An outcome pointing at a competency the framework does not define is
    an error rather than a warning: it is a claim the library cannot
    support, and credentials already get exactly this treatment for the
    same reason.
    """
    if not path.is_file():
        return {}

    try:
        data = yamlio.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise OutcomeError(f"{path}: invalid YAML: {exc}") from exc
    if not isinstance(data, dict) or "outcomes" not in data:
        raise OutcomeError(f"{path}: needs an 'outcomes' mapping")
    entries = data["outcomes"]
    if not isinstance(entries, dict):
        raise OutcomeError(f"{path}: 'outcomes' must be a mapping of id to outcome")

    out: dict[str, Outcome] = {}
    for oid, entry in entries.items():
        oid = str(oid)
        # A bare string is the statement, for a catalogue that has not yet
        # been mapped to competencies.
        if isinstance(entry, str):
            out[oid] = Outcome(outcome_id=oid, statement=entry)
            continue
        if not isinstance(entry, dict) or "statement" not in entry:
            raise OutcomeError(f"{path}: outcome {oid!r} needs a 'statement'")

        develops = entry.get("develops") or []
        if isinstance(develops, str):
            develops = [develops]
        if not isinstance(develops, list):
            raise OutcomeError(f"{path}: outcome {oid!r}: 'develops' must be a list")
        develops = [str(c) for c in develops]

        if competencies is not None:
            unknown = [c for c in develops if c not in competencies]
            if unknown:
                raise OutcomeError(
                    f"{path}: outcome {oid!r} develops unknown "
                    f"{'competencies' if len(unknown) > 1 else 'competency'} "
                    f"{unknown!r}; known: {sorted(competencies)}"
                )

        dok = entry.get("dok")
        if dok is not None and (not isinstance(dok, int) or not 1 <= dok <= 4):
            raise OutcomeError(f"{path}: outcome {oid!r}: 'dok' must be 1-4")

        out[oid] = Outcome(
            outcome_id=oid,
            statement=str(entry["statement"]),
            develops=develops,
            dok=dok,
        )
    return out


def competencies_for(outcome_ids, catalogue: dict[str, Outcome]) -> list[str]:
    """The competencies a set of outcomes develops, in first-seen order.

    Order is stable rather than sorted so a rendered index does not
    reshuffle when an unrelated outcome is added.
    """
    out: list[str] = []
    for oid in outcome_ids or []:
        for cid in catalogue.get(str(oid), Outcome(str(oid), "")).develops:
            if cid not in out:
                out.append(cid)
    return out


def derive_develops(declared, outcome_ids, catalogue: dict[str, Outcome]) -> list[str]:
    """What a slide develops: what it declares, plus what its outcomes do.

    Declared competencies come first and keep their order, so a library
    that has not adopted outcomes yet produces byte-identical output.
    """
    out = [str(c) for c in (declared or [])]
    for cid in competencies_for(outcome_ids, catalogue):
        if cid not in out:
            out.append(cid)
    return out


# ---- slides that are filled rather than typed ---------------------------


def _first_content_region(layout_regions) -> str | None:
    """The region a body of text belongs in, for a given layout."""
    for name in layout_regions or []:
        if name not in ("title", "subtitle"):
            return name
    return None


def fill_roles(session, block_meta: dict, catalogue: dict, layout_regions) -> None:
    """Fill role slides from the library, in place.

    The session title and its learning outcomes are already written down
    -- in `block.yaml` and `outcomes.yaml`. Writing them again on a slide
    is how a deck comes to disagree with the course it belongs to, so a
    slide says what it *is* and the content is filled here:

        --- slide
        id: s-01
        layout: Title
        role: title
        ---

    Anything the author does write wins. A role fills what is absent, so
    a title slide with its own subtitle keeps it, and a session that
    needs its outcomes worded differently on the slide can say so.

    `layout_regions` maps a layout key to its region names, so the body
    lands where that layout actually puts one.
    """
    from .parser import ListItem, Region

    owned = [str(o) for o in (block_meta.get("outcomes") or [])]

    for slide in session.slides:
        if not slide.role:
            continue
        present = {region.name for region in slide.regions}
        regions = layout_regions.get(slide.layout) or []

        if slide.role == "title":
            if "title" not in present:
                title = block_meta.get("title")
                if title:
                    slide.regions.append(Region(name="title", type="text", text=str(title)))
            if "subtitle" not in present and "subtitle" in regions:
                # The code if the course uses one, else its duration --
                # whichever the block actually knows.
                bits = [str(block_meta[k]) for k in ("code",) if block_meta.get(k)]
                minutes = block_meta.get("duration_minutes")
                if minutes:
                    bits.append(f"{minutes} minutes")
                if bits:
                    slide.regions.append(
                        Region(name="subtitle", type="text", text=" · ".join(bits))
                    )
            continue

        if slide.role == "outcomes":
            if "title" not in present:
                slide.regions.append(
                    Region(name="title", type="text", text="Learning outcomes")
                )
            body = _first_content_region(regions)
            if body and body not in present:
                items = [
                    ListItem(text=catalogue[oid].statement)
                    for oid in owned
                    if oid in catalogue and catalogue[oid].statement
                ]
                if items:
                    slide.regions.append(Region(name=body, type="ul", items=items))
            # The slide serves every outcome it lists, so the competency
            # derivation picks them up without anyone tagging it.
            if not slide.outcomes:
                slide.outcomes = list(owned)
