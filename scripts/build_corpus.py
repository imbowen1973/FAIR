"""Render every session and aggregate the assembler's data set.

This is the aggregation step the pipeline spec leaves between Component A
(per-session index.json) and Component B ("index.json, aggregated across
sessions", spec B.1). It renders each examples/sessions/*.md and writes
the assembler's static data directory:

    assembler/web/data/
      catalog.json                  <- aggregated contract, schema below
      sessions/<id>/session-NN.pptx
      sessions/<id>/slide-id-map.json
      sessions/<id>/index.json

catalog.json schema:

    {
      "sessions":     [{"sessionId", "title", "version", "pptx"}],
      "competencies": {"C1": "label", ...},
      "slides":       [<index.json slide entries, all sessions, in
                        session order, each already carrying sessionId,
                        sourceRef and sourcePptx (rewritten to the
                        data-relative path)>]
    }

Usage: python scripts/build_corpus.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "renderer" / "src"))
sys.path.insert(0, str(REPO / "scripts"))

from fair_renderer.render import render_session  # noqa: E402

SESSIONS_DIR = REPO / "examples" / "sessions"
TEMPLATE = REPO / "examples" / "template.pptx"
LAYOUT_MAP = REPO / "examples" / "layout-map.yaml"
DATA_DIR = REPO / "assembler" / "web" / "data"


def main() -> None:
    from check_assets import check_assets

    violations = check_assets(SESSIONS_DIR)
    if violations:
        raise SystemExit(
            "asset policy violations (fix before building):\n  " + "\n  ".join(violations)
        )

    session_files = sorted(SESSIONS_DIR.glob("*.md"))
    if not session_files:
        raise SystemExit(f"no session files in {SESSIONS_DIR}")

    sessions: list[dict] = []
    competencies: dict[str, str] = {}
    slides: list[dict] = []

    for md in session_files:
        index_doc = json.loads(
            (lambda r: r["index"].read_text())(
                render_session(
                    session_path=md,
                    template_path=TEMPLATE,
                    layout_map_path=LAYOUT_MAP,
                    out_dir=DATA_DIR / "sessions" / md.stem.split("-")[-1],
                )
            )
        )
        meta = index_doc["session"]
        sid = str(meta["session"])
        pptx_rel = f"sessions/{sid}/session-{sid}.pptx"
        sessions.append(
            {
                "sessionId": sid,
                "title": meta.get("title"),
                "version": meta.get("version"),
                "pptx": pptx_rel,
            }
        )
        for cid, label in (meta.get("competencies") or {}).items():
            existing = competencies.get(cid)
            if existing and existing != label:
                raise SystemExit(
                    f"competency {cid} has conflicting labels: {existing!r} vs {label!r}"
                )
            competencies[cid] = label
        for entry in index_doc["slides"]:
            entry = dict(entry)
            entry["sourcePptx"] = pptx_rel
            slides.append(entry)

    referenced = {c for s in slides for c in s["develops"]}
    unlabeled = sorted(referenced - set(competencies))
    if unlabeled:
        print(f"warning: competencies without labels: {unlabeled}", file=sys.stderr)
        for cid in unlabeled:
            competencies[cid] = cid

    catalog = {
        "sessions": sessions,
        "competencies": dict(sorted(competencies.items())),
        "slides": slides,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = DATA_DIR / "catalog.json"
    out.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}: {len(sessions)} sessions, {len(slides)} slides, "
          f"{len(competencies)} competencies")


if __name__ == "__main__":
    main()
