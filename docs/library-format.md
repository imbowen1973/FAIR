# Library format: the course recipe and its blocks

A library repo is a **course**, not a pile of decks. Slides are one
deliverable among several; a lesson plan, a workbook and a question bank
are content too, and they belong beside the deck they are taught with.

```
course.yaml                     the recipe: identity and delivery structure
competencies/framework.yaml     competency ids and labels
credentials/*.yaml              accreditation claims over the course
template.pptx                   the brand
layout-map.yaml                 region -> placeholder binding
attribution.yaml                funder credit
branding/                       emblems the attribution uses
blocks/
  01-foundations/
    block.yaml                  title, duration, competencies, resources
    lessonplan.md               required: how the session is taught
    slides.md                   the deck — optional, one per block
    workbook.md                 \
    instructorguide.md           >  resources: carried and indexed,
    assessment.xml              /   never parsed
    media/                      images, through the asset policy
    files/                      spreadsheets, PDFs — carried untouched
```

Two properties follow from that shape, and they are the reason for it:

- **The recipe is stable while content churns.** Editing a slide never
  touches `course.yaml`. Adding a block does.
- **A block versions as a unit.** The deck, its lesson plan, its media
  branch and merge together, because they are one folder.

**A block is a session, not a deck.** `lessonplan.md` is required and
`slides.md` is not: plenty of sessions are taught from a plan and a
workbook with no slides at all. `fair-corpus`, the pane and the workbench
all apply that rule, because it comes from `library.check_blocks()`
rather than from any one client.

## `course.yaml` — the recipe

It holds no content. It says what the course is and how it is delivered,
and points at blocks by folder name.

```yaml
id: clinical-educator
title: Clinical Educator
description: Teaching in the clinical environment, for veterinary educators.

structure:
  - kind: module
    title: Foundations of clinical teaching
    children:
      - kind: day
        title: Day 1 — the clinic is not a classroom
        children:
          - block: 01-foundations
          - block: 02-adult-learners
  - kind: module
    title: Assessment and feedback
    children:
      - block: 03-feedback
```

`kind` is the course's own word — `module`, `day`, `week`, `unit`,
whatever it calls its parts. Containers nest to any depth via
`children`. The only fixed thing is the leaf: `block:` names a folder
under `blocks/`.

A block on disk but absent from `structure` is a drafting state, not an
error — it renders and stays findable, filed under "Unplaced blocks". A
`block:` naming a folder that does not exist **is** an error, and fails
the build.

## `block.yaml` — what this part of the course is

```yaml
title: Foundations of clinical teaching
duration_minutes: 180
competencies:
  CE1: Designing clinical teaching sessions
  CE2: Teaching in the clinical environment
resources:
  - type: lessonplan
    title: Facilitator lesson plan
    path: lessonplan.md
  - type: workbook
    title: Learner workbook
    path: workbook.md
  - type: questions
    title: Assessment bank
    path: questions.xml
```

Every field is optional. A block wanting a deck needs `slides.md`; every
block needs `lessonplan.md`. `competencies:` may be a bare list
(`[CE1, CE2]`) when the labels come from the framework file.

The deck is **not** listed in `resources:`. `slides.md` is fixed by
convention and the renderer keys off that name, so declaring it as well
would index it twice in `catalog.json`.

## Resources

Anything that is not the deck. The renderer **copies and indexes them,
never parses them** — it has no opinion about a workbook beyond where it
lives and what it is called. They appear in `catalog.json` under their
block:

```json
"blocks": [
  {
    "blockId": "01-foundations",
    "title": "Foundations of clinical teaching",
    "durationMinutes": 180,
    "pptx": "sessions/01-foundations/session-ce-01.pptx",
    "resources": [
      {"type": "lessonplan", "title": "Facilitator lesson plan",
       "path": "blocks/01-foundations/lessonplan.md"}
    ]
  }
]
```

That is enough for a pane, a portal or an LMS to offer the workbook
beside the slides. The assembler pane lists them as links rather than
checkboxes, because PowerPoint cannot insert a workbook.

A resource declared but missing on disk fails the build — a course that
promises a workbook and does not ship one is worse than one that never
promised it.


### Where a file goes

| Folder | Holds | Treatment |
|---|---|---|
| `media/` | images | resized to 2000 px, re-encoded, **all metadata stripped** |
| `files/` | spreadsheets, PDFs, anything else | carried byte for byte |

The split is not tidiness. Clinical photographs must not carry GPS
coordinates or device identifiers into a public repo, so images go
through the asset policy without exception — and running that policy
over a spreadsheet would corrupt it. One folder holding both would make
it ambiguous which rule applies.

### Assessments

Assessments are **Moodle XML**, authored directly, because that is what
Moodle imports. There is no build step between what an author edits and
what a learner sits.

Competency and depth of knowledge ride in the question's own tags, which
Moodle carries through on import rather than discarding at the border:

```xml
<tags>
  <tag><text>AP1</text></tag>
  <tag><text>dok:2</text></tag>
</tags>
```

The workbench edits questions as a form and writes only the questions
that changed, leaving every other byte identical — including questions
of a type it does not understand, which it shows read-only rather than
risk losing.

## Media

`media/` sits inside the block that uses it, and `slides.md` references
it relatively:

```yaml
full:
  type: image
  src: media/logger-chart.png
```

Co-located on purpose: delete a block and its images go with it, with no
orphans left in a shared bucket.

Image policy is unchanged and still enforced at build time: **≤ 500 KB
and ≤ 2200 px**, EXIF stripped, and **no video files, ever** — video is
hosted and referenced with `{type: video, url: ...}`.

## `credentials/` stays separate

The recipe describes **delivery**; a credential makes an **accreditation
claim** over it — ECTS, workload, assessment, required competencies with
minimum DOK. Keeping them apart means one course can carry several
credentials, and a credential can be revised without touching how the
course is taught.

## Migrating an older library

Libraries used to be a flat `sessions/*.md` with the structure declared
inside the credential, and had nowhere to put anything that was not a
slide. `fair-migrate` converts one:

```bash
fair-migrate path/to/library          # prints the plan, writes nothing
fair-migrate path/to/library --apply
```

It moves each session to `blocks/<id>/slides.md`, writes a `block.yaml`
from the session's frontmatter, rebuilds `course.yaml` from the
credential's module tree so delivery order survives, and moves
referenced media into the block, rewriting the paths.

It takes the course's identity from the credential rather than the
folder name, refuses to run twice, and leaves `sessions/` in place —
delete it once you have checked the build. The flat shape still renders
meanwhile, so nothing is stranded mid-migration.
