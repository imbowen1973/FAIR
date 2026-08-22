# Deploying the pull-and-render server (middle layer v0)

One hosted instance of the assembler server lets **anyone with
PowerPoint** use the pipeline — paste a public git URL into the pane's
corpus picker, the server clones the markdown and renders slides at
point of use. No local Python, Node, or git on the user's machine.

The server is a **flow, not a store** — git → render → ppt:

1. `/api/pull` shallow-fetches the repo's tip (content only, no
   history) into a temporary directory
2. the renderer turns it into decks + catalog
3. **the source is deleted before the pull returns** — the server never
   retains a repo
4. the render is served to the pane, then swept after
   `FAIR_RENDER_TTL` (default 1 hour); a restart starts from nothing

Nothing rendered is stored or published; the markdown in git remains
the only stored artifact anywhere. Peak footprint per pull is one
library's content plus its render — tens of MB, for seconds.

This is v0 of the middle layer in `platform-architecture.md`: public
repos only, no login. GitHub identity, private libraries, and the
generation API layer on top of this same endpoint later.

## Run it

```bash
docker build -t fair-server .
docker run -d --restart unless-stopped -p 127.0.0.1:3000:3000 fair-server
```

The container renders the bundled example corpus at start (so the pane
has demo content) and serves on port 3000, plain HTTP.

## TLS (required)

Office add-ins refuse non-HTTPS panes, so put a TLS terminator in
front. Simplest is Caddy, which provisions certificates automatically:

```
fair.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Any equivalent works (nginx + certbot, Traefik, a PaaS with TLS such
as Fly.io/Render — for a PaaS, deploy the Dockerfile and skip the
proxy; the platform's domain already serves HTTPS).

## The manifest

```bash
cd assembler
sed "s/__FAIR_HOST__/fair.example.org/g" \
  manifest.hosted.template.xml > manifest.hosted.xml
```

Users sideload `manifest.hosted.xml` (PowerPoint web: Add-ins → Upload
My Add-in), or an admin deploys it org-wide via the Microsoft 365
admin center (Integrated Apps) so it just appears in everyone's
PowerPoint.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `FAIR_BIND` | `127.0.0.1` (local) | set (e.g. `0.0.0.0`) to enable hosted mode: plain HTTP, bind that address |
| `FAIR_PYTHON` | `<repo>/.venv/bin/python` | python with edufair-renderer installed |
| `FAIR_PULL_TOKEN` | unset | if set, `/api/pull` requires `Authorization: Bearer <token>` — a cheap gate for a semi-private instance |
| `FAIR_PULL_FRESH` | 60 | seconds a pull stays fresh; within the window repeat pulls serve the existing render instead of re-cloning |
| `FAIR_PULL_TIMEOUT` | 180 | seconds before a stuck pull is killed |
| `FAIR_PULL_MAX` | 3 | concurrent pulls; beyond it `/api/pull` answers 429 |
| `FAIR_RENDER_TTL` | 3600 | seconds a render is kept for the pane before being swept |

## What the server will and won't do

- **Will**: clone https repos from github.com / gitlab.com /
  bitbucket.org (allowlist in `server.mjs`), render them with the
  packaged renderer, serve pane + rendered corpus same-origin.
- **Won't**: touch non-allowlisted hosts, run shell strings (git is
  spawned with array args), prompt for credentials
  (`GIT_TERMINAL_PROMPT=0` — private repos fail fast), keep anything
  once the container is gone.

Concurrency is safe per library: simultaneous pulls of the same
library share one clone+render; different libraries run in parallel up
to `FAIR_PULL_MAX`.

## Capacity note

A render of a typical course library takes seconds and the result is
served from disk until the freshness window lapses, so a small VM
(1 vCPU / 1 GB) comfortably serves a consortium. The heavy object —
deck bytes — transfers once per assembly, same-origin.
