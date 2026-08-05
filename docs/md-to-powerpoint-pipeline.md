# MD to PowerPoint pipeline: specification

## 0. The dependency that orders everything

Two components: a renderer that turns a session's markdown into an editable, template-bound `.pptx`, and an assembler (Office.js task pane) that pulls slides from many rendered sessions into one deck by meaning. The renderer is foundational. If markdown does not bind into named placeholders, every slide is free-positioned ad hoc, and pulling slides from twelve sessions into one deck produces visual chaos, not a presentation. The graph is then meaningless, because what it points at cannot be assembled coherently. So the renderer's placeholder binding is the make-or-break proof, and it is specified first. The assembler is specified second and depends on the renderer's output contract.

This is exactly the failure observed in MDPR: tested against a Two Content template, its output carried zero placeholder references, every shape was free-positioned, and every slide linked to a blank layout. That output renders fine as a standalone deck and is unusable as an assembly source, because nothing is uniform. Uniform template binding is the property that makes cross-session assembly work.

## 1. Component A: the renderer

### A.1 Stack decision

Use `python-pptx`, not `pptxgenjs`.

Rationale, from what the two projects showed us: `pptxgenjs`, MDPR's engine, binds content only to masters defined in code via `defineSlideMaster`; it cannot populate the placeholders of an imported, designer-authored `.pptx`. The requirement here is the opposite: the consortium owns a branded `.pptx` template with real layouts, and the renderer must fill its placeholders.

`python-pptx` opens an existing `.pptx`, selects a layout, and writes into that layout's placeholders by index. `microsoft/presentations`, `md2pptx`, and Powerpointer are all `python-pptx` based for this reason. The renderer is an offline build tool, so its language is independent of the Office.js assembler; they meet only through files.

### A.2 Inputs

1. `template.pptx`: the branded master, containing four layouts named and used as:
   - `Title`
   - `Full` (title plus one content region)
   - `Split` (title plus left and right regions)
   - `Section`

   The consortium designs this in PowerPoint. The renderer never invents geometry; it inherits it from these layouts.

2. `layout-map.yaml`: the explicit binding contract. `python-pptx` addresses placeholders by index, not by friendly name. This file maps each layout's regions to placeholder indices, so binding is deterministic and readable.

```yaml
Split:
  layout_name: "Split"
  regions:
    title: 0
    left:  1
    right: 2
Full:
  layout_name: "Full"
  regions:
    title: 0
    full:  1
```

3. `session.md`: frontmatter plus slides. Frontmatter carries session id, version, duration, outcomes, and Dublin Core, ELM and ESCO fields defined by the metadata schema. Each slide declares its layout and region contents.

Region content is one of four types:

- `ul`: bulleted list
- `ol`: numbered list
- `image`: path
- `mermaid`: source path or fenced block

A region may contain text or an image, never both.

Illustrative slide source shape, not final syntax:

```markdown
--- slide
id: s01-03
layout: Split
title: Cold chain integrity
left:  { type: ul, items: ["Temperature logging", "Break detection", "Audit trail"] }
right: { type: mermaid, src: diagrams/coldchain.mmd }
notes: |
  Speaker notes here.
---
```

### A.3 Binding mechanism: the core algorithm

For each slide:

1. Resolve the layout. Look up `slide.layout` in `layout-map.yaml`, then obtain the `python-pptx` `slide_layout` by name from `template.pptx`.
2. Add the slide:

   ```python
   slide = prs.slides.add_slide(layout)
   ```

   This copies the layout's placeholders into the slide and preserves master relationships. This is precisely what MDPR skipped.

3. For each region declared on the slide, find the placeholder using the index from `layout-map.yaml`, then fill it according to content type:

   - `ul` / `ol`: write into `placeholder.text_frame`. The first paragraph reuses the existing frame; subsequent items add paragraphs. Set `paragraph.level` for nesting. Text remains native and editable inside the real placeholder.
   - `image`: if the mapped placeholder is a picture placeholder, use `placeholder.insert_picture(path)`. Otherwise, read the placeholder's `left`, `top`, `width`, and `height`, add the picture at that geometry, then remove the empty placeholder. The image occupies the region's exact footprint.
   - `mermaid`: render the source to PNG or SVG first using Mermaid CLI or Mermaid Ink, then treat it as an image. The diagram is a regenerable asset placed at the region geometry; surrounding text remains editable.

4. Speaker notes: write `slide.notes` into the notes slide's notes text frame.

### A.4 Outputs: the contract the assembler depends on

1. `session-NN.pptx`: editable, template-bound deck.
2. `slide-id-map.json`: maps each authored slide id to the PowerPoint internal reference required by the assembler, using the `slideId#creationId` pattern, for example `267#763315295`.

   `python-pptx` exposes the slide id. The `creationId` resides in slide XML, in a `p:cSld` extension, and may require direct XML access. Emitting this map is mandatory because users cannot supply these ids.

3. `index.json`: one entry per slide containing:

   - `slideId`
   - `sessionId`
   - `sourceRef`, the `slideId#creationId`
   - `sourcePptx`
   - `title`
   - `develops`, containing competency ids or ESCO URIs
   - `dok`

   This is the semantic index consumed by both the assembler and the graph.

### A.5 What to reuse from the two projects

#### From MDPR (`ch040602/MdPr`)

Reuse:

- the rule-based, no-LLM, deterministic stance, where the same markdown always yields the same deck, as required for credential and observatory provenance
- the two-stage intermediate representation seam: parse and split, then place
- its coherence rules, specifically rendering list items as separate editable runs to avoid collapsed line breaks
- the `packages/render-pptx` patterns for text runs and tables

Do not reuse:

- free positioning
- its template-as-geometry-hint model

Those are the exact properties to replace with real placeholder binding.

#### From `microsoft/presentations`

Reuse:

- the frontmatter vocabulary as a reference, including title, notes, image-by-reference, and versioned output filename
- its content-as-code framing for the committee

Do not reuse:

- model calls that regenerate visuals during each build through `text_model` or `image_model`, because this is non-deterministic and therefore disqualifying
- explicit coordinate positioning for images rather than placeholder binding, which has the same architectural gap as MDPR

### A.6 Acceptance criteria

Given `template.pptx` with a `Split` layout and a slide declaring `title`, `left`, and `right`, the output slide must:

1. Reference the `Split` layout, not a blank or default layout.
2. Contain three placeholder-bound shapes. Unzip the `.pptx`, inspect the slide XML, and assert that `<p:ph .../>` references are present with the indices from `layout-map.yaml`: `idx 0`, `idx 1`, and `idx 2`. MDPR produced zero; this renderer must produce the mapped set.
3. Contain the left and right content in the correct placeholders, not swapped or merged.
4. Be genuinely editable: text must be present as `<a:t>` runs inside `<p:sp>` shapes, not as rasterised slide images.
5. Be deterministic: two runs of the same input must produce byte-stable slide content, allowing only for legitimately non-deterministic `.pptx` metadata such as timestamps.

If criterion 2 fails, stop. Nothing downstream matters until binding works.

## 2. Component B: the assembler (Office.js task pane)

### B.1 Inputs

The assembler consumes the renderer's three outputs for each session:

- `session-NN.pptx`, fetchable as Base64
- `index.json`, aggregated across sessions
- `slide-id-map.json`

No live rendering happens in the task pane. The assembler only selects and inserts pre-rendered slides.

### B.2 Query

For the spike, load the aggregated `index.json` into memory.

One function:

```ts
slidesForCompetency(cId)
```

It returns entries whose `develops` array includes `cId`, grouped by `sourcePptx` so inserts can be batched per source deck.

Replacing this with a FalkorDB Cypher query later changes only this function body, not the pane or insertion logic. This is where the graph plugs in. The interface remains: competency id in, slide entries out.

### B.3 Insert mechanism

For each source deck containing selected slides:

```ts
context.presentation.insertSlidesFromBase64(base64, {
  formatting: "UseDestinationTheme",
  sourceSlideIds: [sourceRef for each selected slide in this deck]
});
await context.sync();
```

`sourceSlideIds` uses the `slideId#creationId` strings emitted in `slide-id-map.json`.

Microsoft's documentation states that users cannot discover these ids and that the add-in must retrieve them from a data source. That data source is `index.json` and `slide-id-map.json`. The renderer emitting `sourceRef` is what makes this API usable.

### B.4 Task pane flow

1. On load, fetch `index.json` and list distinct competencies with labels.
2. The user selects a competency. Competency-driven selection is the primary path because it proves FAIR reuse by meaning. Cherry-pick browsing is a later addition, not part of the initial proof.
3. Display matching slides across sessions, by title and grouped by session.
4. The user confirms the selection.
5. Assemble the deck using the mechanism in B.3, with one insert call per source deck.
6. Produce one deck containing slides drawn by meaning from multiple sessions. Each slide remains editable and traceable to its source through `index.json`.

### B.5 Why the formatting risk is largely neutralised

Insert-formatting fidelity, specifically `KeepSourceFormatting` versus `UseDestinationTheme`, remains a testable risk. It is substantially reduced because every session is rendered by Component A from the same branded template. All source slides therefore already share one theme, master, and placeholder geometry.

`UseDestinationTheme` and `KeepSourceFormatting` should therefore converge because there is no foreign styling to reconcile. Both flags should still be tested against the corpus, but the architectural reason the risk is low is the shared template.

Uniform template binding at render time is precisely what makes assembly visually coherent at insertion time.

### B.6 Acceptance criteria

1. The output deck contains slides originating from more than one session.
2. Selection is performed by competency, never by filename or slide number.
3. Inserted slides remain editable and are visually consistent with one another, using the same theme.
4. Each inserted slide is traceable to its source session and competency through `index.json`.

## 3. Build order

1. Build the renderer first using a hand-made four-layout template and one session. Pass A.6, especially criterion 2. Do not build the task pane until placeholder binding is proven.
2. Emit `index.json` and `slide-id-map.json` from three sessions, with competencies overlapping across sessions, for example C1 appearing in sessions 1 and 3.
3. Build the minimal assembler task pane: list competencies, select one, and list matching slides.
4. Wire insertion across two source decks.
5. Demonstrate C1 being pulled into one deck from sessions 1 and 3, with the inserted slides remaining editable and theme-consistent.

## 4. Open risks

1. `creationId` extraction from `python-pptx` output may require direct XML access rather than a public API. Verify this early because `sourceSlideIds` depends on it.
2. Multi-level list formatting, including bullet characters and indent levels through `python-pptx` text frames, is likely to be the most fiddly part of A.3 and should be budgeted explicitly.
3. `sourceSlideIds` requires a sufficiently recent PowerPoint API requirement set. Confirm that the consortium's target PowerPoint desktop and web builds support it before treating selective insertion as a dependable production capability.
