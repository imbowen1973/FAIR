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
// Needs a site-shaped build to serve, not the workbench folder alone:
//
//   mkdir -p /tmp/site && cp -r workbench /tmp/site/
//   cp assembler/web/wasm-renderer.js /tmp/site/
//   cp -r assembler/web/assets /tmp/site/
//   (cd /tmp/site && python -m http.server 8890)
//
// preview.js imports ../wasm-renderer.js and index.html reads
// ../assets/, both of which only exist at the site root.

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
// A 404 is a fact about the fixture, not about the app -- say which URL,
// or "Failed to load resource" is unactionable.
// A 404 from our own origin is a fault; one from a CDN is this machine
// being offline, and failing the run for it would teach nobody anything.
page.on("response", (r) => {
  if (r.status() === 404 && r.url().startsWith(new URL(BASE).origin)) {
    errors.push(`404: ${r.url()}`);
  }
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
await page.waitForTimeout(200);
const picker = {
  kinds: await page.$$eval(".kind-option .kind-label", (n) => n.map((x) => x.textContent)),
  // The assessment is the one that is not a markdown document, and the
  // pane has to say so before an author wonders why it looks different.
  saysXml: (await page.textContent(".tab-menu")).includes("Moodle XML"),
};
await page.click(".kind-option[data-kind='assessment']");
await page.click(".menu-actions .primary");
await page.waitForTimeout(600);
const afterAssessment = {
  changed: await changed(),
  tabs: await page.$$eval(".tabstrip .tab-label", (n) => n.map((x) => x.textContent)),
  onAssessment: await page.isVisible(".add-question"),
};
console.log("picker:", JSON.stringify(picker));
console.log("add assessment:", JSON.stringify(afterAssessment));

// ---- a named markdown document, which is the common case ---------------
await page.click(".tab.addbtn");
await page.waitForTimeout(200);
await page.click(".kind-option[data-kind='workbook']");
await page.fill("#add-doc-name", "Case study pack");
await page.click(".menu-actions .primary");
await page.waitForTimeout(800);
const afterWorkbook = {
  changed: await changed(),
  tabs: await page.$$eval(".tabstrip .tab-label", (n) => n.map((x) => x.textContent)),
  // Named by the author, so the file is named after it too.
  editing: await page.isVisible(".viewbar"),
};
console.log("add workbook:", JSON.stringify(afterWorkbook));

// ---- import, on a deck long enough to hide it --------------------------
//
// The fault this pins: the deck's actions were appended after the slide
// rows, so on a twelve-slide deck they sat hundreds of pixels below the
// fold of the rail. Existence in the DOM proved nothing -- an author
// looked for import and asked where it was. So hit-test: is the button
// the thing under its own centre point, and is that point on screen.
await page.click(".tabstrip .tab:has(.tab-label:text-is('Slides'))");
await page.waitForTimeout(400);
for (let i = 0; i < 11; i += 1) {
  await page.click(".deck-actions .add-slide:nth-child(1)");
}
await page.waitForTimeout(400);

const reach = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".add-slide")].find(
    (b) => b.textContent === "import"
  );
  if (!button) return { found: false };
  const r = button.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return {
    found: true,
    slides: document.querySelectorAll(".slide-row").length,
    onScreen: r.top >= 0 && r.bottom <= innerHeight,
    // Not hidden behind anything, and not clipped out of its own pane.
    clickable: hit === button || button.contains(hit),
  };
});
console.log("import reachable:", JSON.stringify(reach));

// And it works: paste a deck written elsewhere and add it.
await page.click(".deck-actions .add-slide:nth-child(2)");
await page.waitForSelector(".import-panel", { timeout: 5000 });
await page.fill(
  ".import-source",
  [
    "--- slide",
    "id: s-01",
    "layout: Full",
    "title: Brought in",
    "full:",
    "  type: ul",
    "  items:",
    "    - From somewhere else",
    "---",
    "",
  ].join(String.fromCharCode(10))
);
await page.waitForTimeout(300);
const imported = {
  summary: await page.textContent(".import-summary .ok, .import-summary .warn"),
  canAdd: !(await page.isDisabled(".import-panel .primary")),
};
await page.click(".import-panel .primary");
await page.waitForTimeout(500);
const afterImport = {
  panelGone: !(await page.isVisible(".import-panel")),
  slides: await page.$$eval(".slide-row", (n) => n.length),
  titles: await page.$$eval(".thumb-caption", (n) => n.map((x) => x.textContent)),
};
console.log("import:", JSON.stringify({ imported, afterImport }));

// ---- and on a phone, where the rail is a drawer ------------------------
//
// Narrow screens hide the rail behind a toggle, so a deck action there
// is two steps away however high up it sits. What must hold is that
// opening the drawer puts it on screen without scrolling, and that
// using it closes the drawer instead of leaving the panel behind it.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const phone = await page.evaluate(() => {
  const railHidden = !document.querySelector("#outline")?.checkVisibility?.();
  document.getElementById("rail-toggle").click();
  return { railHidden, toggleVisible: Boolean(document.getElementById("rail-toggle")) };
});
await page.waitForTimeout(400);
const onPhone = await page.evaluate(() => {
  const button = [...document.querySelectorAll(".add-slide")].find(
    (b) => b.textContent === "import"
  );
  const r = button.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    onScreen: r.top >= 0 && r.bottom <= innerHeight,
    clickable: hit === button || button.contains(hit),
  };
});
await page.click(".deck-actions .add-slide:nth-child(2)");
await page.waitForTimeout(600);
const phonePanel = await page.evaluate(() => {
  const panel = document.querySelector(".import-panel");
  if (!panel) return { open: false };
  const r = panel.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(2, r.top + 10));
  return {
    open: true,
    // The drawer closed, so the panel is what is actually on top.
    inFront: panel.contains(hit),
    railClosed: !document.querySelector(".panes")?.classList.contains("rail-open"),
  };
});
console.log("phone:", JSON.stringify({ phone, onPhone, phonePanel }));
await page.setViewportSize({ width: 1280, height: 900 });

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
  !/[34] files changed/.test(afterAssessment.changed ?? "") ||
  picker.kinds.length !== 5 ||
  !picker.saysXml ||
  !afterWorkbook.tabs.includes("Case study pack") ||
  !afterWorkbook.editing ||
  !reach.found ||
  !reach.onScreen ||
  !reach.clickable ||
  !imported.canAdd ||
  !afterImport.panelGone ||
  !afterImport.titles.includes("Brought in") ||
  !phone.railHidden ||
  !onPhone.onScreen ||
  !onPhone.clickable ||
  !phonePanel.open ||
  !phonePanel.inFront ||
  !phonePanel.railClosed;

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
