// Can the workbench start a library that does not exist yet?
//
// Every other path into the workbench assumes a repo. This one makes
// one, so the interesting question is not "did a button fire" but "is
// what it committed a library" — the right files, the right shape, and
// something the renderer will actually build.
//
// GitHub is mocked at the network boundary and every write is recorded,
// so the assertions are about the commit that would really have gone.
//
//   node tests/provision-check.mjs
//
// Needs a site-shaped build with seed/ (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const text = m.text();
  if (m.type() !== "error") return;
  if (text.includes("favicon")) return;
  // The console echo of an expected 404 carries no URL, so it cannot be
  // told apart from a real one here. The response handler below judges
  // 404s properly; this would only double-count them.
  if (text.includes("Failed to load resource")) return;
  errors.push(text);
});
page.on("response", (r) => {
  if (r.status() !== 404) return;
  // Checking whether a name is free *is* a 404, and it has to happen
  // before anything is created. Only a 404 from our own origin is a
  // fault — a module or a seed file that did not deploy.
  if (r.url().startsWith(new URL(BASE).origin)) errors.push(`404: ${r.url()}`);
});

// What the app asked GitHub to do.
const calls = { created: null, blobs: [], trees: [], commits: [], existsChecks: [] };
let repoMade = false;

await page.route("https://api.github.com/**", async (route) => {
  const req = route.request();
  const url = req.url();
  const method = req.method();
  const body = () => {
    try {
      return JSON.parse(req.postData() || "{}");
    } catch {
      return {};
    }
  };
  const json = (b, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });

  if (url.endsWith("/user") && method === "GET") return json({ login: "tester" });
  if (url.includes("/user/repos") && method === "POST") {
    calls.created = body();
    repoMade = true;
    return json({ default_branch: "main", name: calls.created.name }, 201);
  }
  if (url.includes("/user/repos")) return json([]);

  // The existence check must come back 404 before the repo is made, and
  // the app must not create one when it does not.
  const match = /\/repos\/tester\/([^/]+)$/.exec(url);
  if (match && method === "GET") {
    calls.existsChecks.push(match[1]);
    if (match[1] === "already-there") return json({ message: "found" });
    if (!repoMade) return json({ message: "Not Found" }, 404);
    return json({ default_branch: "main", permissions: { push: true } });
  }

  if (url.includes("/git/blobs") && method === "POST") {
    calls.blobs.push(body());
    return json({ sha: `blob${calls.blobs.length}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    calls.trees.push(body());
    return json({ sha: "tree1" });
  }
  if (url.includes("/git/trees/")) {
    // Reading the tree back: the files just committed.
    const paths = (calls.trees[0]?.tree ?? []).map((t) => t.path);
    return json({ truncated: false, tree: paths.map((p) => ({ path: p, type: "blob" })) });
  }
  if (url.includes("/git/commits") && method === "POST") {
    calls.commits.push(body());
    return json({ sha: "commit1" });
  }
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/git/ref/heads/") || url.includes("/git/refs/heads/")) {
    return json({ object: { sha: "parent1" } });
  }
  return json({});
});

// Committed content is the source of truth for what the repo now holds.
const committed = () => {
  const out = new Map();
  const tree = calls.trees[0]?.tree ?? [];
  tree.forEach((entry, i) => {
    const blob = calls.blobs[i];
    out.set(entry.path, blob?.content ?? "");
  });
  return out;
};

await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(route.request().url().split("/main/")[1] ?? "");
  const files = committed();
  if (!files.has(path)) return route.fulfill({ status: 404, body: "" });
  const blob = calls.blobs[[...files.keys()].indexOf(path)];
  const text =
    blob?.encoding === "base64" ? "(binary)" : blob?.content ?? "";
  return route.fulfill({ status: 200, contentType: "text/plain", body: text });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });

// The form has to be reachable, not merely present: this is the third
// time in this project a control existed in the DOM and could not be got at.
await page.click("#new-library summary");
await page.waitForTimeout(200);
const reachable = await page.evaluate(() => {
  const b = document.getElementById("create-library");
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    onScreen: r.top >= 0 && r.bottom <= innerHeight,
    clickable: hit === b || b.contains(hit),
  };
});

// The repository name follows the module name until it is edited.
await page.fill("#new-title", "Big Data in Veterinary Practice");
await page.waitForTimeout(150);
const suggested = await page.inputValue("#new-repo");

await page.fill("#new-block", "Ways big data is misused");
await page.click("#create-library");
await page.waitForTimeout(2500);

const files = committed();
const paths = [...files.keys()].sort();
console.log("reachable:", JSON.stringify(reachable));
console.log("suggested repo name:", suggested);
console.log("created:", JSON.stringify(calls.created));
console.log("committed", paths.length, "files:");
for (const p of paths) console.log("  ", p);

const course = files.get("course.yaml") ?? "";
const outcomes = files.get("outcomes.yaml") ?? "";
const blockPath = paths.find((p) => p.endsWith("block.yaml")) ?? "";
const blockId = blockPath.split("/")[1] ?? "";
const slides = files.get(`blocks/${blockId}/slides.md`) ?? "";
const binary = calls.blobs.filter((b) => b.encoding === "base64");

console.log("--- course.yaml ---");
console.log(course.trim());
console.log("binary blobs:", binary.length);
console.log("opened after creating:", await page.isVisible("#workspace"));

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  !reachable.onScreen ||
  !reachable.clickable ||
  suggested !== "big-data-in-veterinary-practice" ||
  // Checked for a clash before creating anything.
  calls.existsChecks[0] !== "big-data-in-veterinary-practice" ||
  !calls.created ||
  calls.created.private !== true ||
  calls.created.auto_init !== true ||
  // One commit: a half-seeded library is not a library.
  calls.commits.length !== 1 ||
  // The files that make it a library at all.
  !paths.includes("course.yaml") ||
  !paths.includes("outcomes.yaml") ||
  !paths.includes("competencies/framework.yaml") ||
  !paths.includes("layout-map.yaml") ||
  !paths.includes("layout-geometry.json") ||
  !paths.includes("template.pptx") ||
  !paths.includes("README.md") ||
  !blockId.startsWith("01-") ||
  !paths.includes(`blocks/${blockId}/lessonplan.md`) ||
  // The template must go as bytes, not as mangled text.
  binary.length !== 1 ||
  // course.yaml has to point at the block that was actually made.
  !course.includes(`- block: ${blockId}`) ||
  !course.includes("Big Data in Veterinary Practice") ||
  // The deck opens on slides filled from the library rather than typed.
  !slides.includes("role: title") ||
  !slides.includes("role: outcomes") ||
  !outcomes.includes(`block: ${blockId}`) ||
  !(await page.isVisible("#workspace"));

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
