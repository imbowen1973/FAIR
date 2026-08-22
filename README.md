# eduFAIR — git-native publishing for teaching content

Courses live as markdown in git: versioned, diffable, reviewable,
forkable. Deterministic renderers turn that one source into the native
formats people actually use.

```
                     ┌─ PowerPoint template  →  .pptx
markdown in git  ─────┼─ Word template        →  .docx
                     └─ Moodle XML           →  quiz import
```

Content carries **meaning**, not appearance. A slide says which region
it fills; a document says whether a thing is a heading or a callout; a
question says which outcome it assesses. The template decides what any
of that looks like. Nothing in the markdown can name a font, a colour or
a coordinate — which is why a rendered deck is indistinguishable from a
hand-made one, and why re-branding a whole course is a template swap.

Rendered files are **derived artifacts**. The commit is the fact.

## What is here that is not elsewhere

- **It renders into the designer's template, not around it.** Content
  binds to the named placeholders of a real branded `.pptx`, and to the
  named styles of a real branded `.docx`. Output stays fully editable.
- **Every slide is addressable.** An injected stable identity lets
  PowerPoint's own APIs pull individual slides, turning rendered decks
  into a queryable slide database.
- **Renders are byte-deterministic.** The same commit produces the
  identical file forever, so nothing rendered needs storing.
- **Meaning travels with the content.** A session's learning outcomes
  develop competencies that build across the course; slides and
  questions point at outcomes, and that alignment is checkable.
- **It needs no infrastructure.** Both the authoring tool and the
  PowerPoint add-in run the same Python renderer in your browser, via
  WebAssembly. No server, no hosting, nothing stored.

## Two ways in

### The workbench — author a course in the browser

**<https://imbowen1973.github.io/FAIR/workbench/>**

Nothing to install. Sign in with a GitHub token, open a library repo,
and edit it: slides on a WYSIWYG canvas at the template's own geometry,
lesson plans and workbooks as documents, assessments as a question form.
Save to a branch, submit a pull request. Review and merge happen on
GitHub, where they belong.

### The PowerPoint add-in — assemble decks by meaning

Sideload `assembler/manifest.web.xml` into PowerPoint (Add-ins → Upload
My Add-in). Type a repo, browse the course tree or search the speaker
notes, tick slides, insert. The library is fetched from git and rendered
in your browser.

## Authoring locally

Only needed for CI, scripting, or working offline — the workbench does
all of this without an install.

```bash
pip install -e "renderer[test]"                     # Python >= 3.10

edufair-corpus path/to/library --out /tmp/build     # build everything
edufair-template brand.pptx --out layout-map.yaml   # bind a new deck template
edufair-doctemplate brand.docx --styles style-map.yaml
edufair-doc workbook.md --template brand.docx --out workbook.docx
edufair-prompt path/to/library --out prompt.md      # instructions for a model
```

Tests: `python -m pytest renderer/tests`, and `npm test` in `assembler/`
and `workbench/`.

## The optional server

`assembler/server.mjs` is a **pull-and-render** service, and most people
never need it. The add-in and the workbench read public repositories
directly from git and render in the browser.

Run one only if you need to reach **private repositories** from the
PowerPoint pane, or want to offer the pipeline to people who cannot
install anything at all. It is a flow, not a store: clone, render,
delete. See `docs/deploy-server.md`.

## A library

A course is a repository. `course.yaml` is the recipe and holds no
content; each session is a folder holding everything taught together.

```
course.yaml                 what the course is, and its sessions in order
outcomes.yaml               what it claims to teach
competencies/framework.yaml the threads that build across sessions
template.pptx               the deck's brand
template.docx               the documents' brand
attribution.yaml            the funder credit, burnt into every slide
blocks/
  01-big-data/
    block.yaml              this session: title, duration, its outcomes
    lessonplan.md           required — how the session is taught
    slides.md               the deck
    workbook.md             the learner's pages
    assessment.xml          questions, as Moodle XML
    media/                  images, through the asset policy
```

## Repository layout

| Path | What it is |
|---|---|
| `workbench/` | The authoring SPA — open a repo, edit it, submit a PR |
| `renderer/` | The renderers: markdown → `.pptx`, `.docx`, and the catalog |
| `assembler/` | The PowerPoint task pane add-in (Office.js) |
| `docs/library-format.md` | The repo shape: recipe, sessions, outcomes, resources |
| `docs/session-md-format.md` | The slide format: layouts, regions, marks, roles |
| `docs/word-format.md` | The document format: the style contract |
| `docs/template-profile.md` | Bringing your own PowerPoint template |
| `docs/gpt-prompt.md` | The authoring prompt: what to ask before writing a session |
| `docs/authoring-and-tracking.md` | Outcomes, competencies, and what is recorded |
| `examples/` | A template, a layout map, example sessions, the layout gallery |
