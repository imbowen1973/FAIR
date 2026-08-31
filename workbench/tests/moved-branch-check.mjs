// A branch that moves while a save is in flight.
//
//   Save failed: PATCH /repos/.../git/refs/heads/draft%2Fsomeone
//   failed (422): Update is not a fast forward
//
// Uploading blobs, building a tree and writing a commit takes seconds,
// and a branch can move in seconds — another tab, another person, a
// merge on GitHub. Git refusing to move the branch backwards is correct
// and protects the other commit. Giving up at that point is not: the
// work is still in the browser.
//
// So the save rebuilds on whatever arrived and tries again. Safe because
// every write is a whole file: files this session did not touch keep the
// other commit's version, files it did touch get this one's. Nothing
// merges line by line and nothing pretends to.
//
// This drives that for real — the mock moves the branch underneath the
// save, exactly once — and then reads what was committed.
//
//   node tests/moved-branch-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const lines = (...parts) => parts.join(String.fromCharCode(10));

const FILES = {
  "course.yaml": lines("id: v", "title: V", "structure:", "  - block: 01-b", ""),
  "competencies/framework.yaml": lines("competencies:", "  C1:", "    label: E", ""),
  "outcomes.yaml": lines(
    "outcomes:", "  O1:", "    statement: s", "    block: 01-b", "    develops: [C1]", ""
  ),
  "blocks/01-b/block.yaml": lines("title: B", "duration_minutes: 45", "resources: []", ""),
  "blocks/01-b/slides.md": lines(
    "---", "session: '01'", "title: B", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: First", "full: Mine", "---", ""
  ),
  "layout-map.yaml": lines(
    "Full:", "  layout: Full", "  regions:", "    title: 0", "    full: 1", ""
  ),
};
FILES["layout-geometry.json"] = JSON.stringify({
  slide: { aspect: 1.7778, widthPt: 720 },
  theme: { bg1: "#ffffff", tx1: "#000000" },
  layouts: {
    Full: {
      regions: {
        title: { idx: 0, x: 0.06, y: 0.05, w: 0.88, h: 0.15, type: "title",
          style: { align: "l", sizePt: 32 }, inset: { l: 0.01, r: 0.01, t: 0, b: 0 } },
        full: { idx: 1, x: 0.06, y: 0.25, w: 0.88, h: 0.6, type: "body",
          style: { align: "l", sizePt: 20 }, inset: { l: 0.01, r: 0.01, t: 0, b: 0 } },
      },
    },
  },
});

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error") return;
  if (t.includes("favicon") || t.includes("Failed to load resource")) return;
  errors.push(t);
});

// The repository, and a branch that moves under the save exactly once.
const repo = new Map(Object.entries(FILES));
const blobs = [];
let treeCount = 0;
const parents = [];
let head = "sha-original";
let refUpdates = 0;
let movedOnce = false;
// What the other person's commit left behind: a file this session never
// touches, which must survive.
const theirs = "blocks/01-b/lessonplan.md";

await page.route("https://api.github.com/**", (route) => {
  const req = route.request();
  const url = req.url();
  const method = req.method();
  const body = () => {
    try { return JSON.parse(req.postData() || "{}"); } catch { return {}; }
  };
  const json = (b, s = 200) =>
    route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });

  if (url.includes("/git/matching-refs/heads/")) return json([]);
  if (url.endsWith("/user") && method === "GET") return json({ login: "tester" });
  if (url.includes("/user/repos")) return json([]);
  if (/\/repos\/tester\/[^/]+$/.test(url) && method === "GET") {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/git/ref/heads/") || (url.includes("/git/refs/heads/") && method === "GET")) {
    return json({ object: { sha: head } });
  }
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: [...repo.keys()].map((p) => ({ path: p, type: "blob" })),
    });
  }
  if (url.includes("/git/blobs") && method === "POST") {
    blobs.push(body());
    return json({ sha: `b${blobs.length}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    const t = body();
    // Whatever this tree is built on, the files in it are this session's.
    t.tree.forEach((entry, i) => {
      const blob = blobs[blobs.length - t.tree.length + i];
      if (blob && blob.encoding !== "base64") repo.set(entry.path, blob.content ?? "");
    });
    return json({ sha: `tree${++treeCount}`, base: t.base_tree });
  }
  if (url.includes("/git/commits") && method === "POST") {
    const c = body();
    parents.push(c.parents?.[0] ?? null);
    return json({ sha: `commit${parents.length}` });
  }
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/git/refs/heads/") && method === "PATCH") {
    refUpdates += 1;
    // The first attempt loses the race: somebody else's commit landed
    // while this save was uploading, and brought a file with it.
    if (!movedOnce) {
      movedOnce = true;
      head = "sha-theirs";
      repo.set(theirs, "# Their lesson plan\n");
      return json({ message: "Update is not a fast forward" }, 422);
    }
    head = body().sha;
    return json({});
  }
  if (url.includes("/branches")) return json([{ name: "main" }]);
  return json({});
});

await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(route.request().url().split(/\/(?:main|draft[^/]*)\//)[1] ?? "");
  return repo.has(path)
    ? route.fulfill({ status: 200, contentType: "text/plain", body: repo.get(path) })
    : route.fulfill({ status: 404, body: "" });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "tester/v");
await page.click("#open-manual");
await page.waitForSelector("#workspace", { timeout: 15000 });
await page.waitForTimeout(900);

// Change something, then save into the race.
await page.click('#canvas .region[data-region="full"]');
await page.waitForTimeout(200);
await page.keyboard.press("End");
await page.keyboard.type(" and more");
await page.waitForTimeout(400);
await page.click("#save");
await page.waitForTimeout(2600);

const said = (await page.textContent("#status")).trim();
console.log("ref updates attempted:", refUpdates);
console.log("commit parents, in order:", JSON.stringify(parents));
console.log("status:", JSON.stringify(said));
console.log("their file survived:", repo.has(theirs));
console.log("our slide:", JSON.stringify((repo.get("blocks/01-b/slides.md") ?? "").includes("and more")));

if (errors.length) console.log("errors:", errors.slice(0, 4));

const failed =
  errors.length > 0 ||
  // It tried, was refused, and tried again on what arrived.
  refUpdates !== 2 ||
  parents.length !== 2 ||
  parents[0] !== "sha-original" ||
  parents[1] !== "sha-theirs" ||
  // The save succeeded, and said what happened rather than reporting it
  // as an ordinary save.
  !/Saved to/.test(said) ||
  !/had moved/.test(said) ||
  // Their file is still there, and ours went in.
  !repo.has(theirs) ||
  !(repo.get("blocks/01-b/slides.md") ?? "").includes("and more");

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
