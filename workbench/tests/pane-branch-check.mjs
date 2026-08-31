// The branch picker: shown when there is a choice, and acted on.
//
// The pane's wiring lives behind Office.onReady and returns early unless
// the host is PowerPoint, so nothing in it had ever been checked outside
// Office — the tree, the twisties, the checkboxes, the search. The Word
// check drives its renderer directly and skips the pane for the same
// reason. So office.js is blocked and a small stub put in its place,
// supplying only what start() reads. Everything after that is the pane's
// own code, unmodified.
//
// Both shapes of catalog are driven, because they take different paths
// through buildTree and only one of them gets exercised by accident:
//
//   no structure   the fallback — credentials, then whatever is left
//                  under "All sessions". The bundled sample is this one.
//   a structure    a course recipe: groups holding blocks holding
//                  slides. Every real library is this one.
//
//   node tests/pane-tree-check.mjs
//
// Needs nothing served: the corpus is fulfilled from the working tree at
// an https URL, because the pane rightly refuses a plain-http one.

import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = process.env.WEB || join(process.cwd(), "..", "assembler", "web");
const PANE = "https://corpus.test/taskpane.html";

const IDS = ["01-intro", "02-profiles", "03-standalone", "04-orphan"];

/** A catalog shaped like a real library: a course recipe with groups. */
const WITH_STRUCTURE = {
  structure: [
    {
      kind: "module",
      title: "Foundations",
      children: [
        { kind: "block", block: "01-intro" },
        { kind: "block", block: "02-profiles" },
      ],
    },
    { kind: "block", block: "03-standalone" },
    {
      kind: "group",
      title: "Not in the running order",
      unplaced: true,
      children: [{ kind: "block", block: "04-orphan" }],
    },
  ],
  blocks: IDS.map((id) => ({ blockId: id, title: id, resources: [] })),
  sessions: IDS.map((id, i) => ({ sessionId: `s${i + 1}`, blockId: id, title: id })),
  slides: IDS.flatMap((id, i) =>
    [1, 2].map((n) => ({
      slideId: `s${i + 1}-${n}`,
      sessionId: `s${i + 1}`,
      title: `${id} slide ${n}`,
      develops: [],
    }))
  ),
  competencies: [],
  credentials: [],
};

const browser = await chromium.launch({ channel: "msedge" });

/**
 * Load the pane against a repo with `branches` branches, and report what
 * the picker did. `catalogByRef` gives each branch its own catalog, so
 * switching can be seen to have switched.
 */
async function run(branches, catalogByRef) {
  const page = await browser.newPage({ viewport: { width: 420, height: 950 } });
  const errors = [];
  const asked = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() !== "error") return;
    if (t.includes("favicon") || t.includes("Failed to load resource")) return;
    errors.push(t);
  });

  await page.route("https://appsforoffice.microsoft.com/**", (route) => route.abort());
  await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());

  // GitHub, as far as the add-in is concerned.
  await page.route("https://api.github.com/**", (route) => {
    const url = route.request().url();
    const json = (b) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/repos\/[^/]+\/[^/]+\/branches/.test(url)) {
      return json(branches.map((b) => ({ name: b.name })));
    }
    if (/\/repos\/[^/]+\/[^/]+\/commits/.test(url)) {
      const ref = decodeURIComponent(url.split("/commits/")[1] ?? "HEAD");
      asked.push(ref);
      const name = ref === "HEAD" ? branches.find((b) => b.isDefault)?.name : ref;
      return route.fulfill({ status: 200, contentType: "text/plain", body: `sha-${name}` });
    }
    if (/\/repos\/[^/]+\/[^/]+\/git\/trees\//.test(url)) {
      return json({ truncated: false, tree: [] });
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return json({ default_branch: branches.find((b) => b.isDefault)?.name ?? branches[0].name });
    }
    return json({});
  });

  const TYPES = { ".json": "application/json", ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  await page.route("https://corpus.test/**", (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname.replace(/^\/+/, "");
    if (path === "data/catalog.json") {
      const ref = u.searchParams.get("ref") || "";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(catalogByRef.default),
      });
    }
    const ext = path.slice(path.lastIndexOf("."));
    try {
      return route.fulfill({
        status: 200,
        contentType: TYPES[ext] ?? "application/octet-stream",
        body: readFileSync(join(WEB, path)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });

  // Every status the pane shows, not just the last one: the render fails
  // here (Pyodide is blocked) and its error overwrites what came before.
  await page.addInitScript(() => {
    window.__statuses = [];
    document.addEventListener("DOMContentLoaded", () => {
      const el = document.getElementById("status");
      if (!el) return;
      new MutationObserver(() => window.__statuses.push(el.textContent.trim()))
        .observe(el, { childList: true, characterData: true, subtree: true });
    });
  });

  await page.addInitScript(() => {
    window.Office = {
      onReady: (fn) => {
        const go = () => fn({ host: "PowerPoint" });
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
        else go();
      },
      HostType: { PowerPoint: "PowerPoint" },
      context: { requirements: { isSetSupported: () => true }, document: {} },
    };
  });

  await page.goto(PANE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  if (await page.evaluate(() => document.getElementById("add-source-row").hidden)) {
    await page.click("#toggle-add");
  }
  await page.fill("#new-source", "tester/lib");
  await page.click("#add-source");
  await page.waitForTimeout(2500);

  const picker = await page.evaluate(() => {
    const row = document.getElementById("branch-row");
    const sel = document.getElementById("branch");
    return {
      shown: row ? !row.hidden : false,
      options: sel ? [...sel.options].map((o) => o.textContent) : [],
      value: sel ? sel.value : null,
    };
  });

  // Choosing the other branch must actually re-read that branch. The
  // render itself needs Pyodide, which is blocked here, so what is
  // observable is the pane saying which branch it is loading.
  let switched = null;
  if (picker.shown) {
    await page.evaluate(() => (window.__statuses.length = 0));
    await page.selectOption("#branch", "draft/imbowen1973");
    await page.waitForTimeout(900);
    switched = await page.evaluate(() => window.__statuses.slice());
  }

  await page.close();
  return { picker, switched, asked, errors };
}

const CATALOG = { structure: [], blocks: [], sessions: [], slides: [], competencies: [], credentials: [] };

const one = await run([{ name: "main", isDefault: true }], { default: CATALOG });
console.log("one branch  ->", JSON.stringify(one.picker));

const two = await run(
  [{ name: "main", isDefault: true }, { name: "draft/imbowen1973", isDefault: false }],
  { default: CATALOG }
);
console.log("two branches->", JSON.stringify(two.picker));
console.log("after switching, the pane said:", JSON.stringify(two.switched));

const failed =
  one.errors.length > 0 ||
  two.errors.length > 0 ||
  // One branch is not a choice.
  one.picker.shown ||
  // Two are, and the published one is named as such and chosen first.
  !two.picker.shown ||
  two.picker.options.length !== 2 ||
  !two.picker.options.some((o) => /main \(published\)/.test(o)) ||
  !two.picker.options.includes("draft/imbowen1973") ||
  two.picker.value !== "main" ||
  // ...and choosing the draft says so, rather than silently rendering
  // the published one again.
  !(two.switched ?? []).some((t) => /draft\/imbowen1973/.test(t));

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
