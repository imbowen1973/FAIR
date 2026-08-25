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

// What a repository looks like after the older per-session scheme:
// refs/heads/draft/tester/ is a directory, so refs/heads/draft/tester
// cannot also be a file. Creating it answers 422.
const sentBlobs = [];
const branches = new Set(["main", "draft/tester/01-misuse"]);
const onBranch = { main: new Map(Object.entries(FILES)) };
let lastCommitBranch = null;

await page.route("https://api.github.com/**", (route) => {
  const req = route.request();
  const url = req.url();
  const method = req.method();
  const body = () => {
    try { return JSON.parse(req.postData() || "{}"); } catch { return {}; }
  };
  const json = (b, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
  if (url.endsWith("/user")) return json({ login: "tester" });

  if (url.includes("/git/matching-refs/heads/")) {
    const prefix = decodeURIComponent(url.split("/git/matching-refs/heads/")[1]);
    const hits = [...branches].filter((b) => b.startsWith(prefix));
    return hits.length
      ? json(hits.map((b) => ({ ref: `refs/heads/${b}` })))
      : json({ message: "Not Found" }, 404);
  }

  const refMatch = /\/git\/refs?\/heads\/(.+?)(\?|$)/.exec(url);
  if (refMatch && method === "GET") {
    const name = decodeURIComponent(refMatch[1]);
    return branches.has(name)
      ? json({ object: { sha: `sha-${name}` } })
      : json({ message: "Not Found" }, 404);
  }
  if (url.includes("/git/refs") && method === "POST") {
    branches.add(body().ref.replace("refs/heads/", ""));
    return json({});
  }
  if (url.includes("/git/blobs") && method === "POST") {
    const blob = body();
    sentBlobs.push(blob);
    return json({ sha: `blob-${blob.content?.length ?? 0}-${Math.round(performance.now())}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    lastCommitBranch = null;
    return json({ sha: "tree1", _entries: body().tree });
  }
  if (url.includes("/git/commits") && method === "POST") return json({ sha: "commit1" });
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/git/trees/")) {
    const which = decodeURIComponent(url.split("/git/trees/")[1].split("?")[0]);
    const files = onBranch[which] ?? onBranch.main;
    return json({
      truncated: false,
      tree: [...files.keys()].map((path) => ({ path, type: "blob" })),
    });
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/user/repos")) return json([]);
  return json({});
});
await page.route("https://raw.githubusercontent.com/**", (route) => {
  // .../<owner>/<repo>/<branch>/<path>
  const rest = route.request().url().split("raw.githubusercontent.com/")[1] ?? "";
  const bits = rest.split("/");
  const which = decodeURIComponent(bits[2] ?? "main");
  const path = decodeURIComponent(bits.slice(3).join("/"));
  const files = onBranch[which] ?? onBranch.main;
  return files.has(path)
    ? route.fulfill({ status: 200, contentType: "text/plain", body: files.get(path) })
    : route.fulfill({ status: 404, body: "" });
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

// ---- blank lines in a document ---------------------------------------
//
// A lesson plan is markdown, where a blank line is what makes two
// paragraphs two paragraphs. ProseMirror keeps an empty paragraph as a
// node and the serializer wrote it out as a literal `<br />` on its own
// line -- so pressing Enter twice put an HTML tag into the file, and
// every gap after that multiplied:
//
//   "first paragraph" + NL + NL + "<br />" + NL + NL + "Second..."
// This reads the blob a Save would send, because the editor's own view
// is not what ends up in the repository.

const NL = String.fromCharCode(10);
const committedDoc = () => {
  for (const blob of sentBlobs) {
    const text =
      blob.encoding === "base64"
        ? Buffer.from(blob.content, "base64").toString("utf8")
        : blob.content ?? "";
    if (text.includes("MARKER-ONE")) return text;
  }
  return null;
};

// The lesson plan: a markdown document, where a blank line is what makes
// two paragraphs two paragraphs.
await page.locator(".tabstrip .tab", { hasText: "Lesson plan" }).first().click();
await page.waitForTimeout(900);
const created = await page.evaluate(() => Boolean(document.querySelector(".create-row button")));
if (created) {
  await page.click(".create-row button");
  await page.waitForTimeout(1200);
}

const editor = page
  .locator("#document [contenteditable], #document textarea")
  .first();
await editor.click();
await page.waitForTimeout(300);
await page.keyboard.press("Control+A");
await page.keyboard.type("MARKER-ONE first paragraph");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await page.keyboard.type("Second paragraph after a gap");
await page.waitForTimeout(800);

const onScreen = await page.evaluate(() => {
  const host = document.querySelector("#document [contenteditable], #document textarea");
  return host ? (host.value ?? host.innerText) : "(no editor)";
});
console.log("in the editor:", JSON.stringify(onScreen));

sentBlobs.length = 0;
await page.click("#save");
await page.waitForTimeout(1500);
const doc = committedDoc();
console.log("--- committed document ---");
console.log(JSON.stringify(doc));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const text = doc ?? "";
const failed =
  errors.length > 0 ||
  !text.includes("MARKER-ONE first paragraph") ||
  !text.includes("Second paragraph after a gap") ||
  // Exactly one blank line between them...
  !text.includes("MARKER-ONE first paragraph" + NL + NL + "Second paragraph") ||
  // ...and no HTML where markdown belongs.
  /<br\s*\/?>/i.test(text);

console.log(failed ? NL + "FAIL" : NL + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
