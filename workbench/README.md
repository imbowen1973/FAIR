# fair-workbench

Author a FAIR library in the browser: open a repo, edit it in a guided
UI, preview the real deck, save to a branch, open a pull request.

Static page, no server. Every repo operation goes browser-direct to
`api.github.com`, which sends `Access-Control-Allow-Origin: *`. The
render runs in the tab via Pyodide — the same `fair_renderer` Python that
runs locally and in CI, so a preview and a build produce identical bytes.

## Run it

```bash
cd assembler && npm start        # serves the pane and the workbench
# then open https://localhost:3000/workbench/
```

Published alongside the pane by `.github/workflows/publish-pane.yml`.

## Signing in

Two providers behind one interface (`auth.js`):

- **A fine-grained token.** Create one with *Contents: read and write* and
  *Pull requests: read and write* on the libraries you author, and paste
  it. Held in `sessionStorage` for the tab only. Works today, no
  infrastructure.
- **OAuth via a broker.** Set `BROKER_URL` and `CLIENT_ID` in
  `config.js`.

The broker is unavoidable for real OAuth: `github.com`'s token endpoint
sends no CORS headers, so a browser cannot complete the exchange however
the flow is started. It is ~30 lines, holds the client secret, and never
sees repository content.

## What it will not do

It is not a virtual PowerPoint. The form is generated from the library's
own `layout-map.yaml`, so the regions are that designer's; it offers no
geometry, no fonts, and colour only as theme slots. Appearance belongs to
the template, and a tool that let an author override it would recreate
exactly what the renderer exists to prevent.

The schematic draws the template's real placeholder rectangles (from
`layout-geometry.json`, emitted by `fair-template --geometry`) and is
styled to look like nothing. It answers *where does this land*.
**Preview deck** answers *what will it look like*, by rendering the
actual file.

Review, comment and merge happen on GitHub. Conflict resolution is out of
scope: three-way merge of region YAML is a project in itself, and GitHub
already does it better.

## Layout

| File | What it is |
|---|---|
| `marks.js` | the inline grammar, mirroring `renderer/runs.py` |
| `library.js` | course.yaml, blocks, slides.md parse and splice |
| `github.js` | REST client: tree, blobs, commits, branches, pulls |
| `auth.js` | token and broker providers |
| `form.js` | the slide form, derived from the layout map |
| `richtext.js` | the mark-aware text field |
| `schematic.js` | placeholder boxes from the geometry file |
| `preview.js` | validation and rendering in Pyodide |
| `app.js` | state, panels, save and submit |

`npm test` covers everything that does not need a DOM — the marks round
trip, and that editing one slide leaves the others byte-identical.
