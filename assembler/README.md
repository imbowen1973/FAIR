# fair-assembler (Component B)

Office.js task pane add-in for PowerPoint that assembles one deck from
slides across a course, found by browsing its hierarchy or searching the
speaker notes. Implements
Component B of
[`docs/md-to-powerpoint-pipeline.md`](../docs/md-to-powerpoint-pipeline.md).

## How it works

1. You add a corpus: `owner/repo`. The pane fetches that library's
   markdown from git and renders it, producing the same `catalog.json`
   the renderer emits anywhere else. **There is no built-in corpus** —
   every library is an explicit pick, so the tool never depends on a
   server holding content.
2. `buildTree(catalog)` (`web/assembler.js`) turns the catalog into
   credential → module → day → block → session → slide;
   `searchCatalog` finds slides by title, session, competency label or
   **speaker notes**. Absent levels collapse, and sessions no credential
   claims fall under a trailing root, so a library without
   `credentials/` still browses.
3. Insert uses one `insertSlidesFromBase64` call per source deck with
   `sourceSlideIds` set to the renderer-emitted `slideId#creationId`
   refs and `formatting: UseDestinationTheme`, anchored below the
   selected slide.

Swapping `slidesForCompetency` for a FalkorDB query later changes only
that function body (spec B.2).

## The distribution model

The repo holds markdown; **the .pptx is never stored anywhere**.
Rendering happens at the point of use:

1. **In your browser (serverless — the flagship).** Type `owner/repo`
   into the pane's picker. The pane fetches the markdown straight from
   GitHub and runs the real `fair_renderer` (Python, via Pyodide/
   WebAssembly) inside the pane: git → ppt in one hop, decks existing
   only in the tab's memory. First use downloads the ~10 MB Python
   runtime once; after that it's seconds. Public repos only (a browser
   holds no git credentials); Mermaid diagrams need their pre-rendered
   PNGs committed, which is already the house convention. The pane
   itself is a static app published to GitHub Pages by
   `publish-pane.yml` (tool only — no content, no decks);
   `manifest.web.xml` points there.
2. **A hosted pull server** (`docs/deploy-server.md`, optional). The
   same flow run server-side — the authenticated middle layer for
   private libraries, which a browser cannot reach because it holds no
   git credentials.

Both run the identical renderer package, so a given commit yields the
identical deck either way.

## Run it

```bash
# 1. Serve the pane
cd assembler
npm install        # once — provides trusted localhost HTTPS certs
npm start          # serves https://localhost:3000

# 2. Unit tests
npm test
```

Sideload (below), then add a corpus in the pane: `owner/repo` renders in
your browser. Nothing needs building or installing first.

## Sideload into PowerPoint

- **Windows desktop**: share `\\localhost\...` not needed — use a network
  share or the registry method, or run
  `npx office-addin-debugging start manifest.xml` from `assembler/`.
- **Mac desktop**: copy `manifest.xml` to
  `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/`.
- **PowerPoint on the web**: open a deck → Add-ins →
  **Upload My Add-in** → pick `manifest.xml`. Requires the HTTPS server.

Requirement set: **PowerPointApi 1.2** (checked at startup). Inserting
below the *selected* slide additionally needs **1.5** (`getSelectedSlides`);
where it is missing the pane appends to the end of the deck instead, so
1.2 remains the floor. Supported on
Microsoft 365 desktop (Windows ≥ build 13426, Mac ≥ 16.43) and PowerPoint
on the web; not on iPad.

## Known API constraints

- Within one source deck, PowerPoint inserts slides in their original
  deck order, whatever the order of `sourceSlideIds`.
- `insertSlidesFromBase64` inserts at the **beginning** of the deck when
  `targetSlideId` is omitted — not the end. The pane anchors the first
  batch after the selected slide and then advances the anchor to each
  batch's last inserted slide, so slides land below the selection and
  multi-deck plans keep their order.
- `KeepSourceFormatting` has open fidelity bugs (office-js #2780, #4428,
  #5896); the pane uses `UseDestinationTheme`, which is also the spec's
  architectural expectation since all decks share one template.
- Inserting a slide that already exists in the open deck can raise
  `InvalidArgument` (office-js #6105).
