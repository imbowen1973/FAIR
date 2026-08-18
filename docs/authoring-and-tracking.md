# Authoring and tracking: the assistant, the workbench, and completion-by-default

Extends `platform-architecture.md`. Three pieces: an AI authoring
assistant (rung 1, zero infrastructure), an authoring SPA (rung 2, the
workbench), and the hosted layer that exists for one reason — recording
assignment and completion in a database as a **side effect of real
work**, never as box-ticking.

Standing principles, restated because everything below hangs off them:

1. **Content lives only in git.** The database stores *events and
   assignments* — who was asked to do what, what happened, when —
   never content. Losing the database loses history of activity, not a
   single slide.
2. **AI drafts, humans commit.** Generated markdown enters through the
   same validation gate and PR review as typed markdown.
3. **The grammar is the guardrail.** Generated or hand-written, a
   session either parses and dry-run renders or it is rejected by
   machine before any human reviews it.
4. **Completion is recorded by default.** The system watches the work
   happen (a PR merges, an assessment is passed) and writes the event
   itself. Nobody ticks anything, in Excel or elsewhere.

## 1. Rung 1: the authoring assistant

A custom GPT / Claude Project, no code. Its knowledge pack is four
files that already exist: `session-md-format.md` (grammar),
the layout inventory (as-built §3), a competency framework file, and
one exemplar session.

**Conversation contract.** The assistant leads with probing questions —
audience and prior knowledge; outcomes; duration; which competencies
from the framework (never invented ones); what evidence of learning —
then drafts, iterates on feedback, and emits complete artifacts:

- `session.md` — frontmatter, slides across the ten layouts, mermaid
  sources for anything diagrammatic, speaker notes, `develops`/`dok`
  per slide
- `assessments/*.yaml` — items in the portable subset, `assesses` tags
  (once Component C lands)
- lesson plan — **not a separate artifact**: it is a view over the
  session (outcomes, timings, notes). The assistant may format one for
  human reading, but the source of truth it must produce is the
  session file; a `fair-lessonplan` renderer later makes this view
  reproducible from any commit.

**Hard rules for the assistant** (in its instructions): only layouts
and regions from the inventory; only competency ids from the
framework; colour only as theme slots; images referenced by
repo-relative path with a one-line description for the author to
fulfil; video as `{type: video, url}` placeholders; never emit
anything outside the grammar.

**Exit path.** The author pastes the output into the workbench (rung
2) or GitHub's web editor. Validation happens there and in CI — the
assistant is generative, never authoritative.

## 2. Rung 2: the workbench (authoring SPA)

A structured editor whose mental model is the grammar, not the canvas.
It is explicitly **not** a virtual PowerPoint: the template owns
appearance, so the workbench never offers geometry, fonts, or pixel
placement — the exact failure the renderer exists to prevent.

### 2.1 Shape

Static SPA, same hosting as the pane (Pages or the middle layer's
static root). No server required for editing and PR flow; the hosted
tracking layer (§3) is additive.

| Panel | Content |
|---|---|
| Left | session outline: reorderable slide cards (layout + title), add-slide with layout picker |
| Center | the selected slide as a **form derived from its layout**: one field group per region, offering that region's legal content types; list editing with keyboard nesting; competency chips (from the framework file) and DOK; notes |
| Right | live **schematic preview**: HTML boxes at the template's true placeholder geometry (extracted to `layout-geometry.json` when the template is generated), content bound into regions, theme colours — approximate on purpose |
| Bottom | validation strip: the real parser, live |

### 2.2 The honest-preview rule

The schematic answers "is the content in the right region, is the
hierarchy right". The *true* preview is the real artifact:
**Preview deck** runs the actual renderer in-browser (Pyodide — same
machinery as the assembler pane) and hands the author the .pptx to
open. The preview an author trusts is always the rendered deck itself,
never a simulation that could drift from it.

### 2.3 Text editing

Tiptap instances inside text fields only, marks restricted to
bold/italic, serializing to `**`/`*`. No other rich-text surface
exists. Authors who prefer raw markdown get a source toggle per slide;
the two views are projections of the same state.

### 2.4 Validation

Continuous, in-browser, against the real code (Pyodide): grammar
errors, unknown regions for the chosen layout, non-framework
competency ids, colour outside theme slots, asset-policy violations on
image insert (`prepare_image` logic runs client-side: resize,
compress, EXIF strip *before* the file ever enters a commit). Submit
is disabled while anything is red — the CI gate re-checks, but authors
should never discover errors there.

### 2.5 Save model — the authoring vocabulary, made literal

GitHub device-flow OAuth from the static app (no server, no secret).
Verbs per `platform-architecture.md` §4.1: **Save** commits to the
author's draft branch; **Submit for review** opens the PR; **History**
lists commits with restore. The workbench holds no state the repo
doesn't — close the tab, lose nothing.

### 2.6 Assistant integration

A "Draft with AI" action fills the same forms (whole session from the
probing questions, or one slide, or a revision of the selected slide).
v1 wires this to rung 1 by paste; when the middle layer exists it
calls `/generate` (platform spec §5) and the result lands as form
state — still reviewed, still committed by the human.

## 3. The hosted layer: assignments and completion-by-default

The reason hosting exists at all. A small service (grows out of the
existing middle layer) with a database of **events, not content**.

### 3.1 What "recorded by default" means

The system derives completion from the work itself:

| Work that happens | Event written, by whom |
|---|---|
| authoring PR merges | `authored(session)` — GitHub webhook, automatic |
| review submitted on a PR | `reviewed(session)` — webhook, automatic |
| credential/module content published | `published(module@commit)` — webhook, automatic |
| learner completes an assigned module (attends, passes assessment) | `completed(module)` — from the assignment surface or assessment result |

Authoring-side tracking therefore needs **zero new behaviour from
authors**: merging the PR *is* the record. Learner-side completion
needs a delivery surface (assignment list; later assessment results
feeding in automatically).

### 3.2 Data model (append-only)

```
assignments: id, assignee, kind(author|review|complete),
             target(library, ref: session/module/credential id),
             assigned_by, due, created_at
events:      id, actor, verb(authored|reviewed|published|completed|assessed),
             object(library@commit + ref), evidence(url/score ref),
             occurred_at, recorded_at
```

Events are **xAPI-alignable** (actor–verb–object) so an LRS or
institutional reporting can consume them later without remodelling.
The `object` always pins `library@commit` — completion claims inherit
git provenance: *what* was completed is exact, forever.

### 3.3 API and surfaces

On the middle layer: `POST/GET /api/assignments`, `POST /api/events`,
`GET /api/progress?assignee=…`, plus the GitHub webhook receiver.
Surfaces: an assignments view in the workbench ("your sessions to
write/review") and a minimal progress dashboard for coordinators —
replacing the Excel sheet, not replicating it.

### 3.4 Identity

Authors and reviewers: GitHub identity (they already have it —
same login as the save flow). Learners: explicitly **out of scope for
v1** — learner identity arrives with the delivery surface, likely
email-based or via institutional SSO, and must not be forced through
GitHub. The event schema already accommodates either (actor is a URI).

### 3.5 What the database is not

Not a content store, not a rendering cache, not an LMS. If it
disappears, every slide, session, credential and commit survives
untouched in git; what's lost is the activity ledger — which is why it
is the one component that gets real backups.

## 4. Build order

1. **Assistant pack** (rung 1): instruction file + knowledge pack;
   usable the same day.
2. **Workbench v1**: outline + layout forms + validation + schematic
   preview + Preview deck (Pyodide) + device-flow Save/Submit. No
   hosted layer needed yet.
3. **Tracking v1**: middle layer + db + GitHub webhooks → authoring
   completion recorded by default; assignments API + workbench
   assignments view.
4. **Learner completion**: assignment surface for modules, assessment
   events (Component C), progress dashboard.
5. **`/generate` in the workbench** once the middle layer holds the
   LLM key.

## 5. Risks

1. **Form-grammar drift.** The workbench forms must be *generated
   from* the layout map + grammar, not hand-maintained per layout, or
   every template change breaks the editor. Budget this abstraction in
   v1.
2. **Device-flow UX.** Fine for staff; clumsy on locked-down machines.
   Fallback: paste-a-PAT field, same storage discipline (memory only).
3. **Completion semantics.** "Merged = authored" is crisp; "completed
   a module" for learners is not (attended? passed? both?). Define per
   credential in `credentials/*.yaml` (e.g. `completion: assessment`)
   so the rule is data, reviewed like everything else.
4. **Two sources of truth temptation.** Pressure will come to store
   "just a bit" of content in the db (draft autosave, comments). Hold
   the line: drafts are branches; comments are PR review threads.
