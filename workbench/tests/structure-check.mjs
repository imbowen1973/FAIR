// Rearranging the running order, in the real app.
//
// The transforms are unit-tested and cannot lose a session. This asks
// the other question: are the controls reachable, do they do what their
// arrows say, and is what reaches course.yaml something the renderer
// will accept.
//
// Reading the committed file matters here more than usual. The canvas
// has repeatedly shown an arrangement the saved file did not hold, and
// course.yaml is the one file where a mistake is silent: a session moved
// into the wrong module still renders perfectly, just in the wrong
// place.
//
//   node tests/structure-check.mjs
//
// Needs a site-shaped build (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

const COURSE = [
  "id: v",
  "title: V130",
  "structure:",
  "  - kind: module",
  "    title: Foundations",
  "    children:",
  "      - block: 01-intro",
  "      - block: 02-profiles",
  "  - block: 03-standalone",
  "  - kind: module",
  "    title: Assessment week",
  "    children:",
  "      - block: 04-exam",
  "",
].join(String.fromCharCode(10));

const FILES = {
  "course.yaml": COURSE,
  "competencies/framework.yaml": "competencies:\n  C1:\n    label: Practice\n",
  "outcomes.yaml": "outcomes:\n  O1:\n    statement: s\n    block: 01-intro\n    develops: [C1]\n",
  "layout-map.yaml": "Full:\n  layout: Full\n  regions:\n    title: 0\n    full: 1\n",
};
// Four placed sessions, and a fifth on disk that the order does not name.
for (const id of ["01-intro", "02-profiles", "03-standalone", "04-exam", "05-orphan"]) {
  FILES[`blocks/${id}/block.yaml`] = `title: ${id}\nduration_minutes: 45\nresources: []\n`;
  FILES[`blocks/${id}/slides.md`] =
    "---\nsession: '01'\ntitle: T\nversion: 1.0.0\n---\n\n" +
    "--- slide\nid: s-01\nlayout: Full\ntitle: Opening\n---\n";
}

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() !== "error") return;
  if (t.includes("favicon") || t.includes("Failed to load resource")) return;
  errors.push(t);
});

const repo = new Map(Object.entries(FILES));
const blobs = [];

await page.route("https://api.github.com/**", (route) => {
  const req = route.request();
  const url = req.url();
  const method = req.method();
  const body = () => {
    try { return JSON.parse(req.postData() || "{}"); } catch { return {}; }
  };
  const json = (b, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });

  if (url.includes("/git/matching-refs/heads/")) return json([]);
  if (url.endsWith("/user") && method === "GET") return json({ login: "tester" });
  if (url.includes("/user/repos")) return json([]);
  if (/\/repos\/tester\/[^/]+$/.test(url) && method === "GET") {
    return json({ default_branch: "main", permissions: { push: true } });
  }
  if (url.includes("/git/ref")) {
    if (method === "PATCH" || method === "POST") return json({});
    return json({ object: { sha: "p1" } });
  }
  if (url.includes("/git/trees/")) {
    return json({
      truncated: false,
      tree: [...repo.keys()].map((p) => ({ path: p, type: "blob" })),
    });
  }
  if (url.includes("/git/blobs") && method === "POST") {
    blobs.push(body());
    return json({ sha: `blob${blobs.length}` });
  }
  if (url.includes("/git/trees") && method === "POST") {
    const t = body();
    t.tree.forEach((entry, i) => {
      const blob = blobs[blobs.length - t.tree.length + i];
      if (blob && blob.encoding !== "base64") repo.set(entry.path, blob.content ?? "");
    });
    return json({ sha: "tree1" });
  }
  if (url.includes("/git/commits") && method === "POST") return json({ sha: "commit1" });
  if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
  if (url.includes("/branches")) return json([{ name: "main" }]);
  return json({});
});

await page.route("https://raw.githubusercontent.com/**", (route) => {
  const path = decodeURIComponent(
    route.request().url().split(/\/(?:main|draft[^/]*)\//)[1] ?? ""
  );
  return repo.has(path)
    ? route.fulfill({ status: 200, contentType: "text/plain", body: repo.get(path) })
    : route.fulfill({ status: 404, body: "" });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "tester/v130");
await page.click("#open-manual");
await page.waitForSelector("#workspace", { timeout: 15000 });
await page.waitForTimeout(900);

// Open the course view: the rail's own entry for the whole repo.
await page.click(".course-entry .block-head");
await page.waitForSelector(".order-row", { timeout: 8000 });

const shape = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".order-row")].map((row) => {
      const title = row.querySelector(".order-title");
      const card = row.querySelector(".card-title");
      return {
        heading: Boolean(title),
        text: (title ? title.value : card?.textContent) ?? "",
        indent: parseInt(row.style.marginLeft || "0", 10),
      };
    })
  );

console.log("as opened:", JSON.stringify(await shape()));
if (errors.length) console.log("page errors so far:", errors.slice(0, 4));

// The toolbar must be here. Rearranging with no Save in front of you was
// the state this view shipped in.
const toolbar = await page.evaluate(() => {
  const seen = (id) => {
    const b = document.getElementById(id);
    if (!b) return false;
    const r = b.getBoundingClientRect();
    if (!r.width) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === b || b.contains(hit);
  };
  return { save: seen("save"), undo: seen("undo"), redo: seen("redo"), history: seen("history") };
});
console.log("toolbar reachable:", JSON.stringify(toolbar));

/** Press one of a row's arrows, by the row's visible text. */
async function press(text, label) {
  const ok = await page.evaluate(
    ([text, label]) => {
      for (const row of document.querySelectorAll(".order-row")) {
        const title = row.querySelector(".order-title");
        const card = row.querySelector(".card-title");
        const mine = (title ? title.value : card?.textContent) ?? "";
        if (mine !== text) continue;
        const b = [...row.querySelectorAll(".order-tools button")].find(
          (x) => x.textContent === label
        );
        if (!b || b.disabled) return false;
        // Reachable, not merely present: four controls in this project
        // have been correct and unclickable.
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit !== b && !b.contains(hit)) return false;
        b.click();
        return true;
      }
      return false;
    },
    [text, label]
  );
  await page.waitForTimeout(250);
  return ok;
}

// 1. Move a session out of Foundations, along, and into Assessment week.
const moved = [
  await press("01-intro", "←"),
  await press("01-intro", "↓"),
  await press("01-intro", "↓"),
  await press("01-intro", "→"),
];
console.log("out, along, along, in:", JSON.stringify(moved));
console.log("after moving:", JSON.stringify(await shape()));

// 2. Rename a heading, and say what kind of thing it is.
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".order-row.heading")][0];
  const title = row.querySelector(".order-title");
  title.value = "Getting started";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  const kind = row.querySelector(".order-kind");
  kind.value = "week";
  kind.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(400);

// 3. Place the session the running order never mentioned.
const placed = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /add to the running order/i.test(x.textContent || "")
  );
  if (!b) return false;
  b.click();
  return true;
});
await page.waitForTimeout(400);
console.log("placed the orphan:", placed);

// 4. Remove a heading. Its sessions must stay, in its place.
const beforeRemove = await shape();
await press("Assessment week", "×");
const afterRemove = await shape();
console.log("after removing a heading:", JSON.stringify(afterRemove));

// 5. Undo it.
await page.click("#undo");
await page.waitForTimeout(400);
const afterUndo = await shape();
console.log("after undo:", JSON.stringify(afterUndo));

// 6. Save, and read what was really committed.
await page.click("#save");
await page.waitForTimeout(2200);
const written = repo.get("course.yaml") ?? "";
console.log("\n--- committed course.yaml ---");
console.log(written);

const parsed = await page.evaluate(async (text) => {
  const { parse } = await import("./yaml.js");
  const { blockIds, wellFormed, flatten } = await import("./structure.js");
  const doc = parse(text) || {};
  return {
    blocks: blockIds(doc.structure ?? []),
    wellFormed: wellFormed(doc.structure ?? []),
    rows: flatten(doc.structure ?? []).map((r) =>
      r.kind === "block" ? r.block : `[${r.kind}] ${r.title}`
    ),
  };
}, written);
console.log("committed order:", JSON.stringify(parsed.rows, null, 1));

if (errors.length) console.log("errors:", errors.slice(0, 5));

const failed =
  errors.length > 0 ||
  !toolbar.save || !toolbar.undo || !toolbar.redo || !toolbar.history ||
  !moved.every(Boolean) ||
  !placed ||
  // Removing a heading keeps its sessions: one fewer row, not two.
  afterRemove.length !== beforeRemove.length - 1 ||
  // ...and undo brings the heading back.
  afterUndo.length !== beforeRemove.length ||
  !parsed.wellFormed ||
  // Every session on disk is now in the running order, exactly once.
  parsed.blocks.length !== 5 ||
  new Set(parsed.blocks).size !== 5 ||
  !parsed.rows.includes("[week] Getting started") ||
  // 01-intro really did end up inside the second grouping.
  !written.includes("01-intro");

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
