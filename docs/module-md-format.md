# A module as one block of Markdown

The whole shape of a module — what it is, the competencies it builds,
how it is grouped, its sessions and their learning outcomes, and who
funds it — written as one Markdown document. Paste it into the
workbench's **Import** on the module page and it becomes the course's
files, after a preview of exactly what will change.

It is what the FAIR-Ed module skill produces after it has interviewed
you (`skills/fair-ed-module/`), and what a person can write by hand. The
contents of each session — its deck, lesson plan and questions — are a
separate step, one session at a time (`skills/fair-ed-session/`).

```markdown
---
title: Clinical Educator
code: CE-01
level: EQF 6
credits: 5 ECTS
hours: 120
programme: Postgraduate Certificate in Veterinary Clinical Education
audience: Veterinary clinicians who supervise students in practice
delivery: blended
language: en
levels: [unit, day]
description: |
  Teaching in the clinical environment, for veterinary educators: how
  to turn the cases already in front of you into teaching that sticks.
---

--- competencies
CE1: Designing clinical teaching sessions
CE2: Teaching in the clinical environment
CE3: Giving feedback that changes practice
---

--- funding
text: Co-funded by the European Union · Clinical Educator, 2023-1-XX01-KA220-VET-000000
logo: branding/eu-cofunded.png
---

## Foundations of clinical teaching

### Day 1 — the clinic is not a classroom

--- session
title: The clinic is not a classroom
duration: 90
outcomes:
  O1:
    statement: Plan a teaching moment around a live case
    develops: [CE1, CE2]
    dok: 3
  O2: Explain why adult learners need a problem before a lecture
summary: |
  Most clinical teaching is improvised. This session gives a frame for
  the five minutes between cases, so teaching is planned, not hoped for.
---

--- session
title: Adult learners in practice
duration: 60
outcomes:
  - Diagnose why a capable student is not progressing
---

## Assessment and feedback

--- session
id: 05-feedback
title: Feedback that changes practice
duration: 90
outcomes:
  O9:
    statement: Give feedback that names one next step
    develops: [CE3]
---
```

## The parts

**Front matter** — the module itself. `title` is required; everything
else is optional and kept in `course.yaml`:

| Key | What it is |
|---|---|
| `title` | The module's name |
| `code` | Its catalogue code |
| `level` | e.g. `EQF 6`, `Level 7`, `undergraduate` |
| `credits` | e.g. `5 ECTS` |
| `hours` | Total learner hours (notional), a number |
| `programme` | The programme it belongs to |
| `audience` | Who it is for |
| `delivery` | `in person`, `online`, `blended` or `self-paced` |
| `language` | e.g. `en` |
| `levels` | What this course calls its groupings, by heading depth: `[unit, day]` makes every `##` a unit and every `###` a day. Leave it out for plain groupings |
| `description` | Two or three sentences |

**`--- competencies`** — the threads that run through the module, as
`id: label`. Merged into `competencies/framework.yaml`: new ids are
added, existing labels updated, nothing removed.

**`--- funding`** — the credit stamped on every slide (`text`, and
optionally `logo` and `corner`), written to `attribution.yaml`.

**Headings** — the groupings. `##` is a top-level grouping, `###` one
inside it, `####` one inside that. The heading text is the grouping's
title. A `#` heading is ignored (it is usually the module's title
again).

**`--- session`** — a session, inside the grouping whose heading comes
before it (or at the top level, before any heading). Its keys:

| Key | What it is |
|---|---|
| `title` | Required |
| `id` | The session's folder name. Leave it out and one is made from the title, numbered in order (`01-the-clinic-is-not-a-classroom`). Give it to update a session that already exists |
| `duration` | Minutes: `90`, `90 min`, or `1.5 h` |
| `outcomes` | What a learner can do afterwards. Either `id: statement`, `id: {statement, develops, dok}`, or a list of statements (ids are then given for you, after the highest already in use) |
| `summary` | Why the session exists — becomes the opening of its lesson plan |

Each outcome may say which competencies it `develops` (ids from the
competencies block, or already in the module) and its `dok` (depth of
knowledge, 1–4). Outcome ids are module-wide, so two sessions cannot
both have an `O1`.

Anything else — a paragraph of commentary, a note from whoever wrote it
— is ignored, and the preview says how much was.

## What importing does

Nothing is written until you have seen the preview and pressed
**Apply**, and nothing reaches GitHub until you press **Save**.

| File | What happens |
|---|---|
| `course.yaml` | The module details are set; the running order **becomes** the one in the import. Sessions already in the course but not in the import stay, outside the running order, and the preview names them |
| `competencies/framework.yaml` | Competencies added or relabelled; none removed |
| `outcomes.yaml` | Outcomes added or updated by id; none removed |
| `attribution.yaml` | The funding credit set |
| `blocks/<id>/block.yaml` | A new session is created; an existing one gets its title, duration and outcomes updated, and keeps everything else |
| `blocks/<id>/lessonplan.md` | Written for a **new** session, opening with its summary and listing its outcomes. An existing lesson plan is never touched |

Decks, workbooks and assessments are never touched by a module import.

## Problems the preview refuses

- no `title` in the front matter
- an outcome that `develops` a competency the module does not define
- the same outcome id twice, or the same session id twice
- a session with no `title`
- YAML that does not parse — with the block and line named
