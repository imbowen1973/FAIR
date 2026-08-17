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
# render the example corpus (Python ≥ 3.10)
pip install -e "renderer[test]"
python scripts/build_corpus.py

# serve the task pane
cd assembler && npm install && npm start

# then sideload assembler/manifest.xml into PowerPoint
# (web: Add-ins → Upload My Add-in), pick a competency, insert.
```

Tests: `cd renderer && python -m pytest tests/` and
`cd assembler && npm test`.

## Repository layout

| Path | What it is |
|---|---|
| `docs/md-to-powerpoint-pipeline.md` | The founding spec: renderer + assembler, acceptance criteria |
| `docs/session-md-format.md` | The authoring format: layouts, lists, colours, emphasis, images |
| `docs/platform-architecture.md` | The road ahead: GitHub as identity, middle layer, generation API |
| `renderer/` | Component A — markdown → template-bound `.pptx` (Python) |
| `assembler/` | Component B — PowerPoint task pane add-in (Office.js) |
| `examples/` | Template, layout map, three example sessions |
| `scripts/build_corpus.py` | Renders all sessions, emits the aggregated `catalog.json` |

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

Ten layouts (`Title`, `Full`, `Split`, `Section`, `Comparison`,
`Caption`, `Picture`, `TitleOnly`, `Blank`, and `Cards` — a heading
over four colour-tabbed cards), inline
`**bold**`/`*italic*`, and colours restricted to theme slots — so a
template rebrand recolours every deck with zero content edits. Full
grammar in [`docs/session-md-format.md`](docs/session-md-format.md).

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
