# session.md format (v1)

This finalizes the "illustrative, not final" syntax from the pipeline spec
(`md-to-powerpoint-pipeline.md`, A.2). The renderer's parser implements
exactly this grammar.

## File structure

```
<frontmatter>
<slide block>
<slide block>
...
```

## Frontmatter

The file must begin with a YAML frontmatter block delimited by `---` lines:

```markdown
---
session: "01"
title: Cold chain fundamentals
version: 1.0.0
duration_minutes: 45
outcomes:
  - Explain cold chain integrity requirements
dc:
  creator: FAIR Consortium
  license: CC-BY-4.0
esco: []
---
```

Required keys: `session` (string, zero-padded ordinal used in output
filenames), `title`, `version`. All other keys (Dublin Core, ELM, ESCO
fields) are carried through to `index.json` untouched; the renderer does
not interpret them.

`slide_seq` is bookkeeping rather than content: the highest slide number
this deck has ever handed out. The workbench writes it only when it
cannot be worked out from the slides still present — that is, when the
highest-numbered slide has been deleted — so that its id is retired
rather than reissued. Leave it alone, and keep it if you edit the file by
hand. See **Slide ids are permanent** below.

## Slide blocks

### Slides that are filled, not typed

A session's title and its learning outcomes are already written down —
in `block.yaml` and `outcomes.yaml`. Writing them again on a slide is how
a deck comes to disagree with the course it belongs to, so a slide can
say what it **is** and let the library fill it:

```markdown
--- slide
id: s-01
layout: Title
role: title
---

--- slide
id: s-02
layout: Full
role: outcomes
---
```

That deck opens with the session's title, its code and duration, then a
bulleted list of the outcomes the session owns — and none of it is
typed twice.

| Role | Fills |
|---|---|
| `title` | `title` from the block's title; `subtitle` from its code and duration |
| `outcomes` | `title` as "Learning outcomes"; the layout's first content region with the session's outcomes |

**Anything you write wins.** A role fills what is absent, so a title
slide with its own subtitle keeps it, and a session that needs its
outcomes worded differently on the slide can simply say so. In the
workbench a filled region is shown but not editable, marked *from the
library* — typing there would make the second copy the role exists to
avoid.

An `outcomes` slide also serves those outcomes, so the competencies it
develops are derived without anyone tagging it.

A slide names the **outcomes** it serves. The competencies it develops
follow from those outcomes, so a slide cannot claim more than they
cover — see `library-format.md`. `develops:` still works for a
competency no outcome covers, and validation warns when it is used that
way.

A slide begins with a line that is exactly `--- slide` and ends with a line
that is exactly `---`. Everything between is YAML.

```markdown
--- slide
id: s01-03
layout: Split
title: Cold chain integrity
left:
  type: ul
  items:
    - Temperature logging
    - text: Break detection
      items:
        - Sensor thresholds
        - Manual inspection
    - Audit trail
right:
  type: image
  src: assets/coldchain.png
notes: |
  Speaker notes here.
outcomes: [O1]
dok: 2
---
```

### Pictures, and how they meet their frame

```yaml
picture:
  type: image
  src: media/chain.png
  fit: cover        # cover | contain | width | height
```

The template owns the shape of the hole. Only the author knows whether
*this* picture may lose its edges, so `fit` is content rather than
formatting:

| `fit` | What happens |
|---|---|
| `cover` | Fills the frame; crops whichever edges do not fit. The default. |
| `contain` | The whole picture, with space around it. |
| `width` | Matches the frame's width; crops top and bottom if it is too tall. |
| `height` | Matches the frame's height; crops the sides if it is too wide. |

`cover` lets the picture's own shape decide which way it is cropped.
`width` and `height` say which edge governs, which is what you want
across a set of photographs of differing shapes — otherwise one is
cropped at the sides and the next at the top.

A picture placeholder used to crop to fill while any other placeholder
fitted inside, so the same picture behaved differently depending on the
layout. Both now obey `fit`, and the slide stays bound to its
placeholder either way.

### Lists, and lines inside them that carry no bullet

`ul` is a bulleted list and `ol` a numbered one. An item is a string, or
a mapping with `text:` and optionally `items:` for nesting, `color:` for
a theme slot, and `bullet: false`.

Each line decides for itself. `marker:` is `bullet`, `number` or `none`,
and `align:` is `left`, `center`, `right` or `justify`. Both default to
whatever the region is, which is the ordinary case — they exist for the
one placeholder that has to hold more than one kind of line:

```yaml
full:
  type: ul
  items:
    - text: What to check before sharing
      marker: none
      align: center
    - Who can be re-identified
    - What was consented to
    - text: Ask the data controller first
      marker: number
    - text: Then record the decision
      marker: number
    - text: If anything is unclear, do not share.
      marker: none
```

`bullet: false` still works and means `marker: none`.

A layout offers the regions it offers. Where it offers one, splitting a
lead-in into a region of its own is not possible, and inventing a second
region would be a layout decision taken by the content — which is also
why alignment is per line rather than per placeholder.

The older form, kept for the same reason:

```yaml
full:
  type: ul
  items:
    - text: There are three things to check before sharing a dataset.
      bullet: false
    - Who can be re-identified
    - What was consented to
    - text: If any of them is unclear, do not share it.
      bullet: false
```

A layout offers the regions it offers. Where it offers one, splitting a
lead-in into a region of its own is not possible, and inventing a second
region would be a layout decision taken by the content.

**The bullet glyph is the template's**, as everything else about
appearance is. Where the template defines none — its master has no
`bodyStyle`, or none for that outline level — the renderer supplies one,
because a `ul` that renders without bullets contradicts the content that
declared it a list. A template that has its own is left alone.

### Reserved keys

| Key        | Required | Meaning                                             |
|------------|----------|-----------------------------------------------------|
| `id`       | yes      | Slide id, unique within the session                 |
| `layout`   | yes      | Layout key; must exist in `layout-map.yaml`         |
| `notes`    | no       | Speaker notes (plain text)                          |
| `role`     | no       | `title` or `outcomes`: filled from the library      |
| `outcomes` | no       | Outcome ids from `outcomes.yaml` (list)             |
| `develops` | no       | Competency ids claimed directly (list)              |
| `dok`      | no       | Depth-of-knowledge level (int) — for `index.json`   |

Every other top-level key is a **region name** and must match a region
declared for that layout in `layout-map.yaml`. Unknown regions are a hard
error; missing regions are allowed (the placeholder stays empty and is
removed by PowerPoint convention at edit time).

### Slide ids are permanent

An `id` is identity, not position. It is the key of `slide-id-map.json`,
the `slideId` the PowerPoint pane ticks, and it is written into the
provenance and the attribution line of **every rendered deck**. A deck
sitting in somebody's downloads says what `s-03` is; this file must not
disagree.

So:

- **An id is allocated once.** Deleting `s-03` retires the number. The
  next slide added is `s-04`, not `s-03`, even though there is now a gap.
- **An id is never renamed.** Importing slides leaves the incoming ids
  alone unless one genuinely collides, and a collision moves the
  *incoming* slide above everything the deck has used — never an existing
  one.
- **Gaps are expected and correct.** `s-01, s-02, s-04` is a deck that
  lost a slide, not a deck that needs tidying. Renumbering it to close
  the gap breaks every artifact already rendered from it.
- **Ids need not be numbers.** `intro-hook` is a perfectly good id, and
  the workbench will leave it alone.

Duplicate ids are a hard error: `slide-id-map.json` is a mapping, so the
second slide would silently win and the first would become unaddressable.
The parser refuses the file rather than let that happen.

### Region content

Any region may take a **plain string** — one unadorned paragraph in the
layout's own style. That's the form for titles, column heads
(`left_head: "Paper"`), and short captions. Otherwise a region takes a
typed object:

- `{ type: ul, items: [...] }` — bulleted list
- `{ type: ol, items: [...] }` — numbered list
- `{ type: p, text: "..." }` — plain paragraphs (newline-separated), no
  bullets
- `{ type: image, src: path }` — image, path relative to the session file
- `{ type: mermaid, src: path }` — Mermaid source, rendered to PNG at build
  time (see below)
- `{ type: video, url: https://..., poster: optional path }` — externally
  hosted video (YouTube etc.). The slide shows the poster image (or a
  generated play-button panel) hyperlinked to the URL; clicking it in
  the presentation opens the video. Video files themselves are never
  committed.

A list item is either a string or `{ text: str, items: [...], color: ... }`
for nesting. Maximum nesting depth is 5 (python-pptx paragraph levels 0–4).

A region contains text or an image, never both (per spec A.2).

### Emphasis and colour

Inline marks inside any text:

| Mark | Syntax | Example |
|---|---|---|
| bold | `**text**` | **bold** |
| italic | `*text*` | *italic* |
| bold italic | `***text***` | ***both*** |
| superscript | `x^2^` | 12 cm^2^ |
| subscript | `H~2~O` | CO~2~ |
| strikethrough | `~~text~~` | ~~withdrawn~~ |
| underline | `__text__` | __underlined__ |
| inline code | `` `text` `` | run `edufair-corpus` |

**Marks nest**: `**CO~2~ uptake**` is bold throughout with a subscript 2.

Two deliberate details. `~~` is read before a single `~`, so
strikethrough never swallows a subscript. Underline uses `__` rather
than a third tilde form, and a single `_` is never a mark — so
`snake_case_name` is left alone.

A code span is literal: markers inside it are content, not marks.

Underline is offered because content sometimes demands it, but on a
slide it usually reads as a hyperlink — prefer the template's own
emphasis where you can.

Inline code is the one place a typeface is named. OOXML themes define
major and minor fonts but no monospace slot, so the font comes from the
library, not this renderer — set `_style.code_typeface` at the top of
`layout-map.yaml` (default `Consolas`):

```yaml
_style:
  code_typeface: JetBrains Mono
```

Colour is declared in YAML, not inline, and only as **theme colour
slots** — `accent1`–`accent6`, `dk1`, `lt1`, `dk2`, `lt2`, `hlink`,
`folHlink`. `color:` on a `ul`/`ol`/`p` region colours all its text;
`color:` on an individual item overrides the region. Raw hex values are
rejected: the palette belongs to the template's theme, so a rebrand
recolours every deck with zero session edits.

Sub-list bullet glyphs are colour-coded by level in the template's
master (accent1/2/3 for levels 1–3) — authors get coloured list
hierarchy without writing anything.

### Layouts

Layouts are addressed by key and bound to the template's own layouts
by `layout-map.yaml`. The Core profile below is what any stock
PowerPoint template already provides — see `template-profile.md` for
the contract and `edufair-template` for generating the map.

The stand-in template ships ten layouts (regions in parentheses):

| Layout       | Regions                                              |
|--------------|------------------------------------------------------|
| `Title`      | title, subtitle                                      |
| `Full`       | title, full                                          |
| `Split`      | title, left, right                                   |
| `Section`    | title, subtitle                                      |
| `Comparison` | title, left_head, left, right_head, right            |
| `Caption`    | title, content, caption                              |
| `Picture`    | title, picture (a real picture placeholder), caption |
| `TitleOnly`  | title                                                |
| `Blank`      | —                                                    |
| `Cards`      | title, head1–head4, card1–card4                      |

`Picture.picture` is a native picture placeholder, so images inserted
there keep their `<p:ph>` binding (no free-positioning exception).

`Cards` is a heading over four tab-topped cards. Each `headN` is the
card's tab — a rounded-top strip filled accent1–4 respectively, centred
bold text, styled entirely by the layout, so author markdown stays
plain (`head1: "Detect"`). Each `cardN` is that card's body panel and
takes any text content type (`ul`, `ol`, `p`).

### Mermaid resolution

The renderer resolves `{type: mermaid, src: d.mmd}` in this order:

1. A pre-rendered sibling `d.png` (same directory, same stem) — preferred,
   because it keeps builds offline and deterministic. Commit the PNG next
   to the `.mmd` source.
2. `mmdc` (Mermaid CLI) on `PATH`, invoked with a pinned config.

If neither is available the build fails with an explicit error. Mermaid
Ink (network rendering) is deliberately not supported: it would break
offline builds and determinism.

## Asset policy

Enforced by `scripts/check_assets.py`, which gates every corpus build
(and therefore every publish):

- **No video binaries in the repo, ever.** Video lives on a host
  (YouTube, Vimeo, an institutional server) and is referenced with the
  `video` content type. One embedded clip outweighs a course of images.
- **Images: ≤ 500 KB and ≤ 2200 px on the long edge.** Prepare any
  image with `scripts/prepare_image.py`, which resizes to 2000 px,
  compresses, and **strips all metadata including EXIF** — clinical
  photos must not carry GPS positions, timestamps, or device ids into
  a repo.

## Attribution

An optional `attribution.yaml` at the library root (next to
`sessions/`) stamps every rendered slide. It is configured **per
library, at creation**, and identifies the **grant / funding
programme** behind the content — for EU co-funded projects that means
the exact grant name and the official "Co-funded by the European
Union" emblem (from the Commission's visual identity portal), per the
programme's visibility rules:

```yaml
text: "Co-funded by the European Union · <Project name, grant no.> · CC-BY 4.0"
logo: branding/eu-cofunded.png   # optional
corner: bottom-right             # or bottom-left
```

Three layers, all injected at render time — including when someone
else re-renders the content in *their* template, which is what makes
CC-BY operational:

1. a visible text (and logo) stamp as **locked, unselectable shapes**
   — removable only by editing the file's XML, never casually
2. a source line in the speaker notes
3. machine-readable provenance (creator, licence, session/slide ids)
   in each slide's XML, which survives re-theming, cross-deck
   assembly, and removal of the visible marks — `edufair-audit deck.pptx`
   reads it back from any deck, years later

Without the file, layers 1–2 are skipped; layer 3 is always written
from the session's `dc.creator` / `dc.license` frontmatter.

## Determinism note

The same session file, template, and layout map always produce the same
bytes. Slide `creationId`s are derived from `sha256(session:slide-id)`,
not random, and the output ZIP is normalized (fixed entry timestamps).
