# FAIR: markdown-to-PowerPoint teaching content pipeline

Teaching content lives as markdown in git — versioned, diffable,
reviewable. A deterministic renderer builds it into template-bound
PowerPoint decks, and a PowerPoint add-in assembles new decks by
**meaning** (competency), pulling slides across sessions. Decks are
derived artifacts; the commit is the fact. That is FAIR reuse applied
to learning content: findable via a semantic index, accessible from
git, interoperable through one branded template, reusable slide by
slide.

## What makes this unique

Markdown-to-slides tools exist. None of them are this:

- **It renders into the designer's template, not around it** — content
  binds into the named placeholders of a real branded .pptx, so output
  is indistinguishable from a hand-made deck and stays fully editable.
- **Every slide is addressable** — an injected stable identity lets
  PowerPoint's own APIs pull individual slides, turning rendered decks
  into a queryable slide database.
- **Renders are byte-deterministic** — the same commit produces the
  identical deck forever, so nothing rendered ever needs storing.
- **Meaning travels with the slides** — competency tags in the
  markdown become the index that assembles decks across sessions.

- **It needs no infrastructure** — the add-in renders libraries in the
  browser itself (the same Python renderer, via WebAssembly): type
  `owner/repo`, get slides. No server, no hosting, nothing stored.

Versionable markdown is the course; **PowerPoint is just how you look
at it today**.

## How it fits together

```
examples/sessions/*.md          the content (in git — source of truth)
examples/template.pptx          branded layouts: geometry + theme
examples/layout-map.yaml        region name → placeholder index
        │
        ▼  renderer (Python, python-pptx — offline, deterministic)
session-NN.pptx                 editable, placeholder-bound decks
catalog.json                    semantic index: competencies → slides
        │
        ▼  assembler (Office.js task pane inside PowerPoint)
one deck, slides pulled by competency from many sessions
```

The renderer stamps every slide with a deterministic `creationId`, which
is what lets the add-in address individual slides through PowerPoint's
`insertSlidesFromBase64` API. Same input, same bytes, every build.

## Quick start

```bash
# serve the task pane
cd assembler && npm install && npm start

# sideload assembler/manifest.xml into PowerPoint
# (web: Add-ins → Upload My Add-in)
```

Then in the pane, add a library by its repo: `Agrifoodskills/Clinical-Educator-`.
It is fetched from git and rendered **in your browser** — no server holds
content, and no deck is stored anywhere. Browse the course tree or search
the speaker notes, tick slides, insert.

Authoring a library needs the renderer:

```bash
pip install -e "renderer[test]"                # Python >= 3.10
fair-corpus path/to/library --out /tmp/build   # dry-run a build
```

Tests: `cd renderer && python -m pytest tests/` and
`cd assembler && npm test`.

## Repository layout

| Path | What it is |
|---|---|
| `docs/md-to-powerpoint-pipeline.md` | The founding spec: renderer + assembler, acceptance criteria |
| `docs/library-format.md` | The repo shape: course recipe, blocks, resources, media |
| `docs/session-md-format.md` | The authoring format: layouts, lists, colours, emphasis, images |
| `docs/template-profile.md` | The layout contract: bring your own PowerPoint template |
| `docs/platform-architecture.md` | The road ahead: GitHub as identity, middle layer, generation API |
| `renderer/` | Component A — markdown → template-bound `.pptx` (Python) |
| `assembler/` | Component B — PowerPoint task pane add-in (Office.js) |
| `examples/` | Template, layout map, example sessions, and the layout gallery |

## Authoring in one glance

```markdown
--- slide
id: s01-05
layout: Split
title: Reading the log
left:
  type: ul
  color: accent1
  items:
    - "**In range**: no action"
    - text: "**Excursion**: quarantine"
      color: accent2
      items:
        - Record peak and duration
right:
  type: p
  text: Most excursions happen at *handover points*.
develops: [C1]
dok: 2
---
```

Inline `**bold**`/`*italic*`, and colours restricted to theme slots — so
a template rebrand recolours every deck with zero content edits. Full
grammar in [`docs/session-md-format.md`](docs/session-md-format.md).

## The layouts

A slide's `layout:` names a key, not a design. `layout-map.yaml` binds
each key to a layout in *that library's* template, and the renderer only
writes text and images into placeholders — never a colour, size or
position. The look belongs entirely to the template.

**Core** — the nine every stock PowerPoint template already provides,
under Microsoft's own names, so an ordinary template works unedited:

| Key | Stock layout | Regions |
|---|---|---|
| `Title` | Title Slide | `title`, `subtitle` |
| `Full` | Title and Content | `title`, `full` |
| `Section` | Section Header | `title`, `subtitle` |
| `Split` | Two Content | `title`, `left`, `right` |
| `Comparison` | Comparison | `title`, `left_head`, `left`, `right_head`, `right` |
| `Caption` | Content with Caption | `title`, `content`, `caption` |
| `Picture` | Picture with Caption | `title`, `picture`, `caption` |
| `TitleOnly` | Title Only | `title` |
| `Blank` | Blank | — |

**Extended** — optional, and not in stock templates:

| Key | Regions |
|---|---|
| `Cards` | `title`, `head1`–`head4`, `card1`–`card4` — a heading over four colour-tabbed panels |

Any region takes `ul`, `ol`, `p`, `image`, `mermaid` or `video`; a plain
string gives one unadorned paragraph in the layout's own style.

Bind a template and see what it offers:

```bash
fair-template their-template.pptx --out layout-map.yaml   # draft map + conformance report
fair-template their-template.pptx --add-cards out.pptx    # add Cards in their theme colours
```

To see how a template treats all of them, render
[`examples/layout-gallery/gallery.md`](examples/layout-gallery/gallery.md)
against it — one slide per layout, every region filled. The contract is
in [`docs/template-profile.md`](docs/template-profile.md).

## Principles

1. **Git is the source of truth.** The repo is versionable markdown —
   text, graphics, images. Decks, catalogs, and (later) the graph are
   derived, rebuildable artifacts.
2. **The .pptx is never stored or published. Ever.** A user renders
   locally at the moment of use, uses the deck freely, and discards
   it; the same commit regenerates it identically whenever wanted.
3. **Deterministic builds.** The same commit yields byte-identical
   decks — the foundation for credential and observatory provenance.
4. **The template owns appearance.** The renderer never invents
   geometry or colours; content binds into named placeholders.
5. **Selection by meaning.** Slides are chosen by competency, never by
   filename or slide number.
6. **AI drafts, humans commit.** Generated content only ever arrives
   as a pull request (see the platform architecture spec).
