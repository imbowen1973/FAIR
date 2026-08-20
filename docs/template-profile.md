# Template profile: bring your own PowerPoint template

A library's decks are bound to *its own* template. This defines what a
template must offer, so that an ordinary PowerPoint file — one a
designer made, with their own masters, colours and fonts — can be
dropped into a library repo and used unedited.

The contract is deliberately small. It is not a FAIR house style; it is
the set of layouts Microsoft ships in every default master, addressed by
their own names.

## Why this works

Every template built on PowerPoint's default masters inherits the same
placeholder numbering:

```
idx 0         title
idx 1–4       content placeholders
idx 10,11,12  date, footer, slide number   <- chrome, never mapped
```

Layout *names* are equally stable in English-language templates. So a
stock template can be bound with no edits at all — verified in
`test_stock_powerpoint_template_conforms_to_the_core_profile`.

Designers do diverge: they rename layouts, reorder placeholders, delete
some and add others. That is what `layout-map.yaml` absorbs, and what
`fair-template` writes for you.

## Core profile — required

A library must provide all nine. Sessions may use any of them.

| Key | Stock layout name | Regions |
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

The two vertical-text layouts PowerPoint also ships are deliberately
not in the profile: they exist everywhere and earn nothing here.

## Extended profile — optional

Custom layouts a template may add. A session using one against a
template that lacks it fails at build time with a named error, which is
the intended behaviour — silence would mean content landing in the
wrong placeholder.

| Key | Regions |
|---|---|
| `Cards` | `title`, `head1`–`head4`, `card1`–`card4` |

### Adding Cards to a template that lacks it

No stock template has `Cards`, and hand-building nine placeholders at
exact indices would defeat the point of the profile. Inject it instead:

```bash
fair-template their-template.pptx --add-cards their-template-cards.pptx
```

The injected layout carries **no colour values**. Its tabs fill from
`accent1`–`accent4`, its panels from `bg2`, its tab text from `lt1` —
theme slots OOXML guarantees every theme defines. The cards therefore
come out in the target template's own palette, and follow it again if
that template is later re-themed.

Geometry is derived from the target's slide size, so it fits a short
widescreen slide as well as a 4:3 one.

The command is idempotent, and matches an existing four-panel layout by
shape as well as by name — a template that already has a quad layout
under some other name is used as-is rather than growing a second one.
Pass `--force` to add one anyway. The source file is never modified: an
output path is required.

## Binding a template

```bash
fair-template their-template.pptx --out layout-map.yaml
```

It writes the map and prints a conformance report:

```
Template conforms to the Core profile.
  ok       Title        -> 'Title Slide'  title=0, subtitle=1
  ok       Split        -> 'Two Content'  title=0, left=1, right=2
  absent   Cards        (extended) — no layout named 'Cards'
```

Exit status is non-zero when a **core** layout is missing or has
unbindable regions. An absent extended layout is reported, not an error.

Commit the generated `layout-map.yaml` next to the template. Regenerate
it whenever the template is re-edited: `validate_against_template` fails
the build if the map and template disagree, so a stale map stops the
build rather than corrupting decks.

## How regions are inferred

From placeholder **type and geometry — never index order**:

- `title` — the `TITLE`/`CENTER_TITLE` placeholder
- `subtitle` — `SUBTITLE`, else the sole content placeholder
- `left` / `right` — the two content placeholders, ordered by their `left`
  coordinate
- `left_head` / `right_head` — within each side, the upper placeholder
- `content` / `caption` — the larger area is the content well
- `picture` — the `PICTURE` placeholder

Index order is used only as a fallback when a layout leaves placeholders
unpositioned (inheriting geometry from the master).

The geometry rule matters: a designer can legitimately ship Two Content
with the right-hand pane at `idx 1`. Binding by index would mirror every
split slide in the corpus and nothing downstream would notice — see
`test_left_and_right_come_from_geometry_not_index_order`.

## Known constraint: pictures outside the Picture layout

`Picture with Caption` is the only stock layout with a real `PICTURE`
placeholder. An image or video poster placed anywhere else is positioned
at the target placeholder's geometry and the empty placeholder removed,
so the resulting shape carries no `<p:ph>` binding.

That is a documented exception, not a defect: it is what allows any
standard template to work. The consequence is that such images do not
move when the template's geometry changes.

Templates that want fully bound imagery must add layouts with real
picture placeholders (`type="pic"`) and declare them in the extended
profile — at the cost of no longer being a stock template.
