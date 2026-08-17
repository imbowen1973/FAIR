"""Corpus builder: render a library of sessions and emit its catalog.

This is what a library repo's CI calls (`fair-corpus`) to publish its
data/ directory — the contract the assembler's Library picker consumes:

    <out>/catalog.json
    <out>/sessions/<id>/session-<id>.pptx
    <out>/sessions/<id>/slide-id-map.json
    <out>/sessions/<id>/index.json

catalog.json schema (as-built spec section 4, plus credentials):

    {
      "sessions":     [{"sessionId", "title", "version", "pptx"}],
      "competencies": {"CE1": "label", ...},
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
    for module in cred.get("modules", []):
        for sid in module.get("sessions", []):
            if str(sid) not in session_ids:
                raise CorpusError(
                    f"{path}: module {module.get('title')!r} references unknown "
                    f"session {sid!r}; known: {sorted(session_ids)}"
                )
            referenced.append(str(sid))
    contact = (cred.get("workload") or {}).get("contact")
    if contact and referenced:
        actual_h = sum(durations.get(sid, 0) for sid in referenced) / 60
        if actual_h and abs(actual_h - contact) / contact > 0.25:
            warn(
                f"{path.name}: workload.contact claims {contact}h but referenced "
                f"sessions sum to {actual_h:.1f}h — reconcile before accreditation"
            )


def build_corpus(
    sessions_dir: Path,
    template: Path,
    layout_map: Path,
    out_dir: Path,
    framework: Path | None = None,
    credentials_dir: Path | None = None,
    warn=lambda msg: print(f"warning: {msg}", file=sys.stderr),
) -> dict:
    violations = check_assets(sessions_dir)
    if violations:
        raise CorpusError(
            "asset policy violations (fix before building):\n  " + "\n  ".join(violations)
        )

    session_files = sorted(sessions_dir.glob("*.md"))
    if not session_files:
        raise CorpusError(f"no session files in {sessions_dir}")

    sessions: list[dict] = []
    competencies: dict[str, str] = {}
    slides: list[dict] = []
    durations: dict[str, int] = {}

    for md in session_files:
        result = render_session(
            session_path=md,
            template_path=template,
            layout_map_path=layout_map,
            out_dir=out_dir / "sessions" / md.stem.replace("session-", ""),
        )
        index_doc = json.loads(result["index"].read_text())
        meta = index_doc["session"]
        sid = str(meta["session"])
        pptx_rel = f"sessions/{md.stem.replace('session-', '')}/{result['pptx'].name}"
        sessions.append(
            {
                "sessionId": sid,
                "title": meta.get("title"),
                "version": meta.get("version"),
                "pptx": pptx_rel,
            }
        )
        if isinstance(meta.get("duration_minutes"), int):
            durations[sid] = meta["duration_minutes"]
        for cid, label in (meta.get("competencies") or {}).items():
            existing = competencies.get(cid)
            if existing and existing != label:
                raise CorpusError(
                    f"competency {cid} has conflicting labels: {existing!r} vs {label!r}"
                )
            competencies[cid] = label
        for entry in index_doc["slides"]:
            entry = dict(entry)
            entry["sourcePptx"] = pptx_rel
            slides.append(entry)

    if framework and framework.exists():
        competencies.update(_load_framework(framework))

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
        "sessions": sessions,
        "competencies": dict(sorted(competencies.items())),
        "slides": slides,
        "credentials": credentials,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "catalog.json"
    out.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    return {
        "catalog": out,
        "sessions": len(sessions),
        "slides": len(slides),
        "competencies": len(competencies),
        "credentials": len(credentials),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog="fair-corpus",
        description="Render every session in a library and emit its catalog (data/ directory)",
    )
    ap.add_argument("--sessions", type=Path, required=True)
    ap.add_argument("--template", type=Path, required=True)
    ap.add_argument("--layout-map", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--framework", type=Path, default=None,
                    help="competencies framework yaml (labels win over frontmatter)")
    ap.add_argument("--credentials", type=Path, default=None,
                    help="directory of credential yaml definitions")
    args = ap.parse_args(argv)

    try:
        summary = build_corpus(
            args.sessions, args.template, args.layout_map, args.out,
            framework=args.framework, credentials_dir=args.credentials,
        )
    except CorpusError as e:
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
