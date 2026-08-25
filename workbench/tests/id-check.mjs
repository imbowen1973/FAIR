// Are slide ids permanent?
//
// A slide id is not a position. It is the key of slide-id-map.json, the
// `slideId` the PowerPoint pane ticks, and it is written into the
// provenance and the attribution line of every rendered deck. So a deck
// already in circulation says what `s-03` is, and this side must never
// disagree: an id is allocated once, and never reused or renamed.
//
// The unit tests pin the allocator. This pins the app: the rail's own
// buttons are where ids actually get handed out, and both of the faults
// below were invisible until a real deck was edited.
//
//   node tests/id-check.mjs
//
// Needs the same site-shaped build as create-check.mjs.

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "blocks/01-misuse/block.yaml": "title: Misuse\nduration_minutes: 90\nresources: []\n",
  "blocks/01-misuse/slides.md":
    "---\nsession: '01'\ntitle: Misuse\nversion: 1.0.0\n---\n\n" +
    "--- slide\nid: s-01\nlayout: Full\ntitle: Opening\n---\n",
  "layout-map.yaml":
    "Full:\n  layout: Full\n  regions:\n    title: 0\n    full: 1\n" +
    "Title:\n  layout: Title\n  regions:\n    title: 0\n",
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("dialog", (d) => d.accept());

await page.route("https://api.github.com/**", (route) => {
  const url = route.request().url();
  const json = (b) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.endsWith("/user")) return json({ login: "t" });
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: Object.keys(FILES).map((path) => ({ path, type: "blob" })),
    });
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  return json({});
});
await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(route.request().url().split("/main/")[1] ?? "");
  const body = FILES[path];
  return body === undefined
    ? route.fulfill({ status: 404, body: "" })
    : route.fulfill({ status: 200, contentType: "text/plain", body });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "t/lib");
await page.click("#open-manual");
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });

// Read the id off the row, not the caption: the caption shows the title
// when a slide has one, and would have hidden a duplicate.
const ids = () =>
  page.$$eval(".slide-row", (n) => n.map((x) => x.dataset.slideId));
const addSlide = () => page.click("#add-slide-ribbon");

for (let i = 0; i < 3; i += 1) await addSlide();
await page.waitForTimeout(300);
const grown = await ids();

// Delete the middle slide, then add one. The dead id must not come back:
// every deck already rendered says s-03 is the slide that just went.
await page.click('button[aria-label="delete: slide 3"]');
await page.waitForTimeout(300);
const afterDelete = await ids();
await addSlide();
await page.waitForTimeout(300);
const afterAdd = await ids();

// The opening pair used to derive s-01 and s-02 from a stem, which
// duplicated whatever the deck already had. The renderer refuses a
// duplicate id outright, so this was a deck that could not be built.
await page.click(".deck-actions .add-slide");
await page.waitForTimeout(400);
const withOpening = await ids();
const dupes = withOpening.filter((x, i) => withOpening.indexOf(x) !== i);

console.log("after adding three: ", JSON.stringify(grown));
console.log("after deleting one: ", JSON.stringify(afterDelete));
console.log("after adding again: ", JSON.stringify(afterAdd));
console.log("with opening pair:  ", JSON.stringify(withOpening));
console.log("duplicate ids:      ", JSON.stringify(dupes));

// And the mark reaches the file, so a reopened deck still knows.
// Every row must carry one, or the check above is measuring nothing.
const allNamed = (await ids()).every(Boolean);

if (errors.length) console.log("console errors:", errors.slice(0, 5));

const retired = grown.filter((id) => !afterDelete.includes(id));
const failed =
  errors.length > 0 ||
  grown.length !== 4 ||
  retired.length !== 1 ||
  // The one that went must never reappear.
  afterAdd.includes(retired[0]) ||
  afterAdd.length !== 4 ||
  dupes.length > 0 ||
  withOpening.length !== 6 ||
  !allNamed;

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
