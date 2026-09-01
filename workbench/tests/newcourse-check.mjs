// Starting a course from inside one.
//
// The form that makes a library lives in the panel you sign in through,
// and opening a library hides that panel. So a second course could only
// be started by signing out — from a tool whose whole claim is that a
// course lives in git without ceremony.
//
// It is in the library switcher now. This drives it the way somebody
// would: open a library, work in it, then start another without leaving.
//
//   node tests/newcourse-check.mjs
//
// Needs a site-shaped build with seed/ (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const lines = (...parts) => parts.join(String.fromCharCode(10));

const FILES = {
  "course.yaml": lines("id: v", "title: The one already open", "structure:", "  - block: 01-b", ""),
  "competencies/framework.yaml": lines("competencies:", "  C1:", "    label: E", ""),
  "outcomes.yaml": lines(
    "outcomes:", "  O1:", "    statement: s", "    block: 01-b", "    develops: [C1]", ""
  ),
  "blocks/01-b/block.yaml": lines("title: B", "duration_minutes: 45", "resources: []", ""),
  "blocks/01-b/slides.md": lines(
    "---", "session: '01'", "title: B", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: First", "full: Words", "---", ""
  ),
  "layout-map.yaml": lines("Full:", "  layout: Full", "  regions:", "    title: 0", "    full: 1", ""),
};
FILES["layout-geometry.json"] = JSON.stringify({
  slide: { widthEmu: 12192000, heightEmu: 6858000, aspect: 1.77778, widthPt: 960 },
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
page.on("response", (r) => {
  if (r.status() === 404 && r.url().startsWith(new URL(BASE).origin)) {
    errors.push(`404: ${r.url()}`);
  }
});

// Two repositories: the one open, and the one about to be made.
const repos = { "tester/open-one": new Map(Object.entries(FILES)) };
let created = null;
const blobs = [];

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
  if (url.includes("/user/repos") && method === "POST") {
    created = body();
    repos[`tester/${created.name}`] = new Map();
    return json({ default_branch: "main", name: created.name }, 201);
  }
  if (url.includes("/user/repos")) return json([]);

  const match = /\/repos\/tester\/([^/]+)$/.exec(url);
  if (match && method === "GET") {
    const key = `tester/${match[1]}`;
    if (!repos[key]) return json({ message: "Not Found" }, 404);
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/git/ref")) {
    if (method !== "GET") return json({});
    return json({ object: { sha: "p1" } });
  }
  if (url.includes("/git/trees/")) {
    const repo = `tester/${/\/repos\/tester\/([^/]+)\//.exec(url)?.[1] ?? ""}`;
    return json({
      truncated: false,
      tree: [...(repos[repo] ?? new Map()).keys()].map((p) => ({ path: p, type: "blob" })),
    });
  }
  if (url.includes("/git/blobs") && method === "POST") {
    blobs.push(body());
    return json({ sha: `b${blobs.length}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    const repo = `tester/${/\/repos\/tester\/([^/]+)\//.exec(url)?.[1] ?? ""}`;
    const t = body();
    t.tree.forEach((entry, i) => {
      const blob = blobs[blobs.length - t.tree.length + i];
      const into = repos[repo] ?? (repos[repo] = new Map());
      into.set(entry.path, blob?.encoding === "base64" ? "(binary)" : blob?.content ?? "");
    });
    return json({ sha: "tree1" });
  }
  if (url.includes("/git/commits") && method === "POST") return json({ sha: "commit1" });
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/branches")) return json([{ name: "main" }]);
  return json({});
});

await page.route("https://raw.githubusercontent.com/**", (route) => {
  const url = route.request().url();
  const repo = /raw\.githubusercontent\.com\/(tester\/[^/]+)\//.exec(url)?.[1] ?? "";
  const path = decodeURIComponent(url.split(/\/(?:main|draft[^/]*)\//)[1] ?? "");
  const held = repos[repo];
  return held?.has(path)
    ? route.fulfill({ status: 200, contentType: "text/plain", body: held.get(path) })
    : route.fulfill({ status: 404, body: "" });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "tester/open-one");
await page.click("#open-manual");
await page.waitForSelector("#workspace", { timeout: 15000 });
await page.waitForTimeout(900);

// The form is out of reach at this point, which is the whole complaint.
const buried = await page.evaluate(() => ({
  panelHidden: document.getElementById("signed-in").hidden,
  switcher: [...document.getElementById("repo-switch").options].map((o) => o.textContent),
}));
console.log("with a library open:", JSON.stringify(buried));

// Start another, from the switcher.
const offered = buried.switcher.find((t) => /new course/i.test(t));
await page.selectOption("#repo-switch", { label: offered ?? "" });
await page.waitForTimeout(600);

const shown = await page.evaluate(() => {
  const title = document.getElementById("new-title");
  const r = title?.getBoundingClientRect();
  const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  return {
    panelHidden: document.getElementById("signed-in").hidden,
    formOpen: document.getElementById("new-library").open,
    reachable: Boolean(hit) && (hit === title || title.contains(hit)),
    // The switcher must not sit on an entry that is not a library.
    switcherValue: document.getElementById("repo-switch").value,
    // ...and the library open behind it is untouched.
    stillOpen: !document.getElementById("workspace").hidden,
    said: document.getElementById("status").textContent.trim(),
  };
});
console.log("after choosing it:", JSON.stringify(shown));

// Fill it in and create.
await page.fill("#new-title", "A second course");
await page.waitForTimeout(200);
await page.fill("#new-block", "Getting started");
await page.click("#create-library");
await page.waitForTimeout(3000);

const after = await page.evaluate(() => ({
  switcher: document.getElementById("repo-switch").value,
  courseTitle: document.getElementById("course-title")?.textContent ?? "",
  panelHidden: document.getElementById("signed-in").hidden,
}));
console.log("created:", JSON.stringify(created));
console.log("now in:", JSON.stringify(after));

if (errors.length) console.log("errors:", errors.slice(0, 5));

const madeFiles = [...(repos["tester/a-second-course"] ?? new Map()).keys()];

const failed =
  errors.length > 0 ||
  // It was out of reach before, and offered now.
  !buried.panelHidden ||
  !offered ||
  // Choosing it shows the form, reachable, without leaving the library.
  shown.panelHidden ||
  !shown.formOpen ||
  !shown.reachable ||
  !shown.stillOpen ||
  shown.switcherValue !== "tester/open-one" ||
  // And it really makes a library.
  !created ||
  created.name !== "a-second-course" ||
  !madeFiles.includes("course.yaml") ||
  !madeFiles.some((p) => /^blocks\/01-.*\/slides\.md$/.test(p)) ||
  // ...which is then the one you are in.
  after.switcher !== "tester/a-second-course" ||
  !after.panelHidden;

console.log(failed ? String.fromCharCode(10) + "FAIL" : String.fromCharCode(10) + "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
