"""Heal decks poisoned by the doubled creationId.

Before commit 84433cf the renderer wrote its p14:creationId at the
p:sld level. PowerPoint only recognises one inside p:cSld/p:extLst as
"this slide already has one", so inserting those slides added a second
copy there - and a slide carrying the {BB962C8B...} extension twice
makes every interactive open demand a repair. The renderer now writes
to cSld, which fixes every deck assembled from here on. It does nothing
for the decks people already saved: a fix to code is not a fix to data.

This is the fix to data. It removes the sld-level creationId from any
slide that also has one in cSld, and touches nothing else - not the
attribution extension (proven innocent by bisecting against PowerPoint
itself), not transitions, not iSpring tags, not a byte of any other
part. PowerPoint's own re-save writes the poisoned list as
<p:extLst mod="1">, so matching allows attributes on the open tag.

    edufair-heal <deck.pptx>...        report, touch nothing
    edufair-heal --fix <deck.pptx>...  heal in place, keeping
                                       <name>.pptx.pre-heal.bak
    edufair-heal --fix <directory>     every .pptx underneath
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

CRE_SLD = re.compile(
    r'<p:ext uri="\{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E\}">\s*'
    r"<p14:creationId[^>]*/>\s*</p:ext>"
)
# Any p:extLst after </p:cSld> is at the p:sld level; other elements
# (a transition, say) may sit between it and </p:sld>.
TAIL = re.compile(r"<p:extLst[^>]*?>((?:(?!</?p:extLst).)*)</p:extLst>", re.S)
CSLD_END = "</p:cSld>"
SLIDE = re.compile(r"ppt/slides/slide\d+\.xml$")


def classify(path: Path) -> tuple[str, list[str]]:
    """-> ("poisoned"|"clean"|"unreadable", slide part names affected)."""
    try:
        z = zipfile.ZipFile(path)
        names = [n for n in z.namelist() if SLIDE.match(n)]
    except Exception as e:  # noqa: BLE001 - a bad zip is a verdict, not a crash
        return ("unreadable", [str(e)])
    poisoned = []
    with z:
        for n in names:
            s = z.read(n).decode("utf-8", errors="replace")
            cut = s.find(CSLD_END)
            if cut < 0:
                continue
            in_tail = any(CRE_SLD.search(m.group(1)) for m in TAIL.finditer(s, cut))
            if in_tail and CRE_SLD.search(s[:cut]):
                poisoned.append(n)
    return ("poisoned" if poisoned else "clean", poisoned)


def heal(path: Path) -> int:
    """Remove the sld-level creationId from every poisoned slide in place.

    The original is kept beside the file as <name>.pre-heal.bak; returns
    how many slides changed.
    """
    bak = Path(str(path) + ".pre-heal.bak")
    if not bak.exists():
        shutil.copy2(path, bak)
    tmp = Path(str(path) + ".heal-tmp")
    fixed = 0
    with zipfile.ZipFile(bak) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if SLIDE.match(item.filename):
                s = data.decode("utf-8", errors="replace")

                def one(m: re.Match) -> str:
                    inner = CRE_SLD.sub("", m.group(1))
                    if not re.search(r"<p:ext\b", inner):
                        return ""  # nothing left worth keeping
                    head = m.group(0)[: m.start(1) - m.start(0)]
                    return head + inner + "</p:extLst>"

                cut = s.find(CSLD_END)
                if cut >= 0 and CRE_SLD.search(s[:cut]):
                    s2 = s[:cut] + TAIL.sub(one, s[cut:])
                    if s2 != s:
                        fixed += 1
                        data = s2.encode("utf-8")
            zout.writestr(item, data)
    os.replace(tmp, path)
    return fixed


def _decks(paths: list[Path]):
    for p in paths:
        if p.is_dir():
            for f in sorted(p.rglob("*.pptx")):
                if not f.name.startswith("~$") and not f.name.endswith(".bak"):
                    yield f
        else:
            yield p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="edufair-heal",
        description=(
            "Remove the doubled p14:creationId that makes decks assembled "
            "before the cSld fix demand a repair on open."
        ),
    )
    ap.add_argument("paths", nargs="+", type=Path, help=".pptx files or directories")
    ap.add_argument("--fix", action="store_true", help="heal in place (default: report only)")
    args = ap.parse_args(argv)

    found = 0
    for deck in _decks(args.paths):
        verdict, slides = classify(deck)
        if verdict == "clean":
            continue
        found += 1
        if verdict == "unreadable":
            print(f"unreadable  {deck}: {slides[0]}")
            continue
        if args.fix:
            n = heal(deck)
            after, _ = classify(deck)
            print(f"healed      {deck} ({n} slides, now {after}; original kept as .pre-heal.bak)")
        else:
            print(f"poisoned    {deck} ({len(slides)} slides) - run again with --fix")
    if found == 0:
        print("nothing poisoned.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
