// Add a library in one pane; is it there in the other?
//
// Both panes are served from the same origin, so they see the same
// localStorage. That is the whole mechanism — there is no syncing to go
// wrong — but "same origin" is a claim about deployment, and this checks
// it against the pages as they are actually built.
//
// What it cannot check is Office: each host app runs its own WebView2,
// and whether Word and PowerPoint share a storage partition is Office's
// decision. Within one browser context, which is what this drives, the
// sharing is exact.

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8897/";
const browser = await chromium.launch({ channel: "msedge" });
// One context: one origin, one storage partition — the panes' situation
// when Office does share, and the only part we can pin here.
const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
const errors = [];
context.on("weberror", (e) => errors.push(String(e.error().message)));

const ppt = await context.newPage();
await ppt.goto(`${BASE}taskpane.html`, { waitUntil: "domcontentloaded" });

// Add two libraries the way the PowerPoint pane's own code does.
const added = await ppt.evaluate(async () => {
  const { addSource, repoSource, loadSources } = await import("./sources.js");
  addSource(repoSource("Agrifoodskills", "Andragogy-Pedagogy"));
  addSource(repoSource("imbowen1973", "FAIR"));
  // Twice on purpose: the list is a set, not a log.
  addSource(repoSource("imbowen1973", "FAIR"));
  return loadSources().map((s) => s.name);
});
console.log("added in the PowerPoint pane:", JSON.stringify(added));

const word = await context.newPage();
await word.goto(`${BASE}word-taskpane.html`, { waitUntil: "domcontentloaded" });
const seen = await word.evaluate(async () => {
  const { loadSources, repoOf, sourcesAreShared } = await import("./sources.js");
  return {
    shared: sourcesAreShared(),
    names: loadSources().map((s) => s.name),
    repos: loadSources().map(repoOf).filter(Boolean),
  };
});
console.log("seen by the Word pane:  ", JSON.stringify(seen.names));
console.log("storage usable:", seen.shared);

// And back the other way.
await word.evaluate(async () => {
  const { addSource, repoSource } = await import("./sources.js");
  addSource(repoSource("someone", "added-in-word"));
});
await ppt.reload({ waitUntil: "domcontentloaded" });
const back = await ppt.evaluate(async () => {
  const { loadSources } = await import("./sources.js");
  return loadSources().map((s) => s.name);
});
console.log("back in the PowerPoint pane:", JSON.stringify(back));

if (errors.length) console.log("errors:", errors.slice(0, 3));

const failed =
  errors.length > 0 ||
  !seen.shared ||
  added.length !== 2 ||
  JSON.stringify(seen.names) !== JSON.stringify(added) ||
  seen.repos.length !== 2 ||
  seen.repos[0].owner !== "Agrifoodskills" ||
  !back.includes("someone/added-in-word");

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
