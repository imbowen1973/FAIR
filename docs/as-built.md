# As-built specification

What exists on this branch, precisely — the implemented counterpart to
`md-to-powerpoint-pipeline.md` (the founding spec) and
`platform-architecture.md` (the road ahead). Where the founding spec and
the implementation differ, this document records the implementation and
flags the divergence.

Component A (renderer) and Component B (assembler) are both built and
passing acceptance: **17 pytest tests** against rendered slide XML and
**5 node tests** against the query logic. All five A.6 criteria from the
founding spec hold, including placeholder binding (criterion 2) and
byte-stable determinism (criterion 5).

## 1. Repository

```
docs/                      specs (this file, founding spec, format, platform)
renderer/                  Component A — Python package `fair-renderer`
  src/fair_renderer/       parser, layoutmap, runs, render, creation_id,
                           mermaid, zipnorm, cli
  tools/make_template.py   generates the stand-in template
  tests/test_acceptance.py 17 tests, one spec criterion per test
assembler/                 Component B — Office.js task pane add-in
  manifest.xml             sideloadable add-in manifest
  web/                     static pane: html/css/js + assembler.js (pure logic)
  server.mjs               dev server (HTTPS via office-addin-dev-certs)
  tests/                   node --test suite
examples/                  template.pptx, layout-map.yaml, 3 sessions
scripts/build_corpus.py    renders all sessions, emits catalog.json
```

Generated artifacts (`assembler/web/data/`, rendered decks, catalogs)
are gitignored: only sources are committed, and every artifact is
rebuildable bit-for-bit from a commit.

## 2. Component A: renderer (as built)

Python ≥ 3.10; dependencies `python-pptx ≥ 1.0`, `PyYAML ≥ 6.0`.
Entry point:

```
fair-render <session.md> --template <t.pptx> --layout-map <map.yaml> --out-dir <dir>
```

### 2.1 Input grammar

Implemented exactly as `session-md-format.md` v1. Enforced by the
parser (all violations are hard errors with file:line):

- YAML frontmatter, required keys `session`, `title`, `version`; all
  other frontmatter passes through to `index.json` untouched
- slide blocks delimited by `--- slide` … `---`; required keys `id`
  (unique per session), `layout`; optional `notes`, `develops` (list),
  `dok` (int); every other key is a region name
- region content: bare string (one plain paragraph) or typed:
  `ul`, `ol`, `p`, `image`, `mermaid`; list items nest to depth 5;
  `title` accepts only a bare string
- inline emphasis `**b**` / `*i*` / `***bi***` in any text
- colour only as theme slots (`accent1–6`, `dk1/lt1/dk2/lt2`,
  `hlink/folHlink`) on regions or items; raw hex rejected

### 2.2 Layout map and validation

`layout-map.yaml` maps layout key → template layout name → region→idx.
Empty region maps are legal (`Blank`). At render start every mapped
layout name and placeholder index is checked against the actual
template; any mismatch aborts the build listing the offending entries.
Duplicate indices within a layout are rejected at load.

### 2.3 Binding (per slide)

1. `prs.slides.add_slide(layout)` — copies layout placeholders,
   preserving master relationships.
2. Each declared region resolves to a placeholder by mapped idx, then:
   - bare string → emphasis-parsed runs in the placeholder's own style
   - `ul`/`ol` → one paragraph per item, `paragraph.level` from
     nesting; `ol` adds `<a:buAutoNum type="arabicPeriod"/>`;
     colour → `<a:solidFill><a:schemeClr/>` on each run (item colour
     overrides region colour)
   - `p` → newline-split paragraphs with `<a:buNone/>`
   - `image` → if the placeholder is PICTURE type,
     `insert_picture()` (keeps `<p:ph>`); otherwise the image is
     contain-fitted and centred in the placeholder's footprint via
     `add_picture()` and the empty placeholder removed — **the one
     documented exception to full placeholder binding** (the picture
     shape carries no `<p:ph>`)
   - `mermaid` → resolves a pre-rendered sibling `.png`/`.svg` first,
     else `mmdc` on PATH, else hard error; then the image path above.
     Network rendering (Mermaid Ink) is unsupported by design.
3. `notes` → the notes slide's text frame.
4. creationId injection (2.4).

### 2.4 creationId (divergence from founding spec, resolved)

The founding spec listed creationId extraction as an open risk.
As built, there is nothing to extract: python-pptx never writes
`p14:creationId`, so the renderer **generates** it —
`sha256("{session}:{slide-id}")`, first 4 bytes masked to
1…0x7FFFFFFF — and injects
`<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}">
<p14:creationId val=…/>` into each slide. Because it is derived, not
random, rebuilds preserve every slide's `sourceRef`.

### 2.5 Determinism

Two renders of the same input are **byte-identical** (tested). The one
mitigation required: python-pptx saves through `zipfile` with
current-time entry stamps, so the renderer rewrites the archive with
fixed timestamps (1980-01-01), fixed compression, original entry
order.

### 2.6 Outputs per session

| File | Contract |
|---|---|
| `session-{NN}.pptx` | template-bound deck |
| `slide-id-map.json` | `{authored id: "slideId#creationId"}` |
| `index.json` | `{"session": <frontmatter verbatim>, "slides": [{slideId, sessionId, sourceRef, sourcePptx, title, develops, dok, notes}]}` |

`title` in the index is emphasis-stripped plain text. `sourceRef` is
the exact string `insertSlidesFromBase64` consumes. `notes` is the
slide's speaker narration verbatim (`null` when absent) — carried so
the pane can search what a slide *says*, not only how it is tagged.

## 3. The template (as built)

`examples/template.pptx` is generated by `tools/make_template.py` from
the python-pptx default template: a stand-in, not the brand. Contract
with the consortium's future template: **same ten layout names, same
placeholder indices**; everything else (theme, geometry, styling) is
the designer's.

| Layout | idx bindings |
|---|---|
| `Title` | 0 title, 1 subtitle |
| `Full` | 0 title, 1 full |
| `Split` | 0 title, 1 left, 2 right |
| `Section` | 0 title, 1 subtitle |
| `Comparison` | 0 title, 1 left_head, 2 left, 3 right_head, 4 right |
| `Caption` | 0 title, 1 content, 2 caption |
| `Picture` | 0 title, 1 picture (PICTURE type), 2 caption |
| `TitleOnly` | 0 title |
| `Blank` | — |
| `Cards` | 0 title, 1–4 head1–4 (tabs), 5–8 card1–4 (bodies) |

Template-carried styling, inherited by every slide:

- master body list levels 1–3 have bullet glyphs coloured
  accent1/2/3
- `Cards` tabs are `round2SameRect` strips filled accent1–4 with
  centred bold light text; bodies sit on `bg2` panels with autofit

## 4. Aggregation: `scripts/build_corpus.py`

Fills the gap the founding spec left between per-session `index.json`
and the assembler. Renders every `examples/sessions/*.md` into
`assembler/web/data/sessions/{id}/` and writes `catalog.json`:

```json
{
  "sessions":     [{"sessionId", "title", "version", "pptx",
                    "durationMinutes", "outcomes"}],
  "competencies": {"C1": "Cold chain monitoring", ...},
  "slides":       [ <all index entries, session order,
                     sourcePptx rewritten data-relative> ],
  "credentials":  [ <credential definitions, passthrough> ]
}
```

### 4.1 Delivery structure (`credentials/*.yaml`)

A credential declares how the course is delivered. Containers nest
outermost-first and every level is optional, so a flat
`modules[].sessions[]` and a fully nested course validate through one
recursive walker (`NESTING` in `corpus.py`):

```yaml
modules:
  - title: Foundations
    days:
      - title: Day 1
        blocks:
          - title: Morning
            sessions: [ce-01]
```

A container holds either `sessions` or the next level down — declaring
both is a hard error, since the intended order would be ambiguous.
Unknown session refs abort the build naming the container; summed
session durations are checked against `workload.contact` and warn on
drift beyond 25%.

Competency labels come from each session's frontmatter
`competencies:` map; conflicting labels across sessions abort the
build; competencies referenced but unlabeled fall back to their id
with a warning.

## 5. Component B: assembler (as built)

Task pane add-in, classic XML manifest, host `Presentation`,
requirement set **PowerPointApi 1.2** (declared in the manifest and
re-checked at runtime with a user-facing message on older builds).
Permissions: `ReadWriteDocument`. Pane URL `https://localhost:3000`.

### 5.1 Query layer (`web/assembler.js`, no Office.js imports)

- `slidesForCompetency(catalog, cId)` → `Map<sourcePptx, entries[]>`
  — the seam reserved for FalkorDB; swapping the body is the whole
  migration
- `groupBySource(slides)` → the same `Map`, so tree selection and
  competency selection converge on one insert path
- `buildTree(catalog)` → `credential > module > day > block > session >
  slide` nodes; absent levels collapse, and sessions no credential
  claims land under a trailing "Unassigned sessions" root so a library
  without `credentials/` still browses
- `searchCatalog(catalog, query)` → ranked hits over slide titles,
  session titles, speaker notes and competency labels, each with a
  ~120-char snippet and the matched field
- `usedCompetencies(catalog)` → labeled ids actually referenced
- `buildInsertPlan(groups, selectedIds)` → per-deck
  `{sourcePptx, sourceRefs[]}`
- `arrayBufferToBase64` — chunked conversion for deck payloads

### 5.2 Pane flow (`web/taskpane.js`)

corpus picker (add / change / remove) → search box and competency
filter → collapsible hierarchy tree with tri-state checkboxes → single
button. Selection is a `Set` of slide ids held independently of what is
displayed, so it survives switching between tree and search results;
switching corpus clears it, because ids from another catalog are
meaningless. Insert runs sequentially per source deck:

```js
context.presentation.insertSlidesFromBase64(base64, {
  formatting: PowerPoint.InsertSlideFormatting.useDestinationTheme,
  sourceSlideIds: step.sourceRefs,
});
await context.sync();
```

Errors surface in the pane's status strip; success reports slides and
deck counts.

### 5.3 Serving

`server.mjs`: static file server plus `POST /api/pull`, port 3000
(`PORT` env). The pull endpoint clones/updates a library repo via
`scripts/pull_library.py` and renders it into `web/libraries/<name>/data`,
which is what lets the pane accept a plain git URL: a browser can
neither clone nor render, and serving the result same-origin also
avoids CORS. Restricted to https on known git hosts and spawned with
array args, never a shell string. HTTPS with
trusted localhost certs when `office-addin-dev-certs` is installed
(`npm install`), plain-HTTP fallback for browser smoke tests only.
Serves pane assets and `web/data/` (decks + catalog). No state, no
auth — superseded by the middle layer in `platform-architecture.md`.

## 6. Verification

```bash
cd renderer && python -m pytest tests/      # 17 passed
cd assembler && npm test                     # 5 passed
python scripts/build_corpus.py               # 3 sessions, 12 slides, 4 competencies
```

Coverage highlights: all five A.6 criteria; creationId present in XML
and consistent with `slide-id-map.json` and `presentation.xml`;
nesting levels; ol numbering; p/buNone; emphasis runs; scheme-colour
runs with item-over-region precedence; Picture placeholder retention;
Cards nine-way binding plus tab geometry/fills; layout-map validation
failure; index.json contract; byte-determinism (two full renders
compared); C1 spanning sessions 01 and 03 in the real catalog.

## 7. Known constraints (accepted, documented)

1. Within one source deck, PowerPoint inserts slides in deck order,
   ignoring `sourceSlideIds` order. Ordering across decks follows the
   pane's sequential calls.
2. `KeepSourceFormatting` has unresolved upstream fidelity bugs
   (office-js #2780/#4428/#5896); the pane uses `UseDestinationTheme`,
   which the shared-template architecture makes near-equivalent.
3. Re-inserting a slide already present can raise `InvalidArgument`
   (office-js #6105).
4. PowerPointApi 1.2 is unavailable on iPad.
5. Images bound to non-PICTURE placeholders lose `<p:ph>` (see 2.3);
   authors wanting fully-bound images use the `Picture` layout.
6. Mermaid requires a committed pre-render or local `mmdc`; builds
   never touch the network.
7. Insertion into PowerPoint itself is exercised manually; automated
   tests stop at the XML/API-contract boundary.
