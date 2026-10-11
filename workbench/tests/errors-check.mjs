// Errors an author can act on: what happened, where, and what to do --
// never a URL, a status code or git's vocabulary. The originals are kept
// for "Technical details".

import { test } from "node:test";
import assert from "node:assert/strict";

import { actionOf, explain, technical } from "../errors.js";

const JARGON = /\b(PATCH|POST|GET|PUT|409|422|403|404|fast forward|ref|heads|blob|tree)\b|\/repos\//;

test("the two errors authors actually hit read as plain English", () => {
  const empty = explain({
    status: 409, method: "GET",
    path: "/repos/Agrifoodskills/Clinical-Educator-private-/git/ref/heads/draft/imbowen1973",
    detail: "Git Repository is empty.",
  });
  assert.match(empty, /Clinical-Educator-private- is empty/);
  assert.doesNotMatch(empty, JARGON);

  const race = explain({
    status: 422, method: "PATCH",
    path: "/repos/o/r/git/refs/heads/main", detail: "Update is not a fast forward",
  });
  assert.match(race, /Someone else saved to main/);
  assert.match(race, /press Save again/);
  assert.doesNotMatch(race, JARGON);
});

test("every common failure says what to do, without jargon", () => {
  const cases = [
    { status: 0 },
    { status: 401, path: "/user" },
    { status: 403, method: "POST", path: "/repos/o/r/git/blobs" },
    { status: 404, path: "/repos/o/r" },
    { status: 404, method: "POST", path: "/repos/o/r/pulls" },
    { status: 409, method: "POST", path: "/repos/o/r/git/trees", detail: "Conflict" },
    { status: 422, method: "POST", path: "/repos/o/r/pulls", detail: "No commits between main and draft/x" },
    { status: 422, method: "POST", path: "/repos/o/r/pulls", detail: "A pull request already exists for o:draft/x." },
    { status: 502, method: "POST", path: "/repos/o/r/git/commits" },
  ];
  for (const c of cases) {
    const said = explain(c);
    assert.doesNotMatch(said, JARGON, `${JSON.stringify(c)} -> ${said}`);
    assert.ok(said.length > 30, said);
  }
  assert.match(explain({ status: 0 }), /internet connection/);
  assert.match(explain({ status: 401 }), /Sign out, then sign in/);
  assert.match(explain({ status: 403, path: "/repos/o/r/git/blobs", method: "POST" }), /Read and write/);
  assert.match(explain({ status: 404, path: "/repos/o/r" }), /o\/r wasn't found/);
  assert.match(explain({ status: 502 }), /try again/);
});

test("the action is named from the request", () => {
  assert.equal(actionOf("PATCH", "/repos/o/r/git/refs/heads/main"), "move your branch to the new version");
  assert.equal(actionOf("POST", "/repos/o/r/git/blobs"), "upload your changes");
  assert.equal(actionOf("POST", "/repos/o/r/pulls"), "open the review");
  assert.equal(actionOf("PUT", "/repos/o/r/contents/a.md"), "write the file");
});

test("the original is kept, whole, for technical details", () => {
  assert.equal(
    technical({ status: 422, method: "PATCH", path: "/repos/o/r/git/refs/heads/main", detail: "Update is not a fast forward" }),
    "PATCH /repos/o/r/git/refs/heads/main → 422: Update is not a fast forward"
  );
});

test("a Python traceback becomes one sentence, the traceback kept", async () => {
  const { pythonError } = await import("../errors.js");
  const tb = new Error(
    'Traceback (most recent call last):\n  File "<exec>", line 3, in <module>\n' +
    "edufair_renderer.render.RenderError: slide 's-04': layout 'Cards' is not in the template\n" +
    "RenderError: slide 's-04': layout 'Cards' is not in the template"
  );
  const out = pythonError(tb, "render the deck");
  assert.equal(out.message, "slide 's-04': layout 'Cards' is not in the template");
  assert.match(out.technical, /Traceback/);
});
