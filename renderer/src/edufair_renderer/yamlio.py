"""Reading YAML, including YAML this project once wrote badly.

The workbench collapses a short list of bare words back to flow style so
that editing a title does not produce a diff nobody wants to read. For a
while it stopped at the first item it could not fold and inlined the ones
before it, leaving the rest as block entries under a flow sequence:

    items: [SAFFT4EU]
      - REGE FARMS
      - FARMS 5.0

That is not YAML. PyYAML says so at length -- "expected <block end>, but
found '<block sequence start>'" -- and refuses the slide, so a build
fails on a file whose content is entirely present and perfectly clear.

The writer was fixed and the workbench mends what it reads, but neither
helps here. The bytes are on the branch, in every repository that was
edited while it was broken, and a build reads the branch. A renderer
that cannot read the files this project's own editor produced is not
much of a renderer, and "re-open every deck in the workbench and save
it" is not a migration anybody should be asked to run.

The damage is exactly reversible, because only bare scalars were ever
inlined: no commas, no quotes, no nesting. So a flow sequence directly
followed by block entries at the item indent is unambiguously one list.

This is safe to apply to every document. The shape it repairs is invalid
YAML in every case, so no valid file can be altered by it -- if the
pattern is there, the file was broken, and it was broken by us.
"""

from __future__ import annotations

import re

import yaml

# `key: [a, b]` on a line of its own, which is the only thing the
# workbench's inliner ever produced.
_FLOW = re.compile(r"^(\s*)([\w.-]+):[ \t]*\[([^\]]*)\][ \t]*$")


def repair_inlined_lists(text: str) -> str:
    """Put back a list that was written as a flow sequence with a tail."""
    if "[" not in text:
        return text

    crlf = "\r\n" in text
    lines = text.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    mended = False

    i = 0
    while i < len(lines):
        head = _FLOW.match(lines[i])
        if head is None:
            out.append(lines[i])
            i += 1
            continue

        indent, key, inside = head.group(1), head.group(2), head.group(3)
        item = re.compile("^" + re.escape(indent) + r"  - (.*)$")

        stranded: list[str] = []
        j = i + 1
        while j < len(lines):
            found = item.match(lines[j])
            if found is None:
                break
            stranded.append(found.group(1))
            j += 1

        # Nothing dangling under it: an ordinary, valid flow sequence.
        if not stranded:
            out.append(lines[i])
            i += 1
            continue

        inlined = [part.strip() for part in inside.split(",")] if inside.strip() else []
        out.append(f"{indent}{key}:")
        for entry in inlined + stranded:
            out.append(f"{indent}  - {entry}")
        i = j
        mended = True

    if not mended:
        return text
    joined = "\n".join(out)
    return joined.replace("\n", "\r\n") if crlf else joined


def safe_load(text: str):
    """`yaml.safe_load`, having first mended what we are known to break."""
    return yaml.safe_load(repair_inlined_lists(text))
