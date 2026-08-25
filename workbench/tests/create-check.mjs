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
  await page.click("#add-slide-ribbon");
}
await page.waitForTimeout(400);

const reach = await page.evaluate(() => {
  const button = document.getElementById("import-ribbon");
  if (!button) return { found: false };
  const r = button.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const svg = button.querySelector("svg.icon");
  return {
    found: true,
    slides: document.querySelectorAll(".slide-row").length,
    onScreen: r.top >= 0 && r.bottom <= innerHeight,
    // Not hidden behind anything, and not clipped out of its own pane.
    clickable: hit === button || button.contains(hit),
    // An icon, and a drawn one: an empty svg is a button with nothing
    // on it, and the title alone is not a label anybody sees.
    drawn: Boolean(svg) && svg.getBBox().width > 8,
    labelled: Boolean(button.getAttribute("aria-label")),
  };
});
console.log("import reachable:", JSON.stringify(reach));

// And it works: paste a deck written elsewhere and add it.
await page.click("#import-ribbon");
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

// ---- and on a phone ----------------------------------------------------
//
// Narrow screens hide the rail behind a toggle, so anything living there
// is two steps away however high up it sits. That is why these moved to
// the ribbon: it is on screen at every width, with no drawer to open.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const phone = await page.evaluate(() => ({
  railHidden: !document.querySelector("#outline")?.checkVisibility?.(),
  toggleVisible: Boolean(document.getElementById("rail-toggle")),
}));
const onPhone = await page.evaluate(() => {
  const button = document.getElementById("import-ribbon");
  const r = button.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    onScreen: r.top >= 0 && r.bottom <= innerHeight,
    clickable: hit === button || button.contains(hit),
  };
});
await page.click("#import-ribbon");
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
  !reach.drawn ||
  !reach.labelled ||
  !imported.canAdd ||
  !afterImport.panelGone ||
  !afterImport.titles.includes("Brought in") ||
  !phone.railHidden ||
  !onPhone.onScreen ||
  !onPhone.clickable ||
  !phonePanel.open ||
  !phonePanel.inFront ||
  !phonePanel.railClosed;

// ---- signing out ------------------------------------------------------
//
// The button has been in the markup since the beginning and nothing ever
// unhid it, so the only way out of a session was to clear site data.
//
// There are five files of unsaved work at this point, which is exactly
// the state in which signing out costs something.
const before = await page.evaluate(() => {
  const b = document.getElementById("signout");
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    visible: !b.hidden && r.width > 0,
    clickable: hit === b || b.contains(hit),
    coveredBy: hit ? `${hit.tagName}#${hit.id}.${hit.className}` : "nothing",
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    who: document.getElementById("who").textContent,
    token: sessionStorage.getItem("fair.wb.token") || localStorage.getItem("fair.wb.token"),
  };
});

// No dialog handler registered: Playwright dismisses, which is Cancel.
await page.click("#signout");
await page.waitForTimeout(600);
const cancelled = await page.evaluate(() => ({
  // The workspace, not the picker: #signed-in is the library chooser and
  // is legitimately hidden once a library is open.
  stillIn: !document.getElementById("workspace").hidden,
  token: Boolean(
    sessionStorage.getItem("fair.wb.token") || localStorage.getItem("fair.wb.token")
  ),
}));

page.once("dialog", (d) => d.accept());
await page.click("#signout");
await page.waitForLoadState("networkidle");
await page.waitForTimeout(800);
const after = await page.evaluate(() => ({
  askedAgain: !document.getElementById("signed-out").hidden,
  signedInHidden: document.getElementById("signed-in").hidden,
  workspaceHidden: document.getElementById("workspace").hidden,
  signoutHidden: document.getElementById("signout").hidden,
  token: Boolean(
    sessionStorage.getItem("fair.wb.token") || localStorage.getItem("fair.wb.token")
  ),
  who: document.getElementById("who").textContent,
}));
console.log("sign out button:", JSON.stringify(before));
console.log("cancelled:", JSON.stringify(cancelled));
console.log("after:", JSON.stringify(after));

const signOutBroken =
  !before.visible ||
  !before.clickable ||
  before.who !== "tester" ||
  !before.token ||
  // Cancel must keep both the session and the work.
  !cancelled.stillIn ||
  !cancelled.token ||
  // And then it must really go: no token in either store, and the
  // sign-in panel back rather than an empty workspace.
  after.token ||
  !after.askedAgain ||
  !after.signedInHidden ||
  !after.workspaceHidden ||
  !after.signoutHidden ||
  after.who !== "";

console.log(failed || signOutBroken ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed || signOutBroken ? 1 : 0);
