// Setting up a repo that already exists.
//
// The common way to start is to make the repo on GitHub first and then
// look for somewhere to fill it. That arrives in one of two states and
// both are ordinary:
//
//   no commits at all  — the Git Data API refuses the repository
//                        outright: POST /git/blobs answers 409 "Git
//                        Repository is empty". It has to be bootstrapped
//                        through PUT /contents/<path>, which creates the
//                        first commit and the branch, and only then can
//                        the rest be written normally.
//   a README           — a normal repo that simply is not a library.
//
// The first of those reached a user as a raw 409 because this mock was
// written to what I believed rather than to what GitHub does: it handed
// out blob shas for a repository with no commits. A mock that agrees
// with the code it is checking proves nothing.
//
// Neither may lose what is already there, and neither may be told to go
// and read the format documentation.
//
//   node tests/setup-existing-check.mjs
//
// Needs a site-shaped build with seed/ (see create-check.mjs).

import { chromium } from "playwright-core";

const BASE = process.env.WB || "http://localhost:8898/workbench/";

/**
 * Drive the whole flow against a repo in a given starting state.
 * `existing` is a map of path -> content already in the repo; an empty
 * map means a repo with no commits.
 */
async function run(browser, label, existing, canPush = true) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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

  const empty = existing.size === 0;
  const calls = {
    blobs: [], trees: [], commits: [], refPost: [], refPatch: [], contentsPut: [],
  };
  // What the repo holds: what it started with, plus whatever is committed.
  const contents = new Map(existing);

  await page.route("https://api.github.com/**", (route) => {
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
    if (url.includes("/user/repos")) return json([]);
    if (/\/repos\/tester\/[^/]+$/.test(url) && method === "GET") {
      return json({ default_branch: "main", permissions: { push: canPush } });
    }

    // An empty repository: no ref, and the tree is a 409.
    if (url.includes("/git/ref/heads/")) {
      return calls.contentsPut.length || !empty
        ? json({ object: { sha: "parent1" } })
        : json({ message: "Not Found" }, 404);
    }
    if (url.includes("/git/trees/")) {
      if (empty && !calls.contentsPut.length) {
        return json({ message: "Git Repository is empty." }, 409);
      }
      return json({
        truncated: false,
        tree: [...contents.keys()].map((p) => ({ path: p, type: "blob" })),
      });
    }

    // What GitHub really does, and what this mock used to get wrong:
    // the Git Data API refuses everything until a repository has one
    // commit. Believing otherwise is how "Git Repository is empty" first
    // reached a user instead of this check.
    const noCommitsYet = empty && !calls.contentsPut.length;
    if (url.includes("/git/blobs") && method === "POST") {
      if (noCommitsYet) return json({ message: "Git Repository is empty." }, 409);
      calls.blobs.push(body());
      return json({ sha: `blob${calls.blobs.length}` });
    }
    // The one call that works on an empty repository: it creates the
    // blob, the tree, the commit and the branch together.
    if (url.includes("/contents/") && method === "PUT") {
      const put = body();
      const path = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
      calls.contentsPut.push({ path, branch: put.branch });
      contents.set(path, "(bootstrap)");
      return json({ commit: { sha: "bootstrap1" } }, 201);
    }
    if (url.includes("/git/trees") && method === "POST") {
      const t = body();
      calls.trees.push(t);
      t.tree.forEach((entry, i) => {
        const blob = calls.blobs[calls.blobs.length - t.tree.length + i];
        contents.set(entry.path, blob?.encoding === "base64" ? "(binary)" : blob?.content ?? "");
      });
      return json({ sha: "tree1" });
    }
    if (url.includes("/git/commits") && method === "POST") {
      calls.commits.push(body());
      return json({ sha: "commit1" });
    }
    if (url.includes("/git/commits/")) return json({ tree: { sha: "base" } });
    if (url.includes("/git/refs") && method === "POST") {
      calls.refPost.push(body());
      return json({});
    }
    if (url.includes("/git/refs/heads/") && method === "PATCH") {
      calls.refPatch.push(body());
      return json({});
    }
    return json({});
  });

  await page.route("https://raw.githubusercontent.com/**", (route) => {
    const path = decodeURIComponent(route.request().url().split("/main/")[1] ?? "");
    return contents.has(path)
      ? route.fulfill({ status: 200, contentType: "text/plain", body: contents.get(path) })
      : route.fulfill({ status: 404, body: "" });
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("#pat", "x");
  await page.click("#pat-signin");
  await page.waitForSelector("#signed-in:not([hidden])", { timeout: 15000 });

  // Open it by name. It is not a library, so the offer must appear —
  // rather than an error telling the author to go and read the format.
  await page.fill("#manual-repo", "tester/half-made");
  await page.click("#open-manual");
  await page.waitForTimeout(1200);

  const offer = await page.evaluate(() => {
    const b = document.getElementById("setup-repo");
    const box = document.getElementById("setup-offer");
    if (!b || box.hidden) return { shown: false };
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      shown: true,
      label: b.textContent.trim(),
      says: document.getElementById("status").textContent,
      clickable: hit === b || b.contains(hit),
    };
  });

  if (!offer.shown) {
    // Nothing more to drive: refusing to offer is the whole behaviour
    // being checked here.
    const said = await page.textContent("#status");
    await page.close();
    return { label, offer: { ...offer, says: said }, refused: true, errors };
  }

  await page.click("#setup-repo");
  await page.waitForTimeout(200);
  const form = await page.evaluate(() => ({
    // The repository is already decided, so asking for its name again
    // would be a question with exactly one answer.
    repoFieldHidden: document.getElementById("new-repo-field").hidden,
    title: document.getElementById("new-title").value,
    button: document.getElementById("create-library").textContent.trim(),
  }));

  await page.fill("#new-title", "Half Made Module");
  await page.fill("#new-block", "First session");
  await page.click("#create-library");
  await page.waitForTimeout(2500);

  const added = (calls.trees[0]?.tree ?? []).map((t) => t.path).sort();
  const result = {
    label,
    offer,
    form,
    added,
    // An empty repository is bootstrapped through the Contents API,
    // because the Git Data API refuses it outright.
    bootstrapped: calls.contentsPut.map((c) => c.path),
    parents: calls.commits[0]?.parents ?? null,
    baseTree: calls.trees[0]?.base_tree ?? null,
    refCreated: calls.refPost.length,
    refMoved: calls.refPatch.length,
    kept: [...existing.keys()].every((p) => contents.get(p) === existing.get(p)),
    opened: await page.isVisible("#workspace"),
    errors,
  };
  await page.close();
  return result;
}

const browser = await chromium.launch({ channel: "msedge" });

const emptyRepo = await run(browser, "no commits at all", new Map());

// A token that cannot push must be told before a form is filled in, not
// after the seed has been fetched and the first write has failed.
const readOnly = await run(browser, "no push rights", new Map(), false);
const withReadme = await run(
  browser,
  "a README somebody wrote",
  new Map([["README.md", "# Half made\n\nMine, not yours.\n"], [".gitignore", "*.pyc\n"]])
);

console.log(String.fromCharCode(10) + "--- read-only token ---");
console.log("offer shown:", readOnly.offer.shown, "| said:", JSON.stringify(readOnly.offer.says));

for (const r of [emptyRepo, withReadme]) {
  console.log(`\n--- ${r.label} ---`);
  console.log("offer:", JSON.stringify(r.offer));
  console.log("form:", JSON.stringify(r.form));
  console.log("added:", r.added.length, "files");
  for (const p of r.added) console.log("   ", p);
  console.log(
    "bootstrapped via contents:", JSON.stringify(r.bootstrapped),
    "| parents:", JSON.stringify(r.parents),
    "| base_tree:", JSON.stringify(r.baseTree),
    "| ref created:", r.refCreated, "moved:", r.refMoved
  );
  console.log("what was there is untouched:", r.kept, "| opened:", r.opened);
  if (r.errors.length) console.log("errors:", r.errors.slice(0, 4));
}

const failed =
  emptyRepo.errors.length > 0 ||
  withReadme.errors.length > 0 ||
  readOnly.errors.length > 0 ||
  // A token that cannot push must be told before any of this starts.
  !readOnly.refused ||
  !readOnly.offer.says.includes("cannot push") ||
  // The offer, not an error message.
  !emptyRepo.offer.shown || !emptyRepo.offer.clickable ||
  !withReadme.offer.shown ||
  !emptyRepo.offer.says.includes("empty") ||
  !emptyRepo.offer.label.includes("tester/half-made") ||
  !emptyRepo.form.repoFieldHidden ||
  !emptyRepo.form.button.includes("tester/half-made") ||
  // An empty repo is bootstrapped through the Contents API first --
  // exactly one file, because more would be one commit each -- and the
  // rest then goes as an ordinary commit on top of it.
  emptyRepo.bootstrapped.length !== 1 ||
  emptyRepo.parents?.length !== 1 ||
  emptyRepo.baseTree === null ||
  emptyRepo.refMoved !== 1 ||
  // A repo that already has a commit needs no bootstrap at all.
  withReadme.bootstrapped.length !== 0 ||
  withReadme.parents?.length !== 1 ||
  withReadme.baseTree === null ||
  withReadme.refMoved !== 1 ||
  !withReadme.kept ||
  withReadme.added.includes("README.md") ||
  withReadme.added.includes(".gitignore") ||
  // Both end up as libraries. The empty one's README arrives through the
  // bootstrap rather than the tree, which is the whole point of it.
  ![...emptyRepo.added, ...emptyRepo.bootstrapped].includes("README.md") ||
  ![emptyRepo, withReadme].every(
    (r) =>
      r.added.includes("course.yaml") &&
      r.added.includes("template.pptx") &&
      r.added.includes("layout-geometry.json") &&
      r.added.some((p) => /^blocks\/01-.*\/block\.yaml$/.test(p)) &&
      r.opened
  );

console.log(failed ? "\nFAIL" : "\nPASS");
await browser.close();
process.exit(failed ? 1 : 0);
