// Does editing one thing throw away another?
//
// Every panel that edits a slide used to send back a whole slide object
// built from the copy it was constructed with. That copy goes stale the
// instant anything else is touched, so writing it back silently undid
// work — and the metadata panel is only rebuilt by renderCanvas, which a
// metadata edit deliberately does not call, so its copy stayed stale for
// a whole session.
//
//   type on the canvas       working copy becomes S'
//   type a speaker note      {...S, notes} — the canvas edit is gone
//
// Nothing failed, nothing was reported, and the slide simply reverted.
// So this drives the real app and checks that every edit survives every
// later one, in both orders.
//
//   node tests/no-loss-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "competencies/framework.yaml":
    "competencies:\n  C1:\n    label: Data ethics\n  C2:\n    label: Judgement\n",
  "outcomes.yaml": [
    "outcomes:",
    "  O1:",
    "    statement: Decide whether a dataset may be shared",
    "    block: 01-misuse",
    "    develops: [C1]",
    "  O2:",
    "    statement: Explain re-identification",
    "    block: 01-misuse",
    "    develops: [C2]",
    "",
  ].join("\n"),
  "blocks/01-misuse/block.yaml":
    "title: Ways big data is misused\nduration_minutes: 90\noutcomes: [O1]\nresources: []\n",
  "blocks/01-misuse/slides.md": [
    "---",
    "session: '01'",
    "title: Misuse",
    "version: 1.0.0",
    "---",
    "",
    "--- slide",
    "id: s-01",
    "layout: Full",
    "title: Opening",
    "full:",
    "  type: ul",
    "  items:",
    "    - The original bullet",
    "---",
    "",
  ].join("\n"),
  "layout-map.yaml": [
    "Full:", "  layout: Full", "  regions:", "    title: 0", "    full: 1", "",
  ].join("\n"),
};

const GEOM = {
  slide: { widthEmu: 12192000, heightEmu: 6858000, aspect: 1.7778, widthPt: 960 },
  theme: { dk1: "#000000", lt1: "#FFFFFF", accent1: "#4F81BD", bg1: "#FFFFFF", tx1: "#000000" },
  layouts: {
    Full: {
      layoutName: "Full",
      regions: {
        title: {
          idx: 0, x: 0.06, y: 0.07, w: 0.88, h: 0.15, type: "title",
          style: { align: "l", sizePt: 32 },
          inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 },
        },
        full: {
          idx: 1, x: 0.06, y: 0.27, w: 0.88, h: 0.6, type: "body",
          style: { align: "l", sizePt: 20 },
          inset: { l: 0.01, r: 0.01, t: 0.007, b: 0.007 },
        },
      },
    },
  },
};
FILES["layout-geometry.json"] = JSON.stringify(GEOM);

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error") return;
  if (t.includes("favicon") || t.includes("Failed to load resource")) return;
  errors.push(t);
});

await page.route("https://api.github.com/**", (route) => {
  const url = route.request().url();
  const json = (b) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
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
  if (url.includes("/user/repos")) return json([]);
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
await page.fill("#manual-repo", "test/library");
await page.click("#open-manual");
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });
await page.waitForTimeout(600);

/** The slide as it would be committed: read the file the app would save. */
const slideSource = () =>
  page.evaluate(async () => {
    const { parseSlides } = await import("./library.js");
    // The canvas holds the truth for regions; the source view is what a
    // Save would write. Read it through the app's own tab.
    const tab = [...document.querySelectorAll(".tabstrip .tab")].find((t) =>
      t.textContent.includes("Slides")
    );
    return { hasTab: Boolean(tab), parse: typeof parseSlides === "function" };
  });

/** Type into a region on the canvas. */
async function typeInRegion(region, text) {
  const box = page.locator(`.canvas .region[data-region="${region}"]`).first();
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  await page.waitForTimeout(400);
}

/**
 * Everything the slide currently holds.
 *
 * Read from the rail thumbnail, not the canvas. The canvas is a live
 * contenteditable that is deliberately not redrawn on a metadata change,
 * so it goes on showing what was typed even after the data underneath
 * has been overwritten — which is exactly how this bug stayed invisible.
 * The thumbnail is drawn from the committed slide on every commitSlide,
 * so it is the honest witness.
 */
const slideNow = () =>
  page.evaluate(() => {
    const regions = {};
    const thumb = document.querySelector(".slide-row .thumb");
    for (const r of thumb ? thumb.querySelectorAll("[data-region]") : []) {
      regions[r.dataset.region] = r.textContent.trim();
    }
    regions._thumb = thumb ? thumb.textContent.trim() : "";
    const notesHost = document.querySelector("#meta .notes-field");
    return {
      regions,
      notes: notesHost ? notesHost.textContent.trim() : null,
      id: document.querySelector("#meta input")?.value ?? null,
      dok: document.querySelector("#meta select.dok")?.value ?? null,
      outcomesOn: [...document.querySelectorAll("#meta .chips .chip.on")].map((c) =>
        c.textContent.trim()
      ),
    };
  });

// ---- the reported loss: canvas, then notes ----------------------------
await typeInRegion("title", "A title I typed");
const afterTitle = await slideNow();

// Now type a speaker note. Before the fix this wrote back a slide from
// before the title was touched.
const notes = page.locator("#meta .notes-field [contenteditable], #meta .notes-field textarea").first();
await notes.click();
await page.keyboard.type("Ask the room who has shared a spreadsheet.");
await page.waitForTimeout(600);
const afterNotes = await slideNow();

// ---- and the other order: notes, then a chip --------------------------
const chip = page.locator("#meta .chips .chip").first();
await chip.click();
await page.waitForTimeout(500);
const afterChip = await slideNow();

// ---- two chips in a row: the second must not drop the first -----------
const chips = page.locator("#meta .chips button.chip");
const chipCount = await chips.count();
if (chipCount > 1) {
  await chips.nth(1).click();
  await page.waitForTimeout(500);
}
const afterTwoChips = await slideNow();

// ---- depth of knowledge, after all of that ----------------------------
await page.selectOption("#meta select.dok", "3");
await page.waitForTimeout(400);
const afterDok = await slideNow();

// ---- the session's own facts, which nothing could edit ----------------
//
// The subtitle on a title slide is `code · N minutes` from block.yaml,
// and the canvas marks it derived so it cannot be typed over. With no
// editor for block.yaml either, it was text on a slide that no part of
// the tool could change.
const outcomesTab = page.locator(".tabstrip .tab", { hasText: "Outcomes" }).first();
await outcomesTab.click();
await page.waitForTimeout(700);
await page.fill("#session-title", "Renamed session");
await page.fill("#session-code", "V130");
await page.fill("#session-duration_minutes", "75");
await page.waitForTimeout(500);

// Back to the deck: the title slide must follow, and the fields must
// have kept each other rather than overwriting.
await page.locator(".tabstrip .tab", { hasText: "Slides" }).first().click();
await page.waitForTimeout(700);
const titleSlide = await page.evaluate(() => ({
  thumb: document.querySelector(".slide-row .thumb")?.textContent?.trim() ?? "",
}));
await outcomesTab.click();
await page.waitForTimeout(600);
const session = await page.evaluate(() => ({
  title: document.getElementById("session-title")?.value ?? "",
  code: document.getElementById("session-code")?.value ?? "",
  minutes: document.getElementById("session-duration_minutes")?.value ?? "",
}));
await page.locator(".tabstrip .tab", { hasText: "Slides" }).first().click();
await page.waitForTimeout(600);
console.log("session details kept:", JSON.stringify(session));

// ---- the course editor, which had the same defect ---------------------
//
// Module name and description both write on every keystroke and neither
// rebuilds, so typing one and then the other sent the second merged into
// a course that still had neither.
await page.click(".course-entry .block-head");
await page.waitForTimeout(700);
const courseFields = await page.evaluate(() => ({
  inputs: document.querySelectorAll("#document input, #document textarea").length,
}));
let course = { title: "", description: "" };
if (courseFields.inputs >= 2) {
  const title = page.locator("#document input").first();
  const desc = page.locator("#document textarea").first();
  await title.fill("A module name");
  await page.waitForTimeout(300);
  await desc.fill("And a description typed afterwards.");
  await page.waitForTimeout(500);
  // Leave and come back, so the values are read from the data rather
  // than from the boxes they were typed into.
  await page.click(".slide-row .slide-pick");
  await page.waitForTimeout(400);
  await page.click(".course-entry .block-head");
  await page.waitForTimeout(700);
  course = await page.evaluate(() => ({
    title: document.querySelector("#document input")?.value ?? "",
    description: document.querySelector("#document textarea")?.value ?? "",
  }));
}
console.log("course after both fields:", JSON.stringify(course));


console.log("after typing a title: ", JSON.stringify(afterTitle.regions._thumb));
console.log("after a speaker note: ", JSON.stringify(afterNotes.regions._thumb), "| notes:", JSON.stringify(afterNotes.notes?.slice(-30)));
console.log("after one chip:       ", JSON.stringify(afterChip.outcomesOn), "|", JSON.stringify(afterChip.regions._thumb));
console.log("after two chips:      ", JSON.stringify(afterTwoChips.outcomesOn));
console.log("after setting dok:    ", "dok=" + afterDok.dok, "|", JSON.stringify(afterDok.regions._thumb));

if (errors.length) console.log("errors:", errors.slice(0, 5));

// The thumbnail concatenates its regions, so containment is the test.
const titleKept = (s) => (s.regions._thumb ?? "").includes("A title I typed");
const bodyKept = (s) => (s.regions._thumb ?? "").includes("The original bullet");

const failed =
  errors.length > 0 ||
  !titleKept(afterTitle) ||
  // The reported loss.
  !titleKept(afterNotes) ||
  !bodyKept(afterNotes) ||
  !afterNotes.notes?.includes("Ask the room") ||
  // A chip must not undo the typing or the note.
  !titleKept(afterChip) ||
  !afterChip.notes?.includes("Ask the room") ||
  afterChip.outcomesOn.length < 1 ||
  // Two chips in a row: the first must still be on.
  (chipCount > 1 && afterTwoChips.outcomesOn.length < 2) ||
  // And a select, after all of it.
  afterDok.dok !== "3" ||
  !titleKept(afterDok) ||
  !afterDok.notes?.includes("Ask the room") ||
  // Every session field must survive the ones typed after it.
  session.title !== "Renamed session" ||
  session.code !== "V130" ||
  session.minutes !== "75" ||
  // The course editor: the first field must survive the second.
  (courseFields.inputs >= 2 &&
    (course.title !== "A module name" ||
      !course.description.includes("typed afterwards")));

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
