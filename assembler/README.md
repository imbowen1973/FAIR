# fair-assembler (Component B)

Office.js task pane add-in for PowerPoint that assembles one deck from
slides across rendered sessions, selected by competency. Implements
Component B of
[`docs/md-to-powerpoint-pipeline.md`](../docs/md-to-powerpoint-pipeline.md).

## How it works

1. `scripts/build_corpus.py` renders every session in `examples/sessions/`
   and writes `web/data/`: the decks plus `catalog.json` (the aggregated
   index the spec calls "index.json, aggregated across sessions").
2. The pane lists competencies from the catalog. Picking one runs
   `slidesForCompetency(cId)` (`web/assembler.js`) — matching slides
   grouped by source deck.
3. Insert uses one `insertSlidesFromBase64` call per source deck with
   `sourceSlideIds` set to the renderer-emitted `slideId#creationId`
   refs and `formatting: UseDestinationTheme`.

Swapping `slidesForCompetency` for a FalkorDB query later changes only
that function body (spec B.2).

## Published mode (no local server)

`.github/workflows/publish.yml` renders the corpus and deploys this
whole directory to GitHub Pages on every push to main (one-time setup:
repo Settings → Pages → Source: **GitHub Actions**). The Pages site
hosts both the pane and the data, so `manifest.pages.xml` is
sideloadable with nothing running locally.

The pane's **Library** picker can add any other published corpus:
paste `owner/repo` (resolves to that repo's Pages site), a github.com
repo URL, or a direct https catalog URL. Public repos need no auth —
private libraries arrive with the middle layer
(`docs/platform-architecture.md`).

## Run it (local development)

```bash
# 1. Build the data set (from the repo root)
python scripts/build_corpus.py

# 2. Serve the pane
cd assembler
npm install        # once — provides trusted localhost HTTPS certs
npm start          # serves https://localhost:3000

# 3. Unit tests
npm test
```

## Sideload into PowerPoint

- **Windows desktop**: share `\\localhost\...` not needed — use a network
  share or the registry method, or run
  `npx office-addin-debugging start manifest.xml` from `assembler/`.
- **Mac desktop**: copy `manifest.xml` to
  `~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef/`.
- **PowerPoint on the web**: open a deck → Add-ins →
  **Upload My Add-in** → pick `manifest.xml`. Requires the HTTPS server.

Requirement set: **PowerPointApi 1.2** (checked at startup). Supported on
Microsoft 365 desktop (Windows ≥ build 13426, Mac ≥ 16.43) and PowerPoint
on the web; not on iPad.

## Known API constraints

- Within one source deck, PowerPoint inserts slides in their original
  deck order, whatever the order of `sourceSlideIds`.
- `KeepSourceFormatting` has open fidelity bugs (office-js #2780, #4428,
  #5896); the pane uses `UseDestinationTheme`, which is also the spec's
  architectural expectation since all decks share one template.
- Inserting a slide that already exists in the open deck can raise
  `InvalidArgument` (office-js #6105).
