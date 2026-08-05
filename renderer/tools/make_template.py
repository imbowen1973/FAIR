"""Generate examples/template.pptx from python-pptx's default template.

Stand-in for the consortium's branded template. The four spec layouts map
onto default layouts whose placeholder indices already match
layout-map.yaml:

    Title   <- "Title Slide"        (idx 0 title, 1 subtitle)
    Full    <- "Title and Content"  (idx 0 title, 1 content)
    Split   <- "Two Content"        (idx 0 title, 1 left, 2 right)
    Section <- "Section Header"     (idx 0 title, 1 text)

Only the layout names change; geometry, master, and theme are inherited.
When the consortium's real template.pptx arrives it drops in with the
same layout names and a re-validated layout-map.yaml.

Usage: python tools/make_template.py <output.pptx>
"""

import sys
from pathlib import Path

from pptx import Presentation

RENAMES = {
    "Title Slide": "Title",
    "Title and Content": "Full",
    "Two Content": "Split",
    "Section Header": "Section",
}


def main(out_path: Path) -> None:
    prs = Presentation()
    renamed = set()
    for master in prs.slide_masters:
        for layout in master.slide_layouts:
            if layout.name in RENAMES:
                new_name = RENAMES[layout.name]
                layout.element.cSld.set("name", new_name)
                renamed.add(new_name)
    missing = set(RENAMES.values()) - renamed
    if missing:
        raise SystemExit(f"default template lacked expected layouts: {missing}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
