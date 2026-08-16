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

`title` regions take a plain string. All other regions take a typed object:

- `{ type: ul, items: [...] }` — bulleted list
- `{ type: ol, items: [...] }` — numbered list
- `{ type: image, src: path }` — image, path relative to the session file
- `{ type: mermaid, src: path }` — Mermaid source, rendered to PNG at build
  time (see below)

A list item is either a string or `{ text: str, items: [...] }` for
nesting. Maximum nesting depth is 5 (python-pptx paragraph levels 0–4).

A region contains text or an image, never both (per spec A.2).

### Mermaid resolution

The renderer resolves `{type: mermaid, src: d.mmd}` in this order:

1. A pre-rendered sibling `d.png` (same directory, same stem) — preferred,
   because it keeps builds offline and deterministic. Commit the PNG next
   to the `.mmd` source.
2. `mmdc` (Mermaid CLI) on `PATH`, invoked with a pinned config.

If neither is available the build fails with an explicit error. Mermaid
Ink (network rendering) is deliberately not supported: it would break
offline builds and determinism.

## Determinism note

The same session file, template, and layout map always produce the same
bytes. Slide `creationId`s are derived from `sha256(session:slide-id)`,
not random, and the output ZIP is normalized (fixed entry timestamps).
