// A slides.md that is already broken must say so.
//
// The writer used to corrupt a list holding a two-word item, so decks
// were saved to branches with a slide that no longer parses. Fixing the
// writer does not unbreak bytes already committed: those files are still
// out there, and opening one has to explain itself.
//
// It used to say the library's layout-geometry.json had "nothing for
// undefined", which is three wrong things at once — the geometry is
// fine, the template is fine, and there is no layout because there is no
// slide. Authors went and read the template documentation twice.
//
// parseSlides has always recorded exactly what YAML objected to and on
// which line. workingSlides threw it away.
//
//   node tests/unreadable-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

// Exactly what the old writer produced: a flow sequence with the rest of
// the list left dangling underneath it.
const CORRUPT = [
  "---",
  "session: '01'",
  "title: Profiles",
  "version: 1.0.0",
  "---",
  "",
  "--- slide",
  "id: profile-climate-regenerative-agriculture",
  "layout: Cards",
  "title: Climate-Resilient & Regenerative Agriculture Specialist",
  "card4:",
  "  type: ul",
  "  items: [SAFFT4EU]",
  "    - REGE FARMS",
  "    - FARMS 5.0",
  "---",
  "",
  "--- slide",
  "id: profile-precision-crop-irrigation",
  "layout: Cards",
  "title: Precision Crop & Irrigation Specialist",
  "card1: InnoCSA",
  "---",
  "",
].join(String.fromCharCode(10));

const FILES = {
  "course.yaml": "id: p\ntitle: Profiles\nstructure:\n  - block: 01-profiles\n",
  "competencies/framework.yaml": "competencies:\n  C1:\n    label: Practice\n",
  "outcomes.yaml":
    "outcomes:\n  O1:\n    statement: Name them\n    block: 01-profiles\n    develops: [C1]\n",
  "blocks/01-profiles/block.yaml": "title: Profiles\nresources: []\n",
  "blocks/01-profiles/slides.md": CORRUPT,
};

FILES["layout-geometry.json"] = JSON.stringify({"slide": {"widthEmu": 9144000, "heightEmu": 6858000, "aspect": 1.33333, "widthPt": 720.0}, "theme": {"dk1": "#000000", "lt1": "#FFFFFF", "dk2": "#1F497D", "lt2": "#EEECE1", "accent1": "#4F81BD", "accent2": "#C0504D", "accent3": "#9BBB59", "accent4": "#8064A2", "accent5": "#4BACC6", "accent6": "#F79646", "hlink": "#0000FF", "folHlink": "#800080", "bg1": "#FFFFFF", "tx1": "#000000", "bg2": "#EEECE1", "tx2": "#1F497D"}, "layouts": {"Cards": {"layoutName": "Cards", "regions": {"title": {"idx": 0, "x": 0.05, "y": 0.04005, "w": 0.9, "h": 0.16667, "type": "title", "style": {"align": "ctr", "sizePt": 44.0}, "inset": {"l": 0.01, "r": 0.01, "t": 0.00667, "b": 0.00667}}, "head1": {"idx": 1, "x": 0.033, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent1"}}, "card1": {"idx": 5, "x": 0.033, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}, "head2": {"idx": 2, "x": 0.27075, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent2"}}, "card2": {"idx": 6, "x": 0.27075, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}, "head3": {"idx": 3, "x": 0.5085, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent3"}}, "card3": {"idx": 7, "x": 0.5085, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}, "head4": {"idx": 4, "x": 0.74625, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent4"}}, "card4": {"idx": 8, "x": 0.74625, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}}}}});
FILES["layout-map.yaml"] = [
  "Cards:", "  layout: Cards", "  regions:",
  "    title: 0", "    head1: 1", "    card1: 5", "    head2: 2", "    card2: 6",
  "    head3: 3", "    card3: 7", "    head4: 4", "    card4: 8", "",
].join(String.fromCharCode(10));


const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

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
  const json = (b, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
  if (url.endsWith("/user")) return json({ login: "tester" });
  if (url.includes("/user/repos")) return json([]);
  if (/\/repos\/tester\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/git/matching-refs/heads/")) return json({ message: "Not Found" }, 404);
  if (url.includes("/git/ref")) return json({ object: { sha: "p1" } });
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: Object.keys(FILES).map((p) => ({ path: p, type: "blob" })),
    });
  }
  if (url.includes("/branches")) return json([{ name: "main" }]);
  return json({});
});

await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(
    route.request().url().split(/\/(?:main|draft[^/]*)\//)[1] ?? ""
  );
  return FILES[path]
    ? route.fulfill({ status: 200, contentType: "text/plain", body: FILES[path] })
    : route.fulfill({ status: 404, body: "" });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "tester/profiles");
await page.click("#open-manual");
await page.waitForSelector("#workspace", { timeout: 15000 });
await page.waitForTimeout(1500);

const said = await page.evaluate(() => {
  const canvas = document.querySelector(".canvas") || document.getElementById("canvas");
  const text = canvas ? canvas.textContent.trim() : "";
  return {
    text: text.slice(0, 240),
    blamesGeometry: Boolean(canvas?.querySelector("[data-missing-geometry]")),
    saysUndefined: /undefined/.test(text),
    namesTheFile: /slides\.md/.test(text),
    // The line YAML objected to is the whole point of saying anything.
    givesTheLine: /line \d+|\(\d+:\d+\)/.test(text),
    offersHistory: /clock|earlier version/i.test(text),
  };
});

console.log("opening a deck whose file is already broken:");
console.log(JSON.stringify(said, null, 1));

// The second slide is fine and must still be reachable and drawable.
const rowCount = await page.locator(".slide-row").count();
if (rowCount > 1) await page.locator(".slide-row").nth(1).click();
const second = { rows: rowCount };
await page.waitForTimeout(900);
const secondDrawn = await page.evaluate(() => ({
  regions: document.querySelectorAll(".canvas .region").length,
  stillComplaining: Boolean(document.querySelector("[data-unreadable]")),
}));
console.log("the slide beside it:", JSON.stringify({ ...second, ...secondDrawn }));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  // It must not blame the geometry or the template.
  said.blamesGeometry ||
  said.saysUndefined ||
  // It must say what is actually wrong, and where.
  !said.namesTheFile ||
  !said.givesTheLine ||
  !said.offersHistory ||
  // One unreadable slide must not take the rest of the deck with it.
  second.rows !== 2 ||
  secondDrawn.stillComplaining ||
  secondDrawn.regions < 1;

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
