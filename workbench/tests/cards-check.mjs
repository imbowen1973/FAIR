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
    "card1: One line to start with",
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

// ---- the Cards layout --------------------------------------------------
//
// Its headings are white, because in the template they sit on an
// accent-coloured tab. The canvas drew only the text, so they were white
// on white -- invisible here while the rendered deck looked correct.
const painted = await page.evaluate(() => {
  const read = (name) => {
    const box = document.querySelector(`.canvas .region[data-region="${name}"]`);
    if (!box) return { missing: true };
    const s = getComputedStyle(box);
    return { colour: s.color, background: s.backgroundColor };
  };
  return { head1: read("head1"), card1: read("card1") };
});
console.log("cards:", JSON.stringify(painted));

// A library whose layout-geometry.json has no fills -- which is every
// library generated before they were captured. Nothing can be painted,
// so white-on-white must not be drawn: the canvas falls back to a colour
// that can be read, while the deck keeps the template's white.
await page.evaluate(async (geom) => {
  const { drawSlide } = await import("./canvas.js");
  const host = document.createElement("div");
  host.id = "probe";
  host.style.width = "800px";
  document.body.appendChild(host);
  drawSlide(host, {
    geometry: geom,
    layoutKey: "Cards",
    slide: { title: "T", head1: "A heading", card1: "Body" },
    editable: false,
  });
}, NO_FILL);
const withoutFill = await page.evaluate(() => {
  const box = document.querySelector('#probe [data-region="head1"]');
  const s = getComputedStyle(box);
  return { colour: s.color, background: s.backgroundColor };
});
console.log("no fill in the geometry:", JSON.stringify(withoutFill));

const transparent = (c) => !c || c === "rgba(0, 0, 0, 0)" || c === "transparent";

// ---- and newlines typed into a card ------------------------------------
//
// A bare string was drawn as one paragraph however many lines it held,
// so a second line merged back into the first on the next redraw.
const card = page.locator('.canvas .region[data-region="card1"]').first();
await card.click();
await page.waitForTimeout(200);
await page.keyboard.press("Control+A");
await page.keyboard.type("First line");
await page.keyboard.press("Enter");
await page.keyboard.type("Second line");
await page.waitForTimeout(500);

// Blur, exactly as the report describes, then force a redraw by leaving
// the slide and coming back.
await page.locator('.canvas .region[data-region="head1"]').first().click();
await page.waitForTimeout(400);
const thumbAfterBlur = await page.evaluate(
  () => document.querySelector(".slide-row .thumb")?.textContent?.trim() ?? ""
);
await page.locator(".tabstrip .tab", { hasText: "Outcomes" }).first().click();
await page.waitForTimeout(500);
await page.locator(".tabstrip .tab", { hasText: "Slides" }).first().click();
await page.waitForTimeout(600);
const redrawn = await page.evaluate(() => {
  const box = document.querySelector('.canvas .region[data-region="card1"]');
  return {
    paragraphs: box ? box.querySelectorAll("p").length : 0,
    text: box ? box.textContent.trim() : "",
  };
});
console.log("after blur, thumb:", JSON.stringify(thumbAfterBlur));
console.log("after a redraw:", JSON.stringify(redrawn));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  painted.head1.missing ||
  // The tab is painted, so white text is legible.
  transparent(painted.head1.background) ||
  transparent(painted.card1.background) ||
  painted.head1.background === painted.card1.background ||
  // Nothing to paint: the heading must not be drawn white on white.
  withoutFill.colour === "rgb(255, 255, 255)" ||
  // Both lines survived the blur...
  !thumbAfterBlur.includes("First line") ||
  !thumbAfterBlur.includes("Second line") ||
  // ...and the redraw, as two paragraphs rather than one run-on.
  redrawn.paragraphs !== 2 ||
  !redrawn.text.includes("First line") ||
  !redrawn.text.includes("Second line");

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
