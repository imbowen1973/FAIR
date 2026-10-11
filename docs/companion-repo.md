# The twin repos: public content, private companion

A course ships as **two repositories** with one spine:

- the **library** (public): course recipe, slides, lesson plans,
  workbooks, media — the CC-BY half, forkable by design, renderable by
  anyone. Exactly the library format as it stands.
- the **companion** (private, shareable): question banks, instructor
  guides, marking schemes — the half whose value depends on students
  *not* finding it on Google. GitHub's own access model makes
  "shareable" concrete: grant a partner's team read access and they
  have it; revoke and they don't. No new permission machinery.

The split is by audience, not by topic: if a learner may see it, it
belongs in the library; if only an educator may, in the companion.

## How the twins are joined

One spine: **block ids**. The companion mirrors the library's block
folders and adds only educator files:

```
companion.yaml                  names the twin and the sharing terms
blocks/
  01-foundations/               ← same folder name as the library's
    questions.yaml              the bank: portable item types,
                                `assesses:` outcome ids
    instructorguide.md          how to teach it, answers discussed
    media/                      educator-only media (same asset policy)
```

```yaml
# companion.yaml
library: Agrifoodskills/Clinical-Educator      # the public twin
license: "Shared under consortium agreement — not for redistribution"
```

The library never references the companion (publishing the public half
must not advertise the private one). The companion names the library,
and because the library is public, the companion's CI can always fetch
it — so **all cross-validation runs on the companion's side**: every
companion block must exist in the library; every `assesses:` id must
exist in the library's `outcomes.yaml`. The asymmetry is the security
model: public CI needs nothing private; private CI reads the public.

## Tooling: the companion is an overlay

- **`edufair-corpus <library> --companion <companion>`** merges the
  trees per block. Every companion file becomes a resource of its block
  in `catalog.json`, flagged `audience: educator`, and is copied under
  `educator/` in the output — one folder a publisher leaves out. Each
  block's bank is also exported to Moodle XML beside it
  (`questions.moodle.xml`), and the catalog gains a `companion` entry
  (its library, licence, question and file counts). The cross-checks run
  first and stop the build on any mismatch: a companion block the
  library does not have, or an `assesses:` id its `outcomes.yaml` does
  not define. A companion holding only instructor guides is fine.
  Without `--companion` nothing changes — the public build is
  byte-identical whether a companion exists or not.
- **Workbench.** *＋ Private companion* beside the library picker
  connects it by `owner/repo`. Every session then gains two tabs marked
  🔒 — **Questions** (the bank as a form: a card per question with the
  fields its kind needs, the outcomes it tests as chips, and what it
  still needs said underneath; **Text** shows the YAML) and
  **Instructor guide** (a document) — and
  **Check** runs the same Python cross-checks the companion's CI does.
  Each file is saved to the repo that owns it: **Save** makes one commit
  on the course's draft branch and one on the companion's, and
  **Submit** opens a pull request in each. The workbench refuses a
  companion that is public (the answers would be one search away), one
  whose `companion.yaml` names a different course, and the course
  itself; an empty private repo is set up by writing `companion.yaml`.
  The pairing is remembered in the browser — the library never names
  its companion — and reconnects when the course is reopened. A token
  that can read the course but not the companion opens the course alone
  and says so. Unsaved private edits are kept locally like any other.
- **Portal.** The host's `edufair:auth` message may carry
  `companion: "owner/repo"` beside `repo`; the portal, which knows who
  may read what, sends it only to educators (`workbench-embedding.md`).
- **Provenance**: a credential award pins a *pair* —
  `library@sha + companion@sha` — so "what was taught" and "what was
  assessed" are both exact, while only the first is public.

## Questions: one source, Moodle-mergeable

`questions.yaml` uses the portable item subset (mcq, multi, truefalse,
match, short, numeric, cloze), each item carrying `assesses:` outcome
ids and structured feedback. From it:

- `edufair-moodle-questions <companion> --out bank/` emits **Moodle
  XML**, one category per block, importable into any partner Moodle's
  question bank — quizzes are then assembled inside Moodle with its own
  tools. This merges the assessment into Moodle **without flattening
  the slides**: content stays git-rendered; only the question bank
  crosses, into the system that will deliver and mark it.
- QTI 2.1 export rides the same items later, for non-Moodle platforms.
- The rendered *deck* never includes question content; an assessment
  referenced from a slide stays a pointer.

Completion then closes the loop already specced in
`authoring-and-tracking.md`: Moodle marks the quiz, its completion flows
back as an event evidencing the outcomes the items `assess`.

## Rules that keep the split honest

1. **No answer ever enters the library.** The asset/CI gate on the
   library rejects `questions.yaml`, `instructorguide.md` and an
   `answers` key anywhere — the cheap mistake (committing the bank to
   the public twin) must fail loudly in CI, not be discovered by a
   student.
2. **The companion may reference the library; never the reverse.**
3. **Same grammar, same tools, same asset policy** both sides — the
   companion is ordinary FAIR-Ed content with a smaller audience, not a
   second format.
4. **Shareable means repo access**, nothing else: no tokens in files,
   no encrypted blobs in the public repo.

## Build order

1. Spec `questions.yaml` item schema (the portable subset, feedback,
   `assesses`) — the one new grammar. **Done.**
2. `edufair-moodle-questions`: items → Moodle XML (the "mergeable into
   Moodle" deliverable). **Done.**
3. `--companion` overlay in `edufair-corpus` + companion-side CI
   validation (block ids, outcome refs, the no-answers gate on the
   library). **Done.**
4. Portal/workbench dual-repo opening (rides the host contract — the
   portal already decides which repos a session may reach). **Done.**
