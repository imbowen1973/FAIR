// The wrapper contract, tested without a browser: origin parsing and
// auth-message validation are pure, and connectHost takes its window.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseHostOrigin, readAuth, connectHost } from "../host.js";

test("parseHostOrigin accepts https origins, only when embedded", () => {
  assert.equal(
    parseHostOrigin("?host=https://portal.example.org", true),
    "https://portal.example.org"
  );
  // A full URL is reduced to its origin.
  assert.equal(
    parseHostOrigin("?host=https://portal.example.org/some/page", true),
    "https://portal.example.org"
  );
  // Not embedded: the parameter alone must not switch modes.
  assert.equal(parseHostOrigin("?host=https://portal.example.org", false), null);
  assert.equal(parseHostOrigin("", true), null);
});

test("parseHostOrigin rejects http except on localhost", () => {
  assert.equal(parseHostOrigin("?host=http://portal.example.org", true), null);
  assert.equal(
    parseHostOrigin("?host=http://localhost:5173", true),
    "http://localhost:5173"
  );
  assert.equal(parseHostOrigin("?host=not-a-url", true), null);
});

test("readAuth takes only a well-formed auth message", () => {
  assert.deepEqual(readAuth({ type: "edufair:auth", token: "t", login: "ada" }), {
    token: "t",
    login: "ada",
    repo: null,
  });
  assert.equal(readAuth({ type: "edufair:auth", token: "" }), null);
  assert.equal(readAuth({ type: "edufair:auth" }), null);
  assert.equal(readAuth({ type: "something-else", token: "t" }), null);
  assert.equal(readAuth("edufair:auth"), null);
});

function fakeWindow() {
  const listeners = [];
  const posted = [];
  return {
    addEventListener: (kind, fn) => kind === "message" && listeners.push(fn),
    parent: { postMessage: (data, origin) => posted.push({ data, origin }) },
    deliver: (origin, data) => listeners.forEach((fn) => fn({ origin, data })),
    posted,
  };
}

test("connectHost announces ready, takes auth only from its origin", async () => {
  const win = fakeWindow();
  const host = connectHost({ origin: "https://portal.example.org", win, version: "x1" });

  assert.deepEqual(win.posted[0], {
    data: { type: "edufair:ready", version: "x1" },
    origin: "https://portal.example.org",
  });

  // A message from anywhere else is ignored entirely.
  win.deliver("https://evil.example.org", { type: "edufair:auth", token: "stolen" });
  assert.equal(host.token(), null);

  win.deliver("https://portal.example.org", {
    type: "edufair:auth",
    token: "good",
    login: "ada",
    repo: "org/lib",
  });
  const auth = await host.waitForAuth();
  assert.equal(auth.token, "good");
  assert.equal(auth.repo, "org/lib");
  assert.equal(host.token(), "good");
});

test("connectHost rotates tokens through onAuth, and emits are origin-pinned", () => {
  const win = fakeWindow();
  const host = connectHost({ origin: "https://portal.example.org", win });
  win.deliver("https://portal.example.org", { type: "edufair:auth", token: "one" });

  const rotations = [];
  host.onAuth((a) => rotations.push(a.token));
  win.deliver("https://portal.example.org", { type: "edufair:auth", token: "two" });
  assert.deepEqual(rotations, ["two"]);
  assert.equal(host.token(), "two");

  host.emit("saved", { sha: "abc" });
  const last = win.posted.at(-1);
  assert.equal(last.origin, "https://portal.example.org");
  assert.deepEqual(last.data, { type: "edufair:saved", sha: "abc" });
});
