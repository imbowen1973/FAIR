// The ribbon's split buttons: a face that repeats the last choice and
// an arrow that opens the rest. What must hold: the menus open and shut
// (Escape, a press elsewhere), choosing from one acts on the selection
// that was there before the menu opened, and the face then repeats it.
//
//   node tests/ribbon-check.mjs   (site-shaped build, as create-check.mjs)

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "blocks/01-misuse/block.yaml": "title: Misuse\nduration_minutes: 90\nresources: []\n",
  "blocks/01-misuse/slides.md": [
    "---", "session: '01'", "title: Misuse", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: Opening",
    "full:", "  type: ul", "  items:",
    "    - Re-identification from anonymised records",
    "    - Bias nobody audits",
    "notes: |", "  Ask the room.", "---", "",
  ].join(String.fromCharCode(10)),
  "layout-map.yaml": [
    "Full:", "  layout: Full", "  regions:",
    "    title: 0", "    full: 1",
    "Comparison:", "  layout: Comparison", "  regions:",
    "    title: 0", "    left: 1", "    right: 2",
    "Title:", "  layout: Title", "  regions:", "    title: 0", "",
  ].join(String.fromCharCode(10)),
  "layout-geometry.json": "{\"slide\": {\"widthEmu\": 12192000, \"heightEmu\": 6858000, \"aspect\": 1.7778, \"widthPt\": 960.0}, \"theme\": {\"dk1\": \"#000000\", \"lt1\": \"#FFFFFF\", \"accent1\": \"#4F81BD\", \"accent2\": \"#C0504D\", \"accent3\": \"#9BBB59\", \"accent4\": \"#8064A2\", \"accent5\": \"#4BACC6\", \"accent6\": \"#F79646\", \"bg1\": \"#FFFFFF\", \"tx1\": \"#000000\"}, \"layouts\": {\"Full\": {\"layoutName\": \"Full\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.06, \"y\": 0.07, \"w\": 0.88, \"h\": 0.15, \"type\": \"title\", \"style\": {\"align\": \"l\", \"sizePt\": 32.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"full\": {\"idx\": 1, \"x\": 0.06, \"y\": 0.27, \"w\": 0.88, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}, \"Comparison\": {\"layoutName\": \"Comparison\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.06, \"y\": 0.07, \"w\": 0.88, \"h\": 0.15, \"type\": \"title\", \"style\": {\"align\": \"l\", \"sizePt\": 32.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"left\": {\"idx\": 1, \"x\": 0.06, \"y\": 0.27, \"w\": 0.42, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"right\": {\"idx\": 2, \"x\": 0.52, \"y\": 0.27, \"w\": 0.42, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}, \"Title\": {\"layoutName\": \"Title\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.075, \"y\": 0.31, \"w\": 0.85, \"h\": 0.21, \"type\": \"center_title\", \"style\": {\"align\": \"l\", \"sizePt\": 44.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}}}",
};

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("response", (r) => {
  if (r.status() === 404 && r.url().startsWith(new URL(BASE).origin)) {
    errors.push(`404: ${r.url()}`);
  }
});

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


const shot = process.env.SHOT;
const ribbon = await page.evaluate(() => ({
  groups: document.querySelectorAll("#ribbon .ribbon-group").length,
  splits: [...document.querySelectorAll("#ribbon .split")].map((s) => s.dataset.split),
  visibleButtons: [...document.querySelectorAll("#ribbon button")].filter((b) => b.offsetParent).length,
}));
console.log("ribbon:", JSON.stringify(ribbon));

// Select one word in the body, then superscript it from the marks menu.
const selectWord = () =>
  page.evaluate(() => {
    const li = document.querySelector('.canvas .region[data-region="full"] li');
    li.closest(".region").focus();
    const text = li.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
await page.click('.canvas .region[data-region="full"]');
await selectWord();
await page.locator('#ribbon .split-arrow[data-for="marks"]').click();
const open = await page.isVisible('#ribbon .split[data-split="marks"] .split-menu');
await page.locator('#ribbon .split[data-split="marks"] .menu-item[data-mark="subscript"]').click();
const applied = await page.evaluate(() => ({
  sub: Boolean(document.querySelector('.canvas .region[data-region="full"] sub')),
  closed: document.querySelector('#ribbon .split[data-split="marks"] .split-menu').hidden,
  face: document.querySelector('#ribbon .split[data-split="marks"] .split-face').textContent,
}));
console.log("subscript via menu:", JSON.stringify({ open, ...applied }));

// Escape and a press elsewhere both close a menu.
await page.locator('#ribbon .split-arrow[data-for="colour"]').click();
const colourOpen = await page.isVisible('#ribbon .split[data-split="colour"] .split-menu');
await page.keyboard.press("Escape");
const escClosed = await page.isHidden('#ribbon .split[data-split="colour"] .split-menu');
await page.locator('#ribbon .split-arrow[data-for="list"]').click();
await page.mouse.click(5, 900);
const elsewhereClosed = await page.isHidden('#ribbon .split[data-split="list"] .split-menu');

// The list face repeats the last choice: pick Numbers for the box.
await page.click('.canvas .region[data-region="full"]');
await page.locator('#ribbon .split-arrow[data-for="list"]').click();
if (shot) await page.screenshot({ path: shot });
await page.locator('#ribbon .mark.list[data-list="ol"]').click();
await page.waitForTimeout(300);
const listed = await page.evaluate(() => ({
  ol: Boolean(document.querySelector('.canvas .region[data-region="full"] ol')),
  face: document.querySelector('#ribbon .split[data-split="list"] .split-face').textContent,
  scope: document.querySelector('#ribbon .split[data-split="list"] .split-face').dataset.scope,
}));
// The face repeats the LAST choice, not the first: after Bullets and then
// Plain lines, pressing the face keeps the box plain.
await page.locator('#ribbon .split-arrow[data-for="list"]').click();
await page.locator('#ribbon .mark.list[data-list="ul"]').click();
await page.locator('#ribbon .split-arrow[data-for="list"]').click();
await page.locator('#ribbon .mark.list[data-list="none"]').click();
await page.waitForTimeout(200);
const plain = await page.evaluate(() => !document.querySelector('.canvas .region[data-region="full"] ul, .canvas .region[data-region="full"] ol'));
await page.click('.canvas .region[data-region="full"]');
await page.locator('#ribbon .split[data-split="list"] .split-face').click();
await page.waitForTimeout(300);
const faceAgain = await page.evaluate(() => Boolean(document.querySelector('.canvas .region[data-region="full"] ol')));
console.log("lists:", JSON.stringify({ listed, plain, faceAgain, colourOpen, escClosed, elsewhereClosed }));

// ---- every width: each menu under its own button, inside the window ---
// The bugs this guards: a menu laid out inside the ribbon, pushing every
// group apart; and one pinned to a fixed side, so the colour menu ran
// off the left edge of a phone and off the right edge of a desktop.
const placements = [];
for (const [width, height] of [[390, 844], [700, 900], [1000, 900], [1500, 950]]) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  for (const name of ["marks", "list", "colour"]) {
    const before = await page.evaluate(() => document.getElementById("ribbon").getBoundingClientRect().height);
    await page.locator(`#ribbon .split-arrow[data-for="${name}"]`).click();
    placements.push(await page.evaluate(([n, h, w]) => {
      const split = document.querySelector(`#ribbon .split[data-split="${n}"]`);
      const menu = split.querySelector(".split-menu");
      const r = menu.getBoundingClientRect();
      const b = split.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return {
        width: w, name: n,
        floats: getComputedStyle(menu).position === "fixed",
        inside: r.left >= 8 - 0.5 && r.right <= vw - 8 + 0.5 && r.width > 0,
        underButton: r.top >= b.bottom - 1 && r.top <= b.bottom + 12,
        ribbonSame: Math.abs(document.getElementById("ribbon").getBoundingClientRect().height - h) < 1,
      };
    }, [name, before, width]));
    if (shot && name === "colour" && width === 390) await page.screenshot({ path: shot.replace(".png", "-phone.png") });
    await page.keyboard.press("Escape");
  }
}
const misplaced = placements.filter((m) => !m.floats || !m.inside || !m.underButton || !m.ribbonSame);
console.log("placements:", placements.length, "misplaced:", JSON.stringify(misplaced));

// Scrolling closes an open menu rather than leaving it floating.
await page.setViewportSize({ width: 390, height: 600 });
await page.locator('#ribbon .split-arrow[data-for="colour"]').click();
await page.mouse.wheel(0, 300);
await page.waitForTimeout(300);
const scrollClosed = await page.isHidden('#ribbon .split[data-split="colour"] .split-menu');
console.log("closes on scroll:", scrollClosed);

if (errors.length) console.log("errors:", errors.slice(0, 5));
const failed =
  errors.length > 0 ||
  JSON.stringify(ribbon.splits) !== JSON.stringify(["marks", "list", "colour"]) ||
  !open || !applied.sub || !applied.closed || applied.face !== "x₂" ||
  !colourOpen || !escClosed || !elsewhereClosed ||
  !listed.ol || listed.face !== "1." || listed.scope !== "box" ||
  !plain ||
  faceAgain ||
  misplaced.length > 0 || !scrollClosed;
console.log(failed ? "FAIL" : "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
