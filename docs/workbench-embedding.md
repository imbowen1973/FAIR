# Embedding the workbench: the wrapper contract

The workbench is designed to be **wrapped** by a portal — a self-hosted
front end (React or anything else) that owns identity, access, status
records and dashboards — without the portal ever forking it. The portal
provides credentials; the workbench provides authoring; a narrow,
versioned message contract joins them. Nobody using a portal ever sees,
pastes or stores an access key.

## The contract

The portal embeds the workbench in an iframe and names **its own
origin** in the URL:

```html
<iframe
  src="https://tools.example.org/workbench/index.html?host=https://portal.example.org"
  allow="clipboard-write"></iframe>
```

That origin is the only one the frame will listen to or address — every
message is origin-checked, both directions.

| Direction | Message | Meaning |
|---|---|---|
| frame → host | `{type:"edufair:ready", version}` | the workbench is loaded and waiting |
| host → frame | `{type:"edufair:auth", token, login?, repo?, companion?}` | credentials; `repo` ("owner/name") opens that library immediately; `companion` opens its private twin beside it (question banks, instructor guides — `companion-repo.md`). Send it only to educators whose token can read it; one that cannot degrades to the course alone |
| host → frame | `edufair:auth` again, any time | **token rotation** — short-lived tokens refresh silently |
| frame → host | `{type:"edufair:opened", repo, branch}` | a library was opened |
| frame → host | `{type:"edufair:dirty", files}` | unsaved-change count changed |
| frame → host | `{type:"edufair:saved", repo, branch, sha}` | a Save committed |
| frame → host | `{type:"edufair:submitted", prUrl, …}` | Submit opened (or found) the review PR |

In host mode the workbench shows no sign-in screen, no PAT field, and no
sign-out button (the portal owns the session), and the token lives only
in the frame's memory — never in web storage, gone with the frame.

The lifecycle events are the portal's **status records for free**:
`submitted` is the authoring-completion event of
`authoring-and-tracking.md` §3, observed at the moment it happens, with
the PR URL as evidence.

## What the portal must do

1. **Mint tokens server-side.** The portal's backend signs users in (SSO
   or GitHub OAuth) and produces a GitHub token scoped to the libraries
   that user may author — ideally a **GitHub App installation token**
   (short-lived, repo-scoped, auto-expiring). The browser only ever
   holds the short-lived token, and only inside the frame.
2. **Answer `ready` with `auth`,** and re-send `auth` before the token
   expires.
3. **Record the lifecycle events** against its assignments/events store.
4. **Serve the workbench bundle** (next section).

## Drop-in updates: how "the latest PR" lands in the portal

The workbench is a dependency, not a fork. It is plain static files with
no build step, so a version is just a folder:

```
portal/static/workbench/
  2026-10-09-17a5732/     ← a bundle: workbench/*.{js,css,html} + py/
  2026-09-28-be61fae/     ← the previous one, kept for rollback
current -> 2026-10-09-17a5732
```

To take the latest: copy `workbench/` and `renderer/src/edufair_renderer/`
(as `py/edufair_renderer/`) from the FAIR repo at the commit you want —
the same layout `publish-pane.yml` assembles — into a new folder, and
point `current` at it. Updating is a folder switch; rolling back is the
same switch the other way. The message contract above is the only
coupling, and it is versioned by the `version` field in `ready`, so a
portal can refuse a bundle that speaks a newer contract than it does.

Because bundles are immutable folders, the portal can also pin different
groups to different versions (pilot users on the PR build, everyone else
on stable) — which is what "drop the latest PR into the tool" means in
practice: copy the PR's bundle in, point the pilot group at it.

## What stays out of the portal

The portal never parses the grammar, never renders, never talks to the
repo on the author's behalf outside the frame, and never stores content —
content is in git, rendering is in the frame (Pyodide), and the portal's
database holds only identity, assignments and events
(`authoring-and-tracking.md` §3.5). If the portal dies, authors fall
back to the standalone workbench with their own tokens; nothing is lost
but convenience.
