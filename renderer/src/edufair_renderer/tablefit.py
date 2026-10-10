"""Fit a table to its frame: column widths, a font size, row heights.

PowerPoint treats a table row's height as a minimum, never a maximum.
Text that wraps grows the row, so a table rendered at the table style's
default size (typically 18pt) with equal columns spills out of its
frame as soon as a cell holds a sentence. PowerPoint has no autofit for
tables to stop that, so the renderer has to decide the type size itself.

This module decides it, from the content alone, before anything is
drawn:

- **Columns** follow `widths` when the source gives them (an imported
  deck's own proportions, or an author's). Otherwise each column first
  gets what its longest word needs at the candidate size, cell margins
  included, and only the width left over is shared out by how much text
  each column holds. Margins are a fixed cost per column, so plain
  proportional shares starve a narrow column: a four-letter "Step"
  header could not fit, and that alone dragged a whole table down two
  points.
- **Font size** is the largest that fits the whole table in the frame
  with no word broken mid-word, searched from MAX_PT down to MIN_PT in
  half points. Below that, the smallest size that fits at all; below
  that, MIN_PT, and the caller is told it overflows.
- **Row heights** are written as a one-line minimum. PowerPoint grows
  each row to its real content, so the estimate only has to choose the
  size -- where erring large is safe -- and never forces blank space
  under a line it wrongly predicted would wrap.

Text width is estimated, not measured — there is no font engine here,
in CI, or in the browser build. The estimate is deliberately on the
wide side (CHAR_EM), so a table that fits on paper fits in PowerPoint;
the cost is a table occasionally half a point smaller than it could be.
The arithmetic is pure and integer-stable, so the same table renders to
the same bytes every time.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EMU_PER_PT = 12700

MAX_PT = 18.0
MIN_PT = 8.0
STEP_PT = 0.5

# Average glyph advance as a fraction of the font size. Calibri and the
# usual sans-serif body faces average 0.45-0.5em over running text; the
# header row is set bold by the table style, so it gets a wider budget.
# Calibrated against LibreOffice's layout of the default template.
CHAR_EM = 0.5
HEADER_EM = 0.56
LINE_HEIGHT = 1.2  # single spacing, as PowerPoint lays it out


@dataclass(frozen=True)
class TableFit:
    column_widths: list[int]  # EMU, summing exactly to the frame width
    font_pt: float
    row_heights: list[int]  # EMU, ESTIMATED; used to choose the size
    row_minimum: int  # EMU, what to write: one line plus margins
    margin_lr: int  # EMU, left and right cell margin
    margin_tb: int  # EMU, top and bottom cell margin
    overflows: bool  # True when even MIN_PT does not fit the frame

    @property
    def height(self) -> int:
        """Estimated total height -- an upper bound on what PowerPoint
        will draw, since the estimate errs wide."""
        return sum(self.row_heights)


def _words(text: str) -> list[str]:
    return text.replace("**", "").replace("*", "").split()


def _wrapped_lines(text: str, chars_per_line: int) -> int:
    """Lines a cell needs, wrapping greedily at spaces the way PowerPoint
    does. A word longer than a line is broken across lines."""
    cpl = max(1, chars_per_line)
    lines = 0
    for paragraph in (text or "").split("\n"):
        words = _words(paragraph)
        if not words:
            lines += 1
            continue
        current = 0
        lines += 1
        for word in words:
            length = len(word)
            if length > cpl:
                # A broken word starts on a fresh line and spills over.
                if current:
                    lines += 1
                lines += math.ceil(length / cpl) - 1
                current = length % cpl or cpl
                continue
            needed = length if current == 0 else current + 1 + length
            if needed > cpl:
                lines += 1
                current = length
            else:
                current = needed
    return lines


def _longest_word(texts: list[str]) -> int:
    return max((len(w) for t in texts for w in _words(t)), default=1)


def _text_weight(cells: list[str]) -> float:
    """How much text a column holds, for sharing out spare width."""
    lengths = [len(c.replace("**", "").replace("*", "")) for c in cells] or [0]
    return max(1.0, sum(lengths) / len(lengths))


def _margins(font_pt: float) -> tuple[float, float]:
    """Cell margins in points, scaled with the type: PowerPoint's default
    0.1in sides and 0.05in top/bottom are generous at 10pt."""
    return max(3.0, 0.4 * font_pt), max(1.5, 0.2 * font_pt)


def fit_table(
    header: list[str] | None,
    rows: list[list[str]],
    frame_width: int,
    frame_height: int,
    widths: list[float] | None = None,
    spans: dict[tuple[int, int], tuple[int, int]] | None = None,
    max_pt: float = MAX_PT,
    min_pt: float = MIN_PT,
) -> TableFit:
    """`spans` maps a merge's top-left (row, col) in the full grid --
    header is row 0 when present -- to (rowspan, colspan). Covered cells
    are expected to be empty."""
    all_rows = ([header] if header else []) + rows
    n_cols = len(all_rows[0])
    frame_w = frame_width / EMU_PER_PT
    frame_h = frame_height / EMU_PER_PT
    spans = spans or {}
    first_body = 1 if header else 0

    # A cell that spans columns does not say how wide any ONE column
    # should be; it is checked against their combined width instead.
    def own_column(r: int, c: int) -> bool:
        return spans.get((r, c), (1, 1))[1] == 1

    body_cols = [
        [all_rows[r][c] for r in range(first_body, len(all_rows)) if own_column(r, c)]
        for c in range(n_cols)
    ]
    weights = [_text_weight(cells) for cells in body_cols]
    # The longest word in each column, in ems, header measured bold.
    word_em = [
        max(
            _longest_word(body_cols[c]) * CHAR_EM,
            (_longest_word([header[c]]) * HEADER_EM)
            if header and own_column(0, c) else 0.0,
        )
        for c in range(n_cols)
    ]

    def columns(font_pt: float, lr: float) -> list[float]:
        if widths:
            total = sum(widths)
            return [frame_w * w / total for w in widths]
        need = [em * font_pt + 2 * lr for em in word_em]
        spare = frame_w - sum(need)
        if spare <= 0:
            # Not every word fits whole at this size; share in proportion
            # to need, and let the search go smaller.
            total = sum(need)
            return [frame_w * n / total for n in need]
        total_w = sum(weights)
        return [n + spare * w / total_w for n, w in zip(need, weights)]

    def layout(font_pt: float):
        lr, tb = _margins(font_pt)
        cols = columns(font_pt, lr)
        heights = []
        tall = []  # (first row, rowspan, height the merged cell needs)
        words_fit = True
        for r, row in enumerate(all_rows):
            em = HEADER_EM if (header and r == 0) else CHAR_EM
            lines = 1
            for c, text in enumerate(row):
                rowspan, colspan = spans.get((r, c), (1, 1))
                width = sum(cols[c:c + colspan])
                cpl = int((width - 2 * lr) // (font_pt * em))
                if text and (cpl < 1 or _longest_word([text]) > cpl):
                    words_fit = False
                cell_lines = _wrapped_lines(text, cpl) if text else 1
                if rowspan > 1:
                    tall.append((r, rowspan, cell_lines * font_pt * LINE_HEIGHT + 2 * tb))
                else:
                    lines = max(lines, cell_lines)
            heights.append(lines * font_pt * LINE_HEIGHT + 2 * tb)
        # A cell merged down several rows needs their combined height;
        # any shortfall goes on the last row it covers.
        for r, rowspan, need in tall:
            have = sum(heights[r:r + rowspan])
            if need > have:
                heights[r + rowspan - 1] += need - have
        return cols, heights, words_fit, lr, tb

    steps = int(round((max_pt - min_pt) / STEP_PT))
    candidates = [max_pt - i * STEP_PT for i in range(steps + 1)]

    chosen = None
    fallback = None
    for pt in candidates:
        laid = layout(pt)
        cols, heights, words_fit, lr, tb = laid
        if sum(heights) <= frame_h:
            if words_fit:
                chosen = (pt, laid)
                break
            if fallback is None:
                fallback = (pt, laid)
    overflows = False
    if chosen is None:
        if fallback is not None:
            chosen = fallback
        else:
            chosen = (min_pt, layout(min_pt))
            overflows = True

    pt, (cols, heights, _, lr, tb) = chosen
    col_emu = [int(c * EMU_PER_PT) for c in cols]
    col_emu[-1] = frame_width - sum(col_emu[:-1])  # exact sum, no gap
    return TableFit(
        column_widths=col_emu,
        font_pt=pt,
        row_heights=[int(math.ceil(h * EMU_PER_PT)) for h in heights],
        row_minimum=int(math.ceil((pt * LINE_HEIGHT + 2 * tb) * EMU_PER_PT)),
        margin_lr=int(lr * EMU_PER_PT),
        margin_tb=int(tb * EMU_PER_PT),
        overflows=overflows,
    )
