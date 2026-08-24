"""Corpus builder: render a library of sessions and emit its catalog.

This is what a library repo's CI calls (`edufair-corpus`) to publish its
data/ directory — the contract the assembler's Library picker consumes:

    <out>/catalog.json
    <out>/sessions/<id>/session-<id>.pptx
    <out>/sessions/<id>/slide-id-map.json
    <out>/sessions/<id>/index.json

catalog.json schema (as-built spec section 4, plus credentials):

    {
      "sessions":     [{"sessionId", "title", "version", "pptx"}],
      "competencies": {"CE1": "label", ...},
      "outcomes":     {"O1": {"statement", "develops", "dok"}, ...},
      "slides":       [<index entries, sourcePptx data-relative>],
      "credentials":  [<credential definitions, passthrough>]
    }

Competency labels merge from two places: each session's frontmatter
`competencies:` map, then an optional framework file
(competencies/framework.yaml) which wins on conflict — the framework is
the library-level source of truth, frontmatter the convenience.

Credential definitions (credentials/*.yaml) are validated against the
built corpus: module session refs and required competency ids must
exist; a contact-hours claim drifting >25% from the referenced
sessions' summed durations is warned about (accreditation drift).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

from .assets import check_assets
from .outcomes import OUTCOMES_FILE, load_outcomes
from .library import Library, LibraryError, load_library
from .render import render_session


class CorpusError(Exception):
    pass


def _load_framework(path: Path) -> dict[str, str]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "competencies" not in data:
        raise CorpusError(f"{path}: framework file needs a 'competencies' mapping")
    labels: dict[str, str] = {}
    for cid, entry in data["competencies"].items():
        if isinstance(entry, str):
            labels[str(cid)] = entry
        elif isinstance(entry, dict) and "label" in entry:
            labels[str(cid)] = str(entry["label"])
        else:
            raise CorpusError(f"{path}: competency {cid!r} needs a label")
    return labels


# Delivery structure, outermost first. A container holds either sessions
# or the next level down, never both: modules -> days -> blocks -> sessions.
# Every level is optional, so a flat modules[].sessions[] stays valid.
NESTING = ("modules", "days", "blocks")


def _walk_containers(node: dict, path: Path, level: int = 0):
    """Yield (container_title, session_id) from a credential's structure.

    Recurses through whichever of NESTING is present, so libraries that
    declare only modules and libraries that declare modules/days/blocks
    both validate through one code path.
    """
    for key in NESTING[level:]:
        children = node.get(key)
        if children is None:
            continue
        if not isinstance(children, list):
            raise CorpusError(f"{path}: {key!r} must be a list")
        if node.get("sessions"):
            raise CorpusError(
                f"{path}: {node.get('title')!r} declares both 'sessions' and "
                f"{key!r} — a container holds one or the other, not both"
            )
        for child in children:
            yield from _walk_containers(child, path, NESTING.index(key) + 1)
        return
    for sid in node.get("sessions", []) or []:
        yield node.get("title"), str(sid)


def _validate_credential(
    cred: dict, path: Path, session_ids: set[str], competencies: set[str],
    durations: dict[str, int], warn,
) -> None:
    for req in cred.get("requires", []):
        cid = req.get("competency") if isinstance(req, dict) else req
        if cid not in competencies:
            raise CorpusError(
                f"{path}: requires unknown competency {cid!r}; known: {sorted(competencies)}"
            )
    referenced: list[str] = []
    for title, sid in _walk_containers(cred, path):
        if sid not in session_ids:
            raise CorpusError(
                f"{path}: {title!r} references unknown "
                f"session {sid!r}; known: {sorted(session_ids)}"
            )
        referenced.append(sid)
    contact = (cred.get("workload") or {}).get("contact")
    if contact and referenced:
        actual_h = sum(durations.get(sid, 0) for sid in referenced) / 60
        if actual_h and abs(actual_h - contact) / contact > 0.25:
            warn(
                f"{path.name}: workload.contact claims {contact}h but referenced "
                f"sessions sum to {actual_h:.1f}h — reconcile before accreditation"
            )


def _catalog_attribution(path: Path | None, out_dir: Path) -> dict | None:
    """The library's funder credit, in a form a web surface can render.

    The logo is copied beside the catalog and referenced by a relative
    name, so a consumer needs nothing but the data directory.
    """
    if path is None:
        return None
    from .attribution import load_attribution

    config = load_attribution(path)
    # No text means no stamp, so there is nothing to carry into the
    # catalog either.
    if config is None:
        return None
    entry = {
        "text": config["text"],
        "corner": config["corner"],
        "opacity": config["opacity"],
        "logo": None,
    }
    logo_path = config.get("_logo_path")
    if logo_path:
        out_dir.mkdir(parents=True, exist_ok=True)
        name = f"attribution-logo{logo_path.suffix.lower()}"
        (out_dir / name).write_bytes(logo_path.read_bytes())
        entry["logo"] = name
    return entry


def _units(lib: Library | None, sessions_dir: Path | None) -> list[dict]:
    """One entry per thing that renders to a deck, from either shape."""
    if lib is not None:
        return [
            {
                "id": block.block_id,
                "source": block.slides,
                "dir": block.directory,
                "title": block.title,
                "duration": block.duration_minutes,
                "competencies": block.competencies,
                "resources": block.resources,
            }
            for block in lib.blocks.values()
            if block.has_slides
        ]
    return [
        {
            "id": md.stem.replace("session-", ""),
            "source": md,
            "dir": md.parent,
            "title": None,
            "duration": None,
            "competencies": {},
            "resources": [],
        }
        for md in sorted(sessions_dir.glob("*.md"))
    ]


def build_corpus(
    sessions_dir: Path = None,
    template: Path = None,
    layout_map: Path = None,
    out_dir: Path = None,
    framework: Path | None = None,
    credentials_dir: Path | None = None,
    attribution: Path | None = None,
    library: Path | None = None,
    warn=lambda msg: print(f"warning: {msg}", file=sys.stderr),
) -> dict:
    """Render a library: one deck per block, plus its catalog.

    `library` is the repo root holding course.yaml and blocks/. The
    older `sessions_dir` argument names a directory of flat session
    files and is still honoured, so a library mid-migration builds.
    """
    if library is not None:
        lib = load_library(library)
        root = library
    elif sessions_dir is not None:
        lib = None
        root = sessions_dir.parent
    else:
        raise CorpusError("build_corpus needs either library= or sessions_dir=")

    # Rendering is the only path from content to deck, so attribution has
    # to ride this path or it is not enforced at all. Default to the
    # library-root convention rather than requiring every caller to pass it.
    if attribution is None:
        candidate = root / "attribution.yaml"
        attribution = candidate if candidate.exists() else None
    if framework is None:
        candidate = root / "competencies" / "framework.yaml"
        framework = candidate if candidate.exists() else None
    if credentials_dir is None:
        candidate = root / "credentials"
        credentials_dir = candidate if candidate.is_dir() else None

    violations = check_assets(root if lib else sessions_dir)
    if violations:
        raise CorpusError(
            "asset policy violations (fix before building):\n  "
            + "\n  ".join(violations)
        )

    sessions: list[dict] = []
    competencies: dict[str, str] = {}
    slides: list[dict] = []
    durations: dict[str, int] = {}
    blocks_out: list[dict] = []

    units = _units(lib, sessions_dir)
    if not units:
        raise CorpusError(f"no content to render in {root}")

    # Loaded before anything renders: slides derive their competencies
    # from it. Passed explicitly rather than left to render_session's
    # auto-detect, which walks up from the session file and lands in
    # blocks/ for a library.
    outcomes_path = root / OUTCOMES_FILE
    if not outcomes_path.is_file():
        outcomes_path = None

    for unit in units:
        result = render_session(
            session_path=unit["source"],
            template_path=template,
            layout_map_path=layout_map,
            attribution_path=attribution,
            outcomes_path=outcomes_path,
            out_dir=out_dir / "sessions" / unit["id"],
        )
        index_doc = json.loads(result["index"].read_text())
        meta = index_doc["session"]
        sid = str(meta.get("session") or unit["id"])
        pptx_rel = f"sessions/{unit['id']}/{result['pptx'].name}"
        sessions.append(
            {
                "sessionId": sid,
                "blockId": unit["id"],
                "title": unit["title"] or meta.get("title"),
                "version": meta.get("version"),
                "pptx": pptx_rel,
                # The tree totals durations at block and day level.
                "durationMinutes": unit["duration"] or meta.get("duration_minutes"),
                "outcomes": meta.get("outcomes") or [],
            }
        )
        if isinstance(sessions[-1]["durationMinutes"], int):
            durations[sid] = sessions[-1]["durationMinutes"]
        for cid, label in {**(meta.get("competencies") or {}), **unit["competencies"]}.items():
            existing = competencies.get(cid)
            if existing and existing != label and existing != cid and label != cid:
                raise CorpusError(
                    f"competency {cid} has conflicting labels: {existing!r} vs {label!r}"
                )
            competencies.setdefault(cid, label)
        for entry in index_doc["slides"]:
            entry = dict(entry)
            entry["sourcePptx"] = pptx_rel
            entry["blockId"] = unit["id"]
            slides.append(entry)

        # Resources are copied and indexed, never parsed: the renderer has
        # no opinion about a workbook beyond where it lives.
        resources = []
        for res in unit["resources"]:
            dest = out_dir / "blocks" / unit["id"] / res.path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes((unit["dir"] / res.path).read_bytes())
            resources.append(
                {
                    "type": res.type,
                    "title": res.title,
                    "path": f"blocks/{unit['id']}/{res.path}",
                }
            )
        if lib is None:
            # A flat library has sessions, not blocks. Emitting pseudo-blocks
            # would make the two shapes indistinguishable downstream.
            continue
        blocks_out.append(
            {
                "blockId": unit["id"],
                "title": unit["title"] or meta.get("title"),
                "durationMinutes": sessions[-1]["durationMinutes"],
                "pptx": pptx_rel,
                "resources": resources,
            }
        )

    if framework and framework.exists():
        competencies.update(_load_framework(framework))

    # Re-read now that the framework is known, so an outcome naming a
    # competency that does not exist raises rather than passing silently.
    catalogue = load_outcomes(outcomes_path, set(competencies) or None) if outcomes_path else {}

    # Which session owns each outcome, from the blocks' own declarations.
    outcome_owner: dict[str, str] = {}
    if lib:
        for block in lib.blocks.values():
            for oid in block.outcomes:
                outcome_owner.setdefault(oid, block.block_id)


    referenced = {c for s in slides for c in s["develops"]}
    unlabeled = sorted(referenced - set(competencies))
    if unlabeled:
        warn(f"competencies without labels: {unlabeled}")
        for cid in unlabeled:
            competencies[cid] = cid

    credentials: list[dict] = []
    if credentials_dir and credentials_dir.exists():
        session_ids = {s["sessionId"] for s in sessions}
        known = set(competencies) | referenced
        for cred_path in sorted(credentials_dir.glob("*.yaml")):
            cred = yaml.safe_load(cred_path.read_text(encoding="utf-8"))
            if not isinstance(cred, dict) or "id" not in cred:
                raise CorpusError(f"{cred_path}: credential needs at least an 'id'")
            _validate_credential(cred, cred_path, session_ids, known, durations, warn)
            credentials.append(cred)

    catalog = {
        # The recipe: identity and delivery structure, holding no content
        # itself. Stable while the blocks beneath it churn.
        "course": {
            "id": (lib.course.get("id") if lib else None),
            "title": (lib.title if lib else None),
            "description": (lib.course.get("description") if lib else None),
        },
        "structure": (lib.structure if lib else []),
        "blocks": blocks_out,
        "sessions": sessions,
        "competencies": dict(sorted(competencies.items())),
        # The chain a report needs: slide -> outcome -> competency. Slides
        # carry their outcome ids, and each outcome says what it develops.
        "outcomes": {
            oid: {
                "statement": o.statement,
                "develops": o.develops,
                # The session it belongs to. An outcome is what one
                # session is for; the competency is the thread across them.
                **({"block": outcome_owner[oid]} if oid in outcome_owner else {}),
                **({"dok": o.dok} if o.dok is not None else {}),
            }
            for oid, o in sorted(catalogue.items())
        },
        "slides": slides,
        "credentials": credentials,
        # The funder credit travels with the content, so any surface
        # showing a library (the pane's footer, a future viewer) can
        # display the right one without hard-coding a grant it will
        # outlive. Null when the library declares none.
        "attribution": _catalog_attribution(attribution, out_dir),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "catalog.json"
    out.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    return {
        "catalog": out,
        "sessions": len(sessions),
        "slides": len(slides),
        "competencies": len(competencies),
        "outcomes": len(catalogue),
        "credentials": len(credentials),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="edufair-corpus",
        description="Render every session in a library and emit its catalog (data/ directory)",
    )
    ap.add_argument("library", type=Path, nargs="?", default=None,
                    help="library root: the repo holding course.yaml and blocks/")
    ap.add_argument("--sessions", type=Path, default=None,
                    help="legacy: a directory of flat session files")
    ap.add_argument("--template", type=Path, default=None)
    ap.add_argument("--layout-map", type=Path, default=None)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--framework", type=Path, default=None,
                    help="competencies framework yaml (labels win over frontmatter)")
    ap.add_argument("--credentials", type=Path, default=None,
                    help="directory of credential yaml definitions")
    ap.add_argument("--attribution", type=Path, default=None,
                    help="attribution.yaml (default: beside the sessions directory)")
    args = ap.parse_args(argv)

    if args.library is None and args.sessions is None:
        print("error: give a library root, or --sessions for the legacy shape",
              file=sys.stderr)
        return 1

    # Template and layout map live in the library, so a library build
    # needs nothing else on the command line.
    root = args.library if args.library is not None else args.sessions.parent
    template = args.template or root / "template.pptx"
    layout_map = args.layout_map or root / "layout-map.yaml"

    try:
        summary = build_corpus(
            sessions_dir=args.sessions,
            library=args.library,
            template=template,
            layout_map=layout_map,
            out_dir=args.out,
            framework=args.framework, credentials_dir=args.credentials,
            attribution=args.attribution,
        )
    except (CorpusError, LibraryError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(
        f"wrote {summary['catalog']}: {summary['sessions']} sessions, "
        f"{summary['slides']} slides, {summary['competencies']} competencies, "
        f"{summary['credentials']} credentials"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
