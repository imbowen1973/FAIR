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

## Slide blocks

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
develops: [C1, C4]
dok: 2
---
```

### Reserved keys

| Key        | Required | Meaning                                             |
|------------|----------|-----------------------------------------------------|
| `id`       | yes      | Slide id, unique within the session                 |
| `layout`   | yes      | Layout key; must exist in `layout-map.yaml`         |
| `notes`    | no       | Speaker notes (plain text)                          |
| `develops` | no       | Competency ids / ESCO URIs (list) — for `index.json`|
| `dok`      | no       | Depth-of-knowledge level (int) — for `index.json`   |

Every other top-level key is a **region name** and must match a region
declared for that layout in `layout-map.yaml`. Unknown regions are a hard
error; missing regions are allowed (the placeholder stays empty and is
removed by PowerPoint convention at edit time).

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

Inline emphasis inside any text: `**bold**`, `*italic*`,
`***bold italic***`.

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
   assembly, and removal of the visible marks — `fair-audit deck.pptx`
   reads it back from any deck, years later

Without the file, layers 1–2 are skipped; layer 3 is always written
from the session's `dc.creator` / `dc.license` frontmatter.

## Determinism note

The same session file, template, and layout map always produce the same
bytes. Slide `creationId`s are derived from `sha256(session:slide-id)`,
not random, and the output ZIP is normalized (fixed entry timestamps).
