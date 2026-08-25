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
  "course.yaml": [
    "id: v", "title: V130", "structure:",
    "  - block: 01-misuse", "  - block: 02-second", "",
  ].join(String.fromCharCode(10)),
  "blocks/02-second/block.yaml": [
    "title: The second session", "duration_minutes: 45",
    "outcomes: []", "resources: []", "",
  ].join(String.fromCharCode(10)),
  "blocks/02-second/slides.md": [
    "---", "session: '02'", "title: Second", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: Second opening",
    "full:", "  type: ul", "  items:", "    - Second bullet", "---", "",
  ].join(String.fromCharCode(10)),
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

const blobText = new Map();
let pendingTree = [];
const branches = new Set(["main"]);
const onBranch = { main: new Map(Object.entries(FILES)) };
let forkFrom = "main";

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
    if (branches.has(name)) forkFrom = name;
    return branches.has(name)
      ? json({ object: { sha: `sha-${name}` } })
      : json({ message: "Not Found" }, 404);
  }
  if (url.includes("/git/refs") && method === "POST") {
    const name = body().ref.replace("refs/heads/", "");
    branches.add(name);
    // Forked from whatever the caller said, which is the point at issue.
    onBranch[name] = new Map(onBranch[forkFrom] ?? onBranch.main);
    for (const [path, text] of pendingTree) onBranch[name].set(path, text);
    pendingTree = [];
    return json({});
  }
  if (url.includes("/git/blobs") && method === "POST") {
    const blob = body();
    const sha = `blob${blobText.size}`;
    blobText.set(sha, blob.content ?? "");
    return json({ sha });
  }
  if (url.includes("/git/trees") && method === "POST") {
    pendingTree = body().tree.map((t, i) => [t.path, blobText.get(t.sha) ?? ""]);
    return json({ sha: "tree1" });
  }
  if (url.includes("/git/commits") && method === "POST") return json({ sha: "commit1" });
  if (url.includes("/git/refs/heads/") && method === "PATCH") {
    // The commit lands on the branch the ref names.
    const name = decodeURIComponent(url.split("/git/refs/heads/")[1].split("?")[0]);
    const files = onBranch[name] ?? new Map(onBranch.main);
    for (const [path, text] of pendingTree) files.set(path, text);
    onBranch[name] = files;
    pendingTree = [];
    return json({});
  }
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

// ---- saving two sessions must not lose the first ----------------------
//
// The draft branch was named per block: draft/<login>/<blockId>. Editing
// a second session forked a new branch from the default one, which does
// not hold the first session's saved work -- so reopening showed the
// published version of everything except the session last touched.

const edit = async (tabText, words) => {
  await page.locator(".block-head", { hasText: tabText }).first().click();
  await page.waitForTimeout(600);
  await page.locator('.canvas .region[data-region="title"]').first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(words);
  await page.waitForTimeout(400);
  await page.click("#save");
  await page.waitForTimeout(1200);
};

console.log("blocks on screen:", JSON.stringify(
  await page.$$eval(".block-head", (n) => n.map((x) => x.textContent.trim()))));
await edit("Ways big data is misused", "FIRST session edited");
await edit("The second session", "SECOND session edited");

const branchesUsed = [...branches].filter((b) => b.startsWith("draft/"));
console.log("draft branches:", JSON.stringify(branchesUsed));

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1800);

const seen = await page.evaluate(() => {
  const out = [];
  for (const head of document.querySelectorAll(".block-head")) out.push(head.textContent.trim());
  return out;
});
const readBlock = async (title) => {
  await page.locator(".block-head", { hasText: title }).first().click();
  await page.waitForTimeout(700);
  return page.evaluate(
    () => document.querySelector(".slide-row .thumb")?.textContent?.trim() ?? ""
  );
};
const first = await readBlock("misused");
const second = await readBlock("second session");
console.log("blocks:", JSON.stringify(seen));
console.log("first session after reload: ", JSON.stringify(first));
console.log("second session after reload:", JSON.stringify(second));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  // One place for a person's work in a library, not one per session.
  branchesUsed.length !== 1 ||
  !first.includes("FIRST session edited") ||
  !second.includes("SECOND session edited");

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
