"""edufair-audit: read the provenance out of any .pptx.

Walks every slide of the given deck(s) and reports what the FAIR
attribution extension and creationId say about where each slide came
from — including decks assembled from many sources, re-themed, or
edited after the visible attribution was removed.

    edufair-audit deck.pptx [more.pptx ...] [--json]
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

from lxml import etree

P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main"
FAIR_NS = "urn:fair:attribution:1"


def audit_deck(path: Path) -> list[dict]:
    entries = []
    with zipfile.ZipFile(path) as z:
        slide_names = sorted(
            (n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")),
            key=lambda n: int(n[len("ppt/slides/slide"):-len(".xml")]),
        )
        for name in slide_names:
            root = etree.fromstring(z.read(name))
            number = int(name[len("ppt/slides/slide"):-len(".xml")])
            creation = root.find(f".//{{{P14_NS}}}creationId")
            attribution = root.find(f".//{{{FAIR_NS}}}attribution")
            entry = {
                "deck": path.name,
                "slide": number,
                "creationId": creation.get("val") if creation is not None else None,
                "provenance": dict(attribution.attrib) if attribution is not None else None,
            }
            entries.append(entry)
    return entries


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="edufair-audit", description=__doc__)
    ap.add_argument("decks", nargs="+", type=Path)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    all_entries = []
    for deck in args.decks:
        if not deck.exists():
            print(f"error: {deck} not found", file=sys.stderr)
            return 1
        all_entries.extend(audit_deck(deck))

    if args.json:
        print(json.dumps(all_entries, indent=2))
        return 0

    for e in all_entries:
        p = e["provenance"]
        if p:
            origin = f"{p.get('creator', '?')} · {p.get('license', '?')} · {p.get('session', '?')}/{p.get('slide', '?')}"
        else:
            origin = "no FAIR provenance (not rendered by this pipeline, or stripped)"
        print(f"{e['deck']} slide {e['slide']:>3}  {origin}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
