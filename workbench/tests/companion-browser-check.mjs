// The private companion, end to end: connect it, see the private tabs,
// edit a bank and a guide, and Save -- the course's files to the course,
// the companion's to the companion, nothing crossing over.
//
// GitHub is mocked at the network boundary with real state: refs move,
// commits are recorded per repository, and the companion is private --
// anonymous reads of it 404, as they do on github.com, so the files must
// come through the authenticated API.
//
//   node tests/companion-browser-check.mjs   (site-shaped build, as create-check.mjs)

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8890/workbench/";
const FILES = {
  "course.yaml": "id: v\ntitle: V130\nstructure:\n  - block: 01-misuse\n",
  "blocks/01-misuse/block.yaml": "title: Misuse\nduration_minutes: 90\nresources: []\n",
  "blocks/01-misuse/slides.md": [
    "---", "session: '01'", "title: Misuse", "version: 1.0.0", "---", "",
    "--- slide", "id: s-01", "layout: Full", "title: Opening",
    "full:", "  type: ul", "  items:",
    "    - Re-identification from anonymised records",
    "    - Bias nobody audits",
    "notes: |", "  Ask the room.", "---", "",
  ].join(String.fromCharCode(10)),
  "layout-map.yaml": [
    "Full:", "  layout: Full", "  regions:",
    "    title: 0", "    full: 1",
    "Comparison:", "  layout: Comparison", "  regions:",
    "    title: 0", "    left: 1", "    right: 2",
    "Title:", "  layout: Title", "  regions:", "    title: 0", "",
  ].join(String.fromCharCode(10)),
  "layout-geometry.json": "{\"slide\": {\"widthEmu\": 12192000, \"heightEmu\": 6858000, \"aspect\": 1.7778, \"widthPt\": 960.0}, \"theme\": {\"dk1\": \"#000000\", \"lt1\": \"#FFFFFF\", \"accent1\": \"#4F81BD\", \"accent2\": \"#C0504D\", \"accent3\": \"#9BBB59\", \"accent4\": \"#8064A2\", \"accent5\": \"#4BACC6\", \"accent6\": \"#F79646\", \"bg1\": \"#FFFFFF\", \"tx1\": \"#000000\"}, \"layouts\": {\"Full\": {\"layoutName\": \"Full\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.06, \"y\": 0.07, \"w\": 0.88, \"h\": 0.15, \"type\": \"title\", \"style\": {\"align\": \"l\", \"sizePt\": 32.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"full\": {\"idx\": 1, \"x\": 0.06, \"y\": 0.27, \"w\": 0.88, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}, \"Comparison\": {\"layoutName\": \"Comparison\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.06, \"y\": 0.07, \"w\": 0.88, \"h\": 0.15, \"type\": \"title\", \"style\": {\"align\": \"l\", \"sizePt\": 32.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"left\": {\"idx\": 1, \"x\": 0.06, \"y\": 0.27, \"w\": 0.42, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}, \"right\": {\"idx\": 2, \"x\": 0.52, \"y\": 0.27, \"w\": 0.42, \"h\": 0.6, \"type\": \"body\", \"style\": {\"align\": \"l\", \"sizePt\": 20.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}, \"Title\": {\"layoutName\": \"Title\", \"regions\": {\"title\": {\"idx\": 0, \"x\": 0.075, \"y\": 0.31, \"w\": 0.85, \"h\": 0.21, \"type\": \"center_title\", \"style\": {\"align\": \"l\", \"sizePt\": 44.0}, \"inset\": {\"l\": 0.01, \"r\": 0.01, \"t\": 0.00667, \"b\": 0.00667}}}}}}",
};

FILES["outcomes.yaml"] = "outcomes:\n  O1: {statement: Spot misuse}\n";
FILES["blocks/01-misuse/lessonplan.md"] = "# Misuse\n";

const COMPANION = {
  "companion.yaml": "library: t/lib\n",
  "blocks/01-misuse/questions.yaml":
    "questions:\n  - {id: q-01, type: truefalse, assesses: [O1], stem: Anonymised data cannot be re-identified., answer: false}\n",
};

const REPOS = {
  "t/lib": { files: FILES, private: false, refs: { main: "lib-0" } },
  "t/lib-private": { files: COMPANION, private: true, refs: { main: "priv-0" } },
  "t/public-answers": { files: COMPANION, private: false, refs: { main: "pub-0" } },
  "t/other-private": { files: { "companion.yaml": "library: t/another-course\n" }, private: true, refs: { main: "o-0" } },
};
const commits = []; // {repo, branch, paths}
const blobs = new Map(); // sha -> {repo, content}
let counter = 0;

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

await page.route("https://api.github.com/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const path = decodeURIComponent(url.pathname);
  const method = req.method();
  const json = (b, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
  const raw = (text) => route.fulfill({ status: 200, contentType: "text/plain", body: text });
  if (path === "/user") return json({ login: "t" });
  if (path.startsWith("/user/repos")) return json([]);
  const m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!m || !REPOS[m[1]]) return json({ message: "Not Found" }, 404);
  const name = m[1];
  const repo = REPOS[name];
  const rest = m[2] ?? "";
  if (!rest) return json({ default_branch: "main", private: repo.private, permissions: { push: true } });
  if (rest.startsWith("/git/trees/") && method === "GET") {
    return json({ truncated: false, tree: Object.keys(repo.files).map((p) => ({ path: p, type: "blob" })) });
  }
  if (rest.startsWith("/contents/")) {
    // The authenticated read: the only way into a private repo.
    const body = repo.files[rest.slice("/contents/".length)];
    return body === undefined ? json({ message: "Not Found" }, 404) : raw(body);
  }
  if (rest.startsWith("/git/matching-refs/")) return json([]);
  let r = rest.match(/^\/git\/refs?\/heads\/(.+)$/);
  if (r && method === "GET") {
    const sha = repo.refs[r[1]];
    return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
  }
  if (r && method === "PATCH") {
    repo.refs[r[1]] = req.postDataJSON().sha;
    return json({});
  }
  if (rest === "/git/refs" && method === "POST") {
    const body = req.postDataJSON();
    repo.refs[body.ref.replace("refs/heads/", "")] = body.sha;
    return json({});
  }
  if (rest === "/git/blobs" && method === "POST") {
    const sha = `blob-${++counter}`;
    blobs.set(sha, { repo: name, content: req.postDataJSON().content });
    return json({ sha });
  }
  if (rest.startsWith("/git/commits/") && method === "GET") return json({ tree: { sha: "base" } });
  if (rest === "/git/trees" && method === "POST") {
    const sha = `tree-${++counter}`;
    blobs.set(sha, { repo: name, tree: req.postDataJSON().tree });
    return json({ sha });
  }
  if (rest === "/git/commits" && method === "POST") {
    const body = req.postDataJSON();
    const tree = blobs.get(body.tree)?.tree ?? [];
    const sha = `commit-${++counter}`;
    commits.push({ repo: name, sha, paths: tree.map((t) => t.path) });
    return json({ sha });
  }
  return json({});
});
await page.route("https://raw.githubusercontent.com/**", (route) => {
  const parts = new URL(route.request().url()).pathname.split("/").slice(1);
  const name = `${parts[0]}/${parts[1]}`;
  const repo = REPOS[name];
  const path = decodeURIComponent(parts.slice(3).join("/"));
  // Anonymous: a private repo is invisible, exactly as on GitHub.
  const body = repo && !repo.private ? repo.files[path] : undefined;
  return body === undefined
    ? route.fulfill({ status: 404, body: "" })
    : route.fulfill({ status: 200, contentType: "text/plain", body });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.fill("#pat", "x");
await page.click("#pat-signin");
await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });
await page.fill("#manual-repo", "t/lib");
await page.click("#open-manual");
await page.waitForSelector("#workspace:not([hidden])", { timeout: 15000 });

// ---- connect --------------------------------------------------------
await page.click("#companion-toggle");
await page.fill("#companion-repo", "t/lib-private");
await page.click("#companion-connect");
await page.waitForSelector(".tab.private", { timeout: 10000 });
const connected = await page.evaluate(() => ({
  toggle: document.getElementById("companion-toggle").textContent,
  tabs: [...document.querySelectorAll(".tab")].map((t) => [
    t.querySelector(".tab-label")?.textContent, t.classList.contains("private"),
    Boolean(t.querySelector(".tab-close")),
  ]),
  status: document.getElementById("status").textContent,
}));
console.log("connected:", JSON.stringify(connected));

// ---- the bank: read from the private repo, checked, edited ----------
await page.click(".tab.private[data-doc='companion:questions.yaml']");
await page.waitForSelector(".questions-editor textarea");
const bank = await page.evaluate(() => ({
  text: document.querySelector(".questions-editor textarea").value,
  verdict: document.querySelector(".bank-check").textContent,
  note: document.querySelector(".private-note")?.textContent,
}));
console.log("bank:", JSON.stringify(bank));
await page.fill(
  ".questions-editor textarea",
  bank.text + "  - {id: q-02, type: truefalse, assesses: [O7], stem: Bias is always audited., answer: false}\n"
);
await page.waitForTimeout(500);
const flagged = await page.textContent(".bank-check");
console.log("flagged:", flagged);
await page.fill(
  ".questions-editor textarea",
  bank.text + "  - {id: q-02, type: truefalse, assesses: [O1], stem: Bias is always audited., answer: false}\n"
);
await page.waitForTimeout(500);

// ---- a guide that does not exist yet: created in the companion ------
await page.click(".tab.private[data-doc='companion:instructorguide.md']");
await page.click("#document .create-row button.primary");
await page.waitForTimeout(300);
const dirty = await page.textContent("#dirty");
const libraryUntouched = await page.evaluate(() => !document.querySelector("#document")?.textContent.includes("block.yaml"));

// ---- save: each file to its own repo -------------------------------
await page.evaluate(() => document.getElementById("save").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
await page.waitForFunction(() => /saved/i.test(document.getElementById("status").textContent), null, { timeout: 15000 });
const after = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  dirty: document.getElementById("dirty").textContent,
}));
console.log("dirty before save:", dirty, "after:", JSON.stringify(after));
console.log("commits:", JSON.stringify(commits));

// ---- a mixed save: one edit in each repo --------------------------
const before = commits.length;
await page.click(".tab[data-doc='slides']");
await page.waitForSelector(".canvas .region");
await page.evaluate(() => {
  const title = [...document.querySelectorAll(".canvas .region")].find((r) =>
    (r.textContent || "").includes("Opening")
  );
  title.focus();
  title.textContent = "Opening, revised";
  title.dispatchEvent(new InputEvent("input", { bubbles: true }));
});
await page.click(".tab.private[data-doc='companion:instructorguide.md']");
await page.evaluate(() => {
  // The guide's editor: type at the end of the document.
  const el = document.querySelector("#document [contenteditable='true'], #document textarea");
  if (el.tagName === "TEXTAREA") {
    el.value += "\nAsk who could re-identify the record.\n";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    el.focus();
    document.execCommand("insertText", false, " Ask who could re-identify the record.");
  }
});
await page.waitForTimeout(400);
const mixedDirty = await page.textContent("#dirty");
// The ribbon acts on mousedown (so a click cannot steal the selection).
await page.evaluate(() => document.getElementById("save").dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
for (let i = 0; i < 150 && commits.length < before + 2; i++) await page.waitForTimeout(100);
await page.waitForFunction(() => document.getElementById("dirty").textContent === "no changes", null, { timeout: 15000 });
const mixed = commits.slice(before);
console.log("mixed dirty:", mixedDirty, "commits:", JSON.stringify(mixed));

// ---- refusals ------------------------------------------------------
const tryConnect = async (name) => {
  await page.evaluate(() => {
    const form = document.getElementById("companion-form");
    if (form.hidden) document.getElementById("companion-toggle").click();
  });
  await page.fill("#companion-repo", name);
  await page.click("#companion-connect");
  await page.waitForTimeout(800);
  return page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    still: document.getElementById("companion-toggle").textContent,
  }));
};
const refusedPublic = await tryConnect("t/public-answers");
const refusedOther = await tryConnect("t/other-private");
const refusedSelf = await tryConnect("t/lib");
console.log("refused:", JSON.stringify([refusedPublic, refusedOther, refusedSelf]));

// ---- reload: the pairing reconnects, an unsaved private edit returns --
await page.click(".tab.private[data-doc='companion:questions.yaml']");
await page.waitForSelector(".questions-editor textarea");
await page.fill(".questions-editor textarea",
  (await page.inputValue(".questions-editor textarea")) + "  - {id: q-03, type: truefalse, assesses: [O1], stem: Unsaved., answer: true}\n");
await page.waitForTimeout(900); // past the draft's debounce
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#signed-in:not([hidden]), #workspace:not([hidden])", { timeout: 15000 });
if (await page.isHidden("#workspace")) {
  await page.fill("#manual-repo", "t/lib");
  await page.click("#open-manual");
}
await page.waitForSelector(".tab.private", { timeout: 15000 });
const reopened = await page.evaluate(() => ({
  toggle: document.getElementById("companion-toggle").textContent,
  dirty: document.getElementById("dirty").textContent,
}));
console.log("reopened:", JSON.stringify(reopened));

const contents = [...blobs.values()].filter((b) => b.content !== undefined);

if (errors.length) console.log("errors:", errors.slice(0, 5));
const libCommits = commits.filter((c) => c.repo === "t/lib");
const privCommits = commits.filter((c) => c.repo === "t/lib-private");
const failed =
  errors.length > 0 ||
  !connected.toggle.includes("t/lib-private") ||
  JSON.stringify(connected.tabs.filter((t) => t[1])) !==
    JSON.stringify([["Questions", true, false], ["Instructor guide", true, false]]) ||
  !bank.text.includes("q-01") || !/1 question/.test(bank.verdict) || !/private companion/.test(bank.note || "") ||
  !/unknown outcome O7/.test(flagged) ||
  !/2 files changed \(2 private\)/.test(dirty) || !libraryUntouched ||
  libCommits.length !== 1 ||
  privCommits.length !== 2 ||
  JSON.stringify(privCommits[0].paths.sort()) !==
    JSON.stringify(["blocks/01-misuse/instructorguide.md", "blocks/01-misuse/questions.yaml"]) ||
  !contents.some((b) => b.repo === "t/lib-private" && b.content.includes("q-02")) ||
  contents.some((b) => b.repo === "t/lib" && /q-0|re-identify the record/.test(b.content)) ||
  after.dirty !== "no changes" ||
  !/2 files changed \(1 private\)/.test(mixedDirty) ||
  mixed.length !== 2 ||
  JSON.stringify(mixed.find((c) => c.repo === "t/lib")?.paths) !== JSON.stringify(["blocks/01-misuse/slides.md"]) ||
  JSON.stringify(mixed.find((c) => c.repo === "t/lib-private")?.paths) !== JSON.stringify(["blocks/01-misuse/instructorguide.md"]) ||
  !/is public/.test(refusedPublic.status) ||
  !/belongs to t\/another-course/.test(refusedOther.status) ||
  !/different repository/.test(refusedSelf.status) ||
  // A refused connection leaves the working one in place.
  !refusedSelf.still.includes("t/lib-private") ||
  !reopened.toggle.includes("t/lib-private") ||
  reopened.dirty !== "1 file changed (1 private)";
console.log(failed ? "FAIL" : "PASS");
await browser.close();
process.exit(failed ? 1 : 0);
