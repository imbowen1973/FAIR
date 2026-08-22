"""Markdown to a small semantic document model.

The model is deliberately narrow. A block says what it *is* — a heading,
a list item, a figure, a callout — and carries the text and nothing else.
There is nowhere in it to put a font, a colour, a margin or a size, and
that absence is the enforcement of the separation the whole pipeline
rests on. A rule written in a document is a rule someone works around;
a field that does not exist is not.

Parsing is `markdown-it-py`, not something hand-rolled. CommonMark has a
long tail — lazy continuation, tight and loose lists, reference links,
nested emphasis — and a deliverable cannot be approximate. The
workbench's own markdown.js is small precisely because it only ever
previews.

Inline text is left as written and handed to `runs.parse_emphasis` at
render time, so a workbook and a slide understand `**bold**`, `H~2~O`
and `x^2^` identically. That shared grammar is the reason to reuse it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from markdown_it import MarkdownIt

# The comment markers the workbench writes around a generated outcomes
# section. A document carrying them gets a callout rather than a plain
# list, because that section is the session's own claim and reads as one.
OUTCOMES_START = "outcomes: from outcomes.yaml"
OUTCOMES_END = "/outcomes"


@dataclass
class Block:
    """One thing in a document. `kind` chooses the style; the rest is content."""

    kind: str  # title | section | subsection | body | list | quote | code
    #          | figure | table | callout | pagebreak
    text: str = ""
    level: int = 0  # list nesting depth, or heading depth beyond h3
    ordered: bool = False
    items: list["Block"] = field(default_factory=list)  # list items, table rows
    src: str | None = None  # figure
    alt: str = ""
    language: str = ""  # code
    cells: list[list[str]] = field(default_factory=list)  # table
    header: bool = False  # this table row is the header


_HEADING_KINDS = {1: "title", 2: "section", 3: "subsection"}

# An image alone in a paragraph is a figure; one inside a sentence is
# just an inline image and stays in the text.
_LONE_IMAGE = re.compile(r"^!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)(?:\s+\"[^\"]*\")?\)$")


def _md() -> MarkdownIt:
    return MarkdownIt("commonmark").enable("table").enable("strikethrough")


def _rows(tokens, start: int) -> tuple[list[list[str]], list[bool], int]:
    """Table cells and which rows are headers, from `table_open` onward."""
    cells: list[list[str]] = []
    header_flags: list[bool] = []
    row: list[str] = []
    in_header = False
    index = start + 1

    while index < len(tokens):
        token = tokens[index]
        if token.type == "table_close":
            break
        if token.type == "thead_open":
            in_header = True
        elif token.type == "thead_close":
            in_header = False
        elif token.type == "tr_open":
            row = []
        elif token.type == "tr_close":
            cells.append(row)
            header_flags.append(in_header)
        elif token.type == "inline":
            row.append(token.content)
        index += 1
    return cells, header_flags, index


def parse_document(text: str) -> list[Block]:
    """A markdown document as blocks, in the order they appear."""
    tokens = _md().parse(text or "")
    blocks: list[Block] = []

    # Where we are in nested lists: each entry is (ordered, depth).
    list_stack: list[bool] = []
    in_outcomes = False
    index = 0

    while index < len(tokens):
        token = tokens[index]

        if token.type == "html_block":
            content = token.content.strip()
            if OUTCOMES_START in content:
                in_outcomes = True
            elif OUTCOMES_END in content:
                in_outcomes = False
            index += 1
            continue

        if token.type == "heading_open":
            depth = int(token.tag[1])
            inline = tokens[index + 1]
            blocks.append(
                Block(
                    kind=_HEADING_KINDS.get(depth, "subsection"),
                    text=inline.content,
                    level=depth,
                )
            )
            index += 3
            continue

        if token.type in ("bullet_list_open", "ordered_list_open"):
            list_stack.append(token.type == "ordered_list_open")
            index += 1
            continue

        if token.type in ("bullet_list_close", "ordered_list_close"):
            if list_stack:
                list_stack.pop()
            index += 1
            continue

        if token.type == "paragraph_open":
            inline = tokens[index + 1]
            content = inline.content.strip()
            image = _LONE_IMAGE.match(content)

            if image:
                blocks.append(
                    Block(kind="figure", src=image.group("src"), alt=image.group("alt"))
                )
            elif list_stack:
                # A paragraph inside a list item is the item's text.
                blocks.append(
                    Block(
                        kind="list",
                        text=content,
                        level=len(list_stack) - 1,
                        ordered=list_stack[-1],
                    )
                )
            else:
                blocks.append(
                    Block(kind="callout" if in_outcomes else "body", text=content)
                )
            index += 3
            continue

        if token.type == "fence" or token.type == "code_block":
            blocks.append(
                Block(kind="code", text=token.content.rstrip("\n"), language=token.info.strip())
            )
            index += 1
            continue

        if token.type == "blockquote_open":
            # The quote's own paragraphs are emitted as quote blocks.
            depth = token.level
            index += 1
            while index < len(tokens) and not (
                tokens[index].type == "blockquote_close" and tokens[index].level == depth
            ):
                if tokens[index].type == "inline":
                    blocks.append(Block(kind="quote", text=tokens[index].content.strip()))
                index += 1
            index += 1
            continue

        if token.type == "table_open":
            cells, header_flags, end = _rows(tokens, index)
            blocks.append(
                Block(
                    kind="table",
                    cells=cells,
                    items=[Block(kind="row", header=flag) for flag in header_flags],
                )
            )
            index = end + 1
            continue

        if token.type == "hr":
            blocks.append(Block(kind="pagebreak"))
            index += 1
            continue

        index += 1

    return blocks
