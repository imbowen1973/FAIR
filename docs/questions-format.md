# questions.yaml: the companion's question grammar

One file per block in the **companion repo** (`companion-repo.md`):
`blocks/<block-id>/questions.yaml`. The item types are the **portable
subset** — what survives export to Moodle XML today and QTI later, so an
item authored once is never trapped in one platform.

```yaml
questions:
  - id: q-01                  # stable, unique in the file; Moodle
    type: mcq                 #   re-imports match on it (idnumber)
    assesses: [O1]            # outcome ids from the LIBRARY's outcomes.yaml
    points: 1                 # optional, default 1
    stem: A logger shows 7.4 °C for 40 minutes. What is the **first** action?
    feedback: Containment precedes assessment.      # optional, general
    options:
      - text: Quarantine the affected stock
        correct: true
        feedback: Right.                            # optional, per option
      - text: File the excursion report
        feedback: Reporting comes after containment.
```

Inline `**bold**` / `*italic*` work in stems, options and feedback and
export as HTML.

## Types

| `type` | Extra fields | Rules |
|---|---|---|
| `mcq` | `options:` `[{text, correct?, feedback?}]` | exactly one `correct` |
| `multi` | same | ≥1 correct, not all; exports with Moodle's ±fractions |
| `truefalse` | `answer: true\|false` | |
| `short` | `answers: [accepted strings]`, `case: false` | any listed answer scores |
| `numeric` | `answer: 8`, `tolerance: 0.5` | tolerance optional, default 0 |
| `match` | `pairs: [{prompt, answer}]` | at least two pairs |
| `cloze` | `text:` with gaps written `[[answer]]` | no `stem`; gaps compile to Moodle cloze syntax at export — authors never write it |

## The chain, and where checks run

Every item names the **outcomes it assesses** — the question side of
slide → outcome → competency (`outcomes.py`). Cross-validation runs on
the **companion's side only** (it can always read its public twin):

```bash
edufair-moodle-questions path/to/companion --library path/to/library --out bank/
```

fails before writing anything if a bank names a block the library lacks
or assesses an outcome `outcomes.yaml` does not define. The library's
own build enforces the reverse rule: `edufair-corpus` on a public
library **refuses** to build if `questions.yaml` or `instructorguide.md`
is found in it — answers must never be one search away from students.

## Into Moodle

The export writes one deterministic Moodle XML file per block, with a
category per block (`$course$/top/<course>/<block-id>`), `idnumber` for
idempotent re-import, and tags carrying the block and outcome ids.
In Moodle: **Question bank → Import → Moodle XML format**. Quizzes are
then assembled and marked in Moodle; completion flows back as events
evidencing the `assesses:` outcomes (`authoring-and-tracking.md` §3).
