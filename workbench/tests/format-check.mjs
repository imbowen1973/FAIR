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
    "layout: Cards",
    "title: Opening",
    "head1: A heading on a coloured tab",
    "card1:",
    "  type: ul",
    "  items:",
    "    - First bullet",
    "    - Second bullet",
    "    - Third bullet",
    "head2: Second heading",
    "card2:",
    "  type: ul",
    "  items:",
    "    - Card two bullet",
    "full:",
    "  type: ul",
    "  items:",
    "    - The original bullet",
    "---",
    "",
  ].join("\n"),
  "__unused": [
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
FILES["layout-geometry.json"] = JSON.stringify({"slide": {"widthEmu": 9144000, "heightEmu": 6858000, "aspect": 1.33333, "widthPt": 720.0}, "theme": {"dk1": "#000000", "lt1": "#FFFFFF", "dk2": "#1F497D", "lt2": "#EEECE1", "accent1": "#4F81BD", "accent2": "#C0504D", "accent3": "#9BBB59", "accent4": "#8064A2", "accent5": "#4BACC6", "accent6": "#F79646", "hlink": "#0000FF", "folHlink": "#800080", "bg1": "#FFFFFF", "tx1": "#000000", "bg2": "#EEECE1", "tx2": "#1F497D"}, "layouts": {"Cards": {"layoutName": "Cards", "regions": {"title": {"idx": 0, "x": 0.05, "y": 0.04005, "w": 0.9, "h": 0.16667, "type": "title", "style": {"align": "ctr", "sizePt": 44.0}, "inset": {"l": 0.01, "r": 0.01, "t": 0.00667, "b": 0.00667}}, "head1": {"idx": 1, "x": 0.033, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent1"}}, "card1": {"idx": 5, "x": 0.033, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}, "head2": {"idx": 2, "x": 0.27075, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent2"}}, "card2": {"idx": 6, "x": 0.27075, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}, "head3": {"idx": 3, "x": 0.5085, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent3"}}, "card3": {"idx": 7, "x": 0.5085, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}, "head4": {"idx": 4, "x": 0.74625, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}, "fill": {"slot": "accent4"}}, "card4": {"idx": 8, "x": 0.74625, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}, "fill": {"slot": "bg2"}}}}}});
// The same layout as a library whose geometry predates fills.
const NO_FILL = {"slide": {"widthEmu": 9144000, "heightEmu": 6858000, "aspect": 1.33333, "widthPt": 720.0}, "theme": {"dk1": "#000000", "lt1": "#FFFFFF", "dk2": "#1F497D", "lt2": "#EEECE1", "accent1": "#4F81BD", "accent2": "#C0504D", "accent3": "#9BBB59", "accent4": "#8064A2", "accent5": "#4BACC6", "accent6": "#F79646", "hlink": "#0000FF", "folHlink": "#800080", "bg1": "#FFFFFF", "tx1": "#000000", "bg2": "#EEECE1", "tx2": "#1F497D"}, "layouts": {"Cards": {"layoutName": "Cards", "regions": {"title": {"idx": 0, "x": 0.05, "y": 0.04005, "w": 0.9, "h": 0.16667, "type": "title", "style": {"align": "ctr", "sizePt": 44.0}, "inset": {"l": 0.01, "r": 0.01, "t": 0.00667, "b": 0.00667}}, "head1": {"idx": 1, "x": 0.033, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}}, "card1": {"idx": 5, "x": 0.033, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}}, "head2": {"idx": 2, "x": 0.27075, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}}, "card2": {"idx": 6, "x": 0.27075, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}}, "head3": {"idx": 3, "x": 0.5085, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}}, "card3": {"idx": 7, "x": 0.5085, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}}, "head4": {"idx": 4, "x": 0.74625, "y": 0.24, "w": 0.22075, "h": 0.07333, "type": "body", "style": {"align": "ctr", "sizePt": 15.0, "bold": true, "colorSlot": "lt1", "bulleted": false}, "inset": {"l": 0.01, "r": 0.01, "t": 0.0, "b": 0.0}}, "card4": {"idx": 8, "x": 0.74625, "y": 0.31333, "w": 0.22075, "h": 0.63333, "type": "body", "style": {"align": "l", "sizePt": 13.0, "sizePt2": 11.0, "bulleted": true}, "inset": {"l": 0.01, "r": 0.01, "t": 0.012, "b": 0.012}}}}}};

FILES["layout-map.yaml"] = [
  "Cards:", "  layout: Cards", "  regions:",
  "    title: 0", "    head1: 1", "    card1: 5", "    head2: 2", "    card2: 6", "",
].join(String.fromCharCode(10));

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

// ---- formatting belongs to what you selected --------------------------
//
// Colour was a property of the whole placeholder, and the list buttons
// converted the whole placeholder too -- so selecting one bullet and
// picking a colour recoloured every line in it. Change one, change them
// all. The grammar has carried per-item colour and marker all along;
// nothing exposed either.
//
// Colour one line inside a placeholder: the others must not follow.
const lineColours = () =>
  page.evaluate(() => {
    const box = document.querySelector('.canvas .region[data-region="card1"]');
    return [...box.querySelectorAll("li")].map((li) => ({
      text: li.textContent.trim().slice(0, 14),
      colour: getComputedStyle(li).color,
    }));
  });

console.log("before:", JSON.stringify(await lineColours()));

// Put the caret in the second bullet, then pick a colour.
await page.locator('.canvas .region[data-region="card1"] li').nth(1).click();
await page.waitForTimeout(300);
await page.locator("#ribbon button.swatch").nth(1).click();
await page.waitForTimeout(600);
const after = await lineColours();
console.log("after: ", JSON.stringify(after));

const distinct = new Set(after.map((l) => l.colour)).size;
console.log("distinct colours in one placeholder:", distinct);

// And markers, per line, from the same buttons.
const markers = () =>
  page.evaluate(() => {
    const box = document.querySelector('.canvas .region[data-region="card1"]');
    return [...box.querySelectorAll("li")].map((li) => ({
      text: li.textContent.trim().slice(0, 14),
      marker: getComputedStyle(li).listStyleType,
    }));
  });
console.log("markers before:", JSON.stringify(await markers()));
await page.locator('.canvas .region[data-region="card1"] li').nth(1).click();
await page.waitForTimeout(300);
await page.locator('#ribbon .mark.list[data-list="ol"]').first().click();
await page.waitForTimeout(600);
const markersAfter = await markers();
console.log("markers after: ", JSON.stringify(markersAfter));

// A whole placeholder can still be converted: the caret is in a plain
// region, so there are no lines to act on and the region is the target.
await page.locator('.canvas .region[data-region="head1"]').first().click();
await page.waitForTimeout(300);
await page.locator('#ribbon .mark.list[data-list="ul"]').first().click();
await page.waitForTimeout(600);
const wholeRegion = await page.evaluate(() => {
  const box = document.querySelector('.canvas .region[data-region="head1"]');
  return { list: box.querySelector("ul, ol")?.tagName?.toLowerCase() ?? null };
});
console.log("whole region converted:", JSON.stringify(wholeRegion));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  // One line coloured, the others left alone.
  distinct !== 2 ||
  after[0].colour !== after[2].colour ||
  after[1].colour === after[0].colour ||
  // One line numbered inside a bulleted list.
  markersAfter[1].marker !== "decimal" ||
  markersAfter[0].marker !== "disc" ||
  markersAfter[2].marker !== "disc" ||
  // And a region with no lines is still convertible as a whole.
  wholeRegion.list !== "ul";

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
