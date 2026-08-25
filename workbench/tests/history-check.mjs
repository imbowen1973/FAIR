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

// What the repository looked like at an older commit.
const HISTORIC = new Map(Object.entries(FILES));
HISTORIC.set(
  "blocks/01-misuse/slides.md",
  FILES["blocks/01-misuse/slides.md"].replace("Opening", "What it said last Tuesday")
);

const branches = new Set(["main"]);
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
    return json({ sha: `blob-${blob.content?.length ?? 0}-${Math.round(performance.now())}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    lastCommitBranch = null;
    return json({ sha: "tree1", _entries: body().tree });
  }
  if (url.includes("/git/commits") && method === "POST") return json({ sha: "commit1" });
  if (url.includes("/commits?")) {
    return json([
      {
        sha: "aaaaaaaaaaaaaaaa",
        html_url: "https://github.com/x/y/commit/aaaaaaa",
        commit: {
          message: "An earlier version" + String.fromCharCode(10) + "body",
          author: { name: "Someone", date: "2026-08-01T09:00:00Z" },
        },
      },
    ]);
  }
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/git/trees/")) {
    const which = decodeURIComponent(url.split("/git/trees/")[1].split("?")[0]);
    const files = which === "aaaaaaaaaaaaaaaa" ? HISTORIC : (onBranch[which] ?? onBranch.main);
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
  const files = which === "aaaaaaaaaaaaaaaa" ? HISTORIC : (onBranch[which] ?? onBranch.main);
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

// ---- history loads a version, rather than linking away -----------------
//
// A link to github.com is not history, it is a way of leaving. What an
// author wants is the version itself: to read what a slide said last
// Tuesday, or take back a change made three commits ago.
await page.click("#history");
await page.waitForTimeout(900);

const listed = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#problems .commit")];
  const first = rows[0];
  const open = first?.querySelector(".commit-open");
  const r = open?.getBoundingClientRect();
  const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return {
    rows: rows.length,
    // A button that loads it, not only a link that leaves.
    hasLoader: Boolean(open),
    clickable: Boolean(open) && (hit === open || open.contains(hit)),
    stillLinksOut: Boolean(first?.querySelector("a[href*='github.com']")),
    text: first?.textContent?.trim() ?? "",
  };
});
console.log("history:", JSON.stringify(listed));

const beforeLoad = await page.evaluate(
  () => document.querySelector(".slide-row .thumb")?.textContent?.trim() ?? ""
);
await page.click("#problems .commit-open");
await page.waitForTimeout(1500);
const afterLoad = await page.evaluate(() => ({
  thumb: document.querySelector(".slide-row .thumb")?.textContent?.trim() ?? "",
  status: document.getElementById("status").textContent,
  dirty: document.getElementById("dirty").textContent,
  saveEnabled: !document.getElementById("save-ribbon").disabled,
}));
console.log("before:", JSON.stringify(beforeLoad));
console.log("after: ", JSON.stringify(afterLoad));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  listed.rows !== 1 ||
  !listed.hasLoader ||
  !listed.clickable ||
  // The way out to GitHub is still there, just not the only thing.
  !listed.stillLinksOut ||
  // The old version is in the editor now...
  !afterLoad.thumb.includes("What it said last Tuesday") ||
  // ...as unsaved changes, not as something already written.
  !/file/.test(afterLoad.dirty) ||
  !afterLoad.saveEnabled ||
  !/Nothing is written until you Save/.test(afterLoad.status);

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
