# Word documents

A session's lesson plan, workbook and teacher resources are markdown in
the repo. This renders them into Word on the same terms the deck renderer
works to:

**eduFAIR defines meaning. Appearance comes from the styles.**

A document says what each thing *is* — a heading, a list, a figure, a
callout — and a *named style* says what that looks like. Nothing in the
markdown may name a font, a colour, a margin or a size, and the block
model has nowhere to put such a thing. That absence is the enforcement:
a rule written down is a rule someone works around.

```
lessonplan.md        ┐
workbook.md          ├─→ .docx
teacher-resources.md ┘
```

## No template is needed

This is the point, so it comes first: **rendering needs no template
file, and nothing has to ship one.**

A `.docx` carries its own `styles.xml`, and Word's built-in styles are
defined against the theme rather than against literal fonts and colours:

```xml
<w:style w:styleId="Heading1">
  <w:rPr>
    <w:rFonts w:asciiTheme="majorHAnsi"/>
    <w:color w:themeColor="accent1" w:themeShade="BF"/>
  </w:rPr>
</w:style>
```

So a document whose paragraphs name `Title`, `Heading 1`, `Quote` and
the rest takes its appearance from whatever theme is in play — the
reader's own Word set-up, their organisation's theme, or one they apply
after the fact. Restyling a rendered document is a theme change, not a
re-render.

```bash
edufair-doc workbook.md --out workbook.docx
```

That is the whole command. There is nothing to install on a server and
nothing to keep in step.

## An optional house style

A template is for a house style that differs from the built-ins — a
funder's brand, a callout style Word does not have. It is an option, not
a requirement:

```bash
edufair-doc workbook.md --template brand.docx --out workbook.docx
```

Any flavour Word saved it as — `.docx`, `.dotx`, `.dotm` — opens the
same way; which one it is is not something an author should have to
think about.

Its body is emptied and everything else kept: styles, numbering,
headers, footers, page setup, theme. **A template is a shape, not a
starting draft** — a cover page left in one would appear in every
document rendered from it.

Two things are kept from the body, because they are structure rather
than draft content: the section properties, and any content controls.

## Styles

Run the inspector to see what a template offers and get a map to bind to:

```bash
edufair-doctemplate brand.docx --styles style-map.yaml
```

```yaml
styles:
  title: Title
  h1: Heading 1
  h2: Heading 2
  h3: Heading 3
  body: Normal
  quote: Quote
  callout: FAIR Callout
  caption: Caption
  code: HTML Preformatted
  bullets: List Bullet
  numbers: List Number
tables:
  default: Table Grid
```

**A template brands a role by naming a style for it.** Define
`FAIR Callout` in Word and callouts use it, with no map to edit at all.
Roles a project has not branded fall back to Word's own, so a plain
template still renders.

A role the template cannot serve is left out rather than pointed at a
style that is not there. Word does not fail on a missing style — it
silently falls back to Normal — so a map naming one produces a document
that looks wrong instead of a build that says why. The inspector's
report names them.

| Markdown | Style role |
|---|---|
| `# …` | `title` |
| `## …` | `h1` |
| `### …` | `h2` |
| paragraph | `body` |
| `- …` | `bullets` |
| `1. …` | `numbers` |
| `> …` | `quote` |
| ` ``` ` | `code`, verbatim |
| `![alt](src)` alone in a paragraph | figure, with `alt` as the `caption` |
| table | `tables.default` |
| between the outcomes markers | `callout` |
| `---` | page break |

Inline marks are the grammar the decks use — `**bold**`, `*italic*`,
`H~2~O`, `x^2^`, `~~struck~~`, `__underlined__`, `` `code` `` — so a
workbook and a slide never disagree about them. `[text](url)` becomes a
real Word hyperlink, not blue text that does nothing when clicked.

## Content controls

For the things that are not body text — a cover page's title, the
project, the funding statement — a template exposes named content
controls and the renderer fills them by tag:

| Tag | Filled from |
|---|---|
| `FAIR.DocumentTitle` | the document's own `# ` heading |
| `FAIR.Project` | `course.yaml` |
| `FAIR.Version` | the commit |
| `FAIR.Author` | passed in |
| `FAIR.FundingStatement` | `attribution.yaml` — the same credit the decks carry |

Controls are found in the body, the headers and the footers, so a
template can put them wherever it wants them. One the template does not
expose is simply not filled: the template decides what to show, and this
decides what it says. A control left empty in the template is filled the
same as one with sample text in it.

Add them in Word: **Developer → Rich Text Content Control**, then
**Properties** and set the *Tag* to one of the names above.

## Rendering

```bash
edufair-doc workbook.md --template brand.docx --styles style-map.yaml \
    --out workbook.docx --funding "Co-funded by the Erasmus+ Programme"
```

## One way

The `.docx` is a deliverable, like the `.pptx`. Git is the source, and
edits to a rendered document are not read back — the next build
overwrites them. Change the markdown.
