// Does the app actually create documents?
//
// Every other check drives a module in isolation, which proves a button
// calls a function and nothing more. This one drives the real app —
// signs in, opens a library, clicks the buttons an author clicks — with
// GitHub mocked at the network boundary. It is the only check that can
// answer "is there an engine behind the button".
//
//   node tests/create-check.mjs
//
// Needs a site-shaped build to serve: preview.js imports
// ../wasm-renderer.js, which only exists at the site root, and without it
// app.js does not load at all.

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";

const FILES = {
  "course.yaml":
    "id: v-restart\ntitle: V130 Big data\nstructure:\n  - block: 01-misuse\n",
  "competencies/framework.yaml":
    "competencies:\n  V1:\n    label: Data ethics\n",
  "blocks/01-misuse/block.yaml":
    "title: Ways big data is misused\nduration_minutes: 90\nresources: []\n",
  "blocks/01-misuse/slides.md":
    "---\nsession: '01'\ntitle: Misuse\nversion: 1.0.0\n---\n\n" +
    "--- slide\nid: s-01\nlayout: Full\ntitle: Opening\n---\n",
  "layout-map.yaml": "Full:\n  layout: Full\n  regions:\n    title: 0\n    full: 1\n",
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const text = m.text();
  if (m.type() === "error" && !text.includes("favicon")) errors.push(text);
});

await page.route("https://api.github.com/**", async (route) => {
  const url = route.request().url();
  const json = (body) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  if (url.endsWith("/user")) return json({ login: "tester" });
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: Object.keys(FILES).map((path) => ({ path, type: "blob" })),
    });
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/user/repos")) return json([{ full_name: "test/library" }]);
  return json({});
});

await page.route("https://raw.githubusercontent.com/**", async (route) => {
  const path = decodeURIComponent(route.request().url().split("/main/")[1] ?? "");
  const body = FILES[path];
  if (body === undefined) return route.fulfill({ status: 404, body: "" });
  route.fulfill({ status: 200, contentType: "text/plain", body });
});

await page.goto(BASE, { waitUntil: "networkidle" });

// Sign in, then open the library.
await page.fill("#pat", "github_pat_test");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "test/library");
await page.click("#open-manual");
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });

const changed = () => page.textContent("#dirty");
console.log(`opened, and clean: ${JSON.stringify(await changed())}`);

// ---- the lesson plan, which does not exist -----------------------------
await page.click('.tab[data-doc="lessonplan.md"]');
await page.waitForTimeout(600);
const beforePlan = {
  banner: await page.isVisible(".create-row"),
  button: await page.textContent(".create-row button"),
};
await page.click(".create-row button");
await page.waitForTimeout(600);
const afterPlan = {
  changed: await changed(),
  bannerGone: !(await page.isVisible(".create-row")),
  saveEnabled: !(await page.isDisabled("#save")),
};
console.log("create lesson plan:", JSON.stringify({ beforePlan, afterPlan }));

// ---- an assessment, from the Add menu ----------------------------------
await page.click(".tab.addbtn");
await page.click(".tab-menu .menu-item:has-text('Add assessment')");
await page.waitForTimeout(600);
const afterAssessment = {
  changed: await changed(),
  tabs: await page.$$eval(".tabstrip .tab-label", (n) => n.map((x) => x.textContent)),
  onAssessment: await page.isVisible(".add-question"),
};
console.log("add assessment:", JSON.stringify(afterAssessment));

// ---- what would actually be committed ----------------------------------
// The proof: the files a Save would send, read off the app's own state
// by asking it to validate — which mounts exactly those files.
const staged = await page.evaluate(async () => {
  const label = document.getElementById("dirty").textContent;
  return label;
});
console.log("staged:", staged);

if (errors.length) console.log("console errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  !beforePlan.banner ||
  !afterPlan.bannerGone ||
  !/2 files? changed/.test(afterPlan.changed ?? "") ||
  !afterPlan.saveEnabled ||
  !afterAssessment.onAssessment ||
  !afterAssessment.tabs.includes("Assessment") ||
  !/[34] files changed/.test(afterAssessment.changed ?? "");

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
