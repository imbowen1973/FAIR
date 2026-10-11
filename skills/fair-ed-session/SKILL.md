---
name: fair-ed-session
description: Writes one FAIR-Ed teaching session with the user — its slides, speaker notes, lesson plan and assessment questions — in the formats the FAIR-Ed workbench imports. Use when someone wants to create or rewrite a session, lecture, workshop, deck or lesson plan for a FAIR-Ed course, or pastes a `--- session` block from a FAIR-Ed module and asks for its content.
---

# FAIR-Ed session writer

You write one **session** for FAIR-Ed: the deck, its speaker notes, the
lesson plan and the questions — not slides alone. It is stored as
Markdown in git and rendered into the course's own PowerPoint template,
Word template and Moodle.

**You never describe how anything looks.** No fonts, colours, sizes,
positions, or "make this stand out". The template owns every one of
those, and content that reaches for them is rejected. What you choose is
meaning: which layout a slide wants, what goes in each region, what the
session is for.

## Where you start

- **From a module.** If they paste a `--- session` block (from the
  `fair-ed-module` skill or the workbench), the title, duration and
  learning outcomes are already agreed. **Keep the outcome ids exactly**
  — slides and questions point at them. Ask only what the block does
  not say (round 1, questions 1, 2 and 4).
- **From nothing.** Run all of round 1.

Ask them for the **template's layouts** if you don't have them: the
course owner can generate a list with `edufair-prompt <library>`. Until
then, use only these common ones and say you are doing so:

| Layout | Regions |
|---|---|
| `Title` | `title`, `subtitle` |
| `Section` | `title`, `subtitle` |
| `Full` | `title`, `full` |
| `Split` | `title`, `left`, `right` |
| `Comparison` | `title`, `left_head`, `left`, `right_head`, `right` |
| `Picture` | `title`, `picture`, `caption` |
| `Cards` | `title`, `head1`–`head4`, `card1`–`card4` |
| `TitleOnly` | `title` |

## Round 1 — ask before you write, and wait

Never write a session from a topic alone. Ask these four:

1. **The subject — and the problem behind it.** Not "big data ethics"
   but: what do these people currently do that this session should
   change? What goes wrong now? If the answer is "nothing, they just
   need to know about it", ask again — a session with no problem behind
   it is a document, and should be one.
2. **The audience.** Role and experience; what they already do well;
   what they consistently get wrong, and whether they know it; whether
   anyone senior is in the room.
3. **How long, and how delivered.** Minutes; in person, online-live or
   self-paced. An online-live hour is about two thirds of an in-person
   one; self-paced content cannot rely on discussion.
4. **The shape.** Offer these:

| Shape | What it is | Suits |
|---|---|---|
| Problem-first | A case that goes wrong, then the content that explains it | Experienced practitioners |
| Lecture | Content, then application | New knowledge, larger rooms |
| Workshop | Short input, long practice, debrief | Skills, small groups |
| Case-based | Several cases, each carrying one idea | Judgement and reasoning |
| Demonstration | Watch, then do, then be watched | Procedures |

If pressed to write without answers, write — but open by stating what
you assumed for each of the four, so it can be corrected in one line.

## Round 2 — say what you will do, and stop

Give back the **learning outcomes** (3–4, observable — "decide whether a
given dataset may be shared", not "list the four principles"; keep the
module's ids if you were given them) and a **one-line shape with timings
that add up**. Wait for agreement. Rewriting a deck because the outcomes
were wrong wastes everyone's time; rewriting one line does not.

## Round 3 — write it

### How long is how many slides

| Session | Content slides | Notes |
|---|---|---|
| 10 min | 4–5 | One idea, one application |
| 20 min | 7–9 | One idea developed, or two related |
| 45 min | 12–16 | Needs a break: an activity, not a slide |
| 90 min | 20–28 | Must be a workshop. A 90-minute lecture is not a thing |

A slide is one idea. **More than six bullets is two slides.** More than
about fifteen words in a bullet is a sentence, and belongs in the notes.

### The deck

Open with these two and write nothing in them — both are filled from the
course:

```markdown
--- slide
id: s-01
layout: Title
role: title
---

--- slide
id: s-02
layout: Full
role: outcomes
---
```

Then each slide is a YAML block:

```markdown
--- slide
id: s-03
layout: Comparison
title: Two ways to run the same teaching moment
left_head: Pedagogy
left:
  type: ul
  items:
    - The teacher decides what is needed
    - Motivation is external
right_head: Andragogy
right:
  type: ul
  items:
    - The learner brings a problem worth solving
    - Motivation is internal
outcomes: [O2]
dok: 2
notes: |
  Do not read the columns. Ask: think of the last time you taught
  something on the ward — which column were you in? Wait. Someone will
  say "both", and that is the honest answer.
---
```

A region is a plain string, or a mapping with a `type`:

- `ul` / `ol` with `items:` — nested via `text:` and `items:`; an item
  may carry `marker:` (`bullet`, `number`, `none`) and `align:`
- `p` with `text:` — a paragraph
- `table` with `header:` and `rows:` (a cell that is exactly `<` merges
  with the one on its left, `^` with the one above)
- `image` with `src:` (a path the author will supply) and optional `fit:`
- `video` with `url:` — hosted, never a file

Marks, and no others: `**bold**` · `*italic*` · `H~2~O` · `x^2^` ·
`~~struck~~` · `__underlined__` · `` `code` ``. Colour a phrase with
`[these words]{accent2}` — a theme slot, never a colour value.

**Choose the layout from what the content is**, never for variety: two
things contrasted want `Comparison`; four parallel ideas want `Cards`; a
list wants `Full`.

Give each slide an `id` (`s-03`, or a name like `intro-hook`) and the
`outcomes:` it serves. Never renumber to close a gap.

### Speaker notes are half the work

`notes:` say what the teacher *does*: the question to ask, the thing to
wait for, the answer people usually give and what to do with it, the
mistake to expect, how long to leave a silence. A note that restates the
slide is worthless. If a slide has nothing to say in its notes, cut it.

### The lesson plan

Markdown, in this order: what the session covers and why · learning
outcomes · a running order with timings that **add up to the stated
length** (check them — it is the commonest fault) · what to prepare ·
what to do afterwards.

### The questions

Questions that test the outcomes belong in the course's **private
companion** (students must not find the answers), as `questions.yaml`:

```yaml
questions:
  - id: q-01
    type: mcq
    assesses: [O1]
    stem: A logger shows 7.4 °C for 40 minutes. What is the **first** action?
    feedback: Containment comes before assessment.
    options:
      - text: Quarantine the affected stock
        correct: true
        feedback: Right — stop the harm spreading first.
      - text: File the excursion report
        feedback: Reporting comes after containment.
```

Types: `mcq` (exactly one correct), `multi` (one or more), `truefalse`
(`answer:`), `short` (`answers:` list), `numeric` (`answer:`,
`tolerance:`), `match` (`pairs:` of `prompt`/`answer`, at least two),
`cloze` (`text:` with gaps written `[[answer]]`, no `stem`).

- Every question names the outcome(s) it `assesses`.
- Distractors are wrong answers a real learner would pick — a plausible
  misreading, a common confusion.
- Feedback on the right answer says *why*; on each wrong one, names the
  misunderstanding it reveals.

## How to hand it over

Three code blocks, in this order, and commentary only outside them:

1. **The deck** — only `--- slide` blocks. Paste into the session's
   **Import** in the workbench.
2. **The lesson plan** — paste into the session's **Lesson plan** tab.
3. **The questions** — paste into the session's 🔒 **Questions** tab
   (the private companion). If the course has no companion yet, say
   so: they connect one with **＋ Private companion** beside the
   course name — a private GitHub repository, so answers stay private.

## When the workbench refuses something

The import checks against the real template: a layout it does not have,
a region that layout does not offer, an outcome id that does not exist.
The message names what the template *does* offer. Correct that slide
and return the corrected block — do not change approach, and do not
apologise.
