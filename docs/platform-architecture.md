# Platform architecture: identity, the middle layer, and content generation

Extends `md-to-powerpoint-pipeline.md`. That spec defined two components
that meet through files on disk. This one defines how the pipeline
becomes a multi-author platform: who may read and write what, where the
service boundary sits, and how AI-assisted authoring joins without
breaking the determinism guarantee.

## 1. The principle that orders everything

GitHub is already the system of record: content is markdown in repos,
history is provenance, and a credential ultimately points at a commit.
The design consequence is that **GitHub is also the identity and
permission system**. The platform never keeps its own user table,
password store, or ACLs. A person's rights in the platform are exactly
their rights on the underlying repos:

- read access to a repo ⇒ its slides appear in your catalog and can be
  assembled
- write access ⇒ you can author: push sessions, receive generated
  drafts as branches
- no access ⇒ the content does not exist for you

One mechanism, already administered by the consortium's org owners,
already audited by GitHub. Revoking a collaborator revokes deck access
with no second system to update.

## 2. Topology

```
Author in PowerPoint task pane / editor
        │  GitHub OAuth (Authorization Code + PKCE, via popup dialog)
        ▼
┌─ FAIR service (the middle layer) ─────────────────────────┐
│  /auth/github     OAuth broker; issues short-lived        │
│                   session token bound to the GitHub token  │
│  /catalog         merged catalog.json across every repo    │
│                   the caller can read                      │
│  /decks/{ref}     artifact proxy: streams session-NN.pptx  │
│                   after re-checking repo permission        │
│  /generate        drafting API (section 5): Claude writes  │
│                   session.md, validates, opens a PR        │
│  /graph (later)   FalkorDB behind slidesForCompetency      │
└───────────────────────────────────────────────────────────┘
        │ GitHub App installation token (server side)
        ▼
GitHub repos ── personal forks and the shared org repo
        │ push triggers Actions
        ▼
CI: fair-render + build_corpus → versioned artifacts
    (decks, catalog.json, slide-id-map.json per commit)
```

The middle layer is deliberately thin. It holds no content: every deck
and every catalog is a CI artifact keyed by commit; the service checks
permission, then streams. If the service dies, the data is all still in
git and rebuildable.

## 3. Why a middle layer at all

The static dev server worked because everything was public-to-you and
local. Three things force a service in between:

1. **Permission-checked delivery.** GitHub artifacts and private repo
   contents need tokens; a task pane cannot safely hold a long-lived
   repo token. The service holds the App installation token server-side
   and re-checks `viewer can read repo X` per request.
2. **Cross-repo aggregation.** The catalog the pane sees is a merge of
   every catalog the caller may read — shared org repo plus any
   personal repos. That merge is per-viewer, so it cannot be a static
   file.
3. **The generation API** needs a server anyway: it holds the Claude
   API key, and it must never run in the client.

Everything else stays out of the service on purpose. Rendering stays in
CI (deterministic, versioned); querying stays in the pane
(`slidesForCompetency`) until the graph arrives; the pane itself is
static files.

## 4. Authoring flows

**Direct (exists today).** Edit session.md in any editor, push, CI
renders, catalog updates. The pane sees the new slides on next load.

**Shared vs personal.** The org repo is the consortium corpus —
protected main branch, PR review required, CODEOWNERS per session
directory if desired. Personal repos let an author develop privately;
their catalog entries appear only in their own view until the content
is PR'd into the shared repo. Same mechanics as any open-source
contribution — deliberately, because that workflow is battle-tested.

### 4.1 The authoring vocabulary: the full git workflow without git language

Authors are educators, not git users. The authoring surface exposes
git's *guarantees* under human verbs; git's *vocabulary* never appears
in the UI. The mapping is fixed here so every future surface (web
editor, task pane, generation API) uses the same words:

| Author sees | Git reality | Notes |
|---|---|---|
| **My drafts** | branches owned by the author | one draft = one branch |
| **Start a session** | create branch + scaffold `session.md` | template-driven scaffold |
| **Save** | commit + push to the draft branch | auto-message; author never writes one |
| **Version history** | `git log` of the file | timestamps + "restore this version" (checkout) |
| **Preview** | CI dry-run render of the draft branch | same renderer, never merged output |
| **Submit for review** | open PR against the shared repo | validation gate runs first |
| **Feedback** | PR review comments | threaded on slides, not diff lines |
| **Update and resubmit** | push to the same branch | PR updates automatically |
| **Publish** | merge the PR | triggers render + library publish |
| **Published library** | main, rendered by CI | what the assembler's picker lists |
| **Get latest** | pull / rebase the draft on main | conflict = "someone edited the same slide" dialog |

Two rules keep this honest. First, the mapping is one-to-one: every UI
verb is exactly one git operation, so the escape hatch always exists —
a git-literate author can work from the command line and the UI users
see the same state. Second, no UI verb ever does what git wouldn't:
"Publish" cannot skip review where the branch protection requires it,
because publish *is* the merge.

## 5. The generation API

`POST /generate` accepts an intent, not markup:

```json
{
  "kind": "session",              // or "slide", "revise"
  "repo": "consortium/curriculum",
  "outcomes": ["Respond to a cold chain excursion"],
  "develops": ["C1", "C3"],
  "duration_minutes": 45,
  "notes": "audience: warehouse leads, prior session 01"
}
```

The service prompts Claude with the session.md grammar, the layout
inventory, and the competency framework; the model drafts complete
session markdown. Then the hard rule:

**Generated content enters the system only as a pull request.**

The service validates the draft (parses under the real parser, layout
and region names checked against layout-map.yaml, `develops` ids
checked against the framework, then a dry-run render must pass), pushes
it to a branch as the *requesting author's* contribution, and opens a
PR. A human merges it or doesn't.

This is how generation coexists with the pipeline spec's rejection of
model calls at build time. The disqualifying pattern was
non-determinism at *render* time — the same commit producing different
decks. Generation at *authoring* time is upstream of the provenance
boundary: the LLM is a drafting hand, the commit is still the fact.
Same markdown in, same deck out, forever, regardless of what wrote the
markdown. Credentials and the observatory keep pointing at commits,
never at prompts.

`kind: "revise"` takes an existing slide id plus an instruction
("tighten to four bullets", "add a comparison with paper records") and
PRs the diff. `kind: "slide"` drafts one slide into an existing
session. All three land as PRs; there is no path where model output
reaches main without review.

## 6. What the task pane changes

Almost nothing — which is the test that the seams were right:

- on load: redirect through `/auth/github` once, then call `/catalog`
  instead of `data/catalog.json`
- on insert: fetch `/decks/{sourcePptx}` with the session token instead
  of `data/...`
- `slidesForCompetency` and the insert mechanics are untouched

## 7. Build order

1. GitHub App + OAuth broker; `/catalog` and `/decks` over the shared
   repo only. CI publishes artifacts per commit (the render pipeline is
   already deterministic, so artifacts are cacheable by commit SHA).
2. Task pane switches to the service endpoints; retire the local data
   directory for anything but offline dev.
3. Multi-repo aggregation (personal repos), permission-filtered.
4. `/generate` kind=session with full validation gate and PR flow.
5. `kind=revise` and `kind=slide`.
6. FalkorDB behind the service; `slidesForCompetency` body swaps to a
   service call (the seam reserved in pipeline spec B.2).

## 8. Risks

1. **OAuth inside Office.** Task panes cannot do a top-level redirect;
   the flow must use `Office.context.ui.displayDialogAsync` with the
   messageParent handoff. Well-trodden but fiddly; budget it, and test
   on PowerPoint web + desktop both, where dialog behavior differs.
2. **Artifact latency.** CI render on push adds minutes between commit
   and availability. Acceptable for curriculum work; if it ever isn't,
   the deterministic renderer makes a pre-merge render cache safe.
3. **Generated-content quality.** The validation gate guarantees the
   draft *renders*; it cannot guarantee it *teaches*. PR review is the
   quality gate, and reviewer load is the real cost — start with
   kind=revise (small diffs) if review capacity is tight.
4. **Token scope discipline.** The service must request the narrowest
   GitHub App permissions (contents:read on selected repos;
   contents:write + pull_requests:write only where generation is
   enabled) and must never forward GitHub tokens to the client.
