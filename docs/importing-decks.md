# Importing PowerPoint decks

`edufair-import old.pptx --out blocks/05-x`, or drop a `.pptx` on the
workbench's import door (it runs in your browser; the deck is never
uploaded). Import rescues the **content** — text, tables, pictures,
speaker notes — into a block of markdown plus media. It does not
reproduce the old slide's appearance: free positioning, fonts and
colours are what made the deck impossible to reuse, and the new
template provides all of them.

Every import writes a `report.md` (the workbench shows it before
anything is added): one row per slide with the layout chosen, a
confidence (high, medium, low) and notes saying what was approximated
or set aside. **Review the low-confidence slides before submitting.**

## Text

Every text shape is read, whether or not it sat in a placeholder. The
title is the title placeholder if there is one, else the large text
near the top. Typed bullets (`•`, `-`, `o` and similar, followed by a
space) are stripped and nesting kept; bold runs become `**bold**`. A
glyph only counts as a bullet when whitespace follows it, so `-20 °C`
and `oxygen` arrive intact.

## Tables

Become `type: table`, with:

- **column widths** from the deck, as percentages (`widths:`), when the
  columns were not all equal
- **merged cells** as in-place markers: `<` joins the cell on its left,
  `^` the cell above (see `session-md-format.md`)
- cells taken verbatim — not bullet-stripped, so leading signs survive

The font size is deliberately not carried: it is usually inherited, and
a size that suited the old frame is wrong for the new one. The renderer
fits the type to the frame.

## Pictures

Found wherever they sit: free on the slide, inside a picture or content
placeholder, or as the fill of a shape. Then:

| On the old slide | On import |
|---|---|
| a picture alone (with or without a title) | `Picture` layout |
| a picture with one short line under or over it | `Picture`, the line as `caption` |
| a picture beside a list or paragraphs | `Split`, the picture on **the side it was on** |
| text set **on top of** the picture | kept as the caption (or beside it); the report quotes it as overlaid |
| several pictures | the one that was in a placeholder, else the largest, is placed; the rest are saved to media and listed |
| the slide's own background picture | saved to media, not placed — the template owns backgrounds |
| the same picture on most slides (a logo) | dropped as the old deck's branding, noted once |

Each picture goes through the asset policy on the way in: **cropped as
the slide showed it**, resized to 2000px, re-encoded, stripped of
metadata, and compressed until it fits the repo's 500 KB cap.

Media lands in the block's `media/`, named for the deck and slide it
came from plus a hash of its content, e.g.
`media/week-2-cold-chain-s04-8be361ea.jpg`. The hash means a second
deck imported into the same block can never overwrite the first deck's
pictures.

## Not imported

Charts (rebuild as a table), SmartArt (flattened to a list; redraw as
Mermaid if the shape mattered), animations and transitions, embedded
video files (link the hosted video instead). Each is named in the
report when found.
