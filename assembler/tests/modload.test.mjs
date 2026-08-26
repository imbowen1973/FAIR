// Loading the renderer's Python modules over a network that misbehaves.
//
// A preview failed with "cannot load renderer module assets (503)" while
// every one of those files was being served correctly a moment later:
// Pages answers 503 while a deploy is going out. The loop had no retry,
// so one unlucky moment cost the whole preview and the message blamed
// the module.
//
//   node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";

import { MODULES, fetchModules } from "../web/wasm-renderer.js";

const ok = (body = "# python") => ({ ok: true, status: 200, text: async () => body });
const bad = (status) => ({ ok: false, status });

/** A fetcher that fails a given module a set number of times first. */
function flaky({ failing, times, status = 503 }) {
  const seen = new Map();
  const fetcher = async (url) => {
    const mod = url.split("/").pop().replace(/\.py$/, "");
    const n = (seen.get(mod) ?? 0) + 1;
    seen.set(mod, n);
    if (mod === failing && n <= times) return bad(status);
    return ok(`# ${mod}`);
  };
  fetcher.seen = seen;
  return fetcher;
}

const noWait = () => Promise.resolve();

test("every module is fetched, from the base it is given", async () => {
  const asked = [];
  const got = await fetchModules("py/edufair_renderer/", {
    fetcher: async (url) => {
      asked.push(url);
      return ok();
    },
    wait: noWait,
  });
  assert.equal(got.length, MODULES.length);
  assert.ok(asked.every((u) => u.startsWith("py/edufair_renderer/")));
  assert.ok(asked.includes("py/edufair_renderer/assets.py"));
  // The workbench sits one level down and must be able to say so.
  const below = [];
  await fetchModules("../py/edufair_renderer/", {
    fetcher: async (url) => {
      below.push(url);
      return ok();
    },
    wait: noWait,
  });
  assert.ok(below.includes("../py/edufair_renderer/assets.py"));
});

test("a 503 is retried, and the preview survives it", async () => {
  // Exactly the failure the author hit: one module, temporarily 503.
  const fetcher = flaky({ failing: "assets", times: 2 });
  const got = await fetchModules("py/edufair_renderer/", { fetcher, wait: noWait });
  assert.equal(got.length, MODULES.length);
  assert.equal(fetcher.seen.get("assets"), 3);
  const assets = got.find(([mod]) => mod === "assets");
  assert.equal(assets[1], "# assets");
});

test("a module that stays down says so, and says it is not the library", async () => {
  const fetcher = flaky({ failing: "render", times: 99 });
  await assert.rejects(
    () => fetchModules("py/edufair_renderer/", { fetcher, wait: noWait }),
    (err) => {
      assert.match(err.message, /render\.py answered 503/);
      assert.match(err.message, /3 attempts/);
      // The author's first instinct was to go and look at their library.
      assert.match(err.message, /nothing to do with your library/);
      return true;
    }
  );
});

test("a 404 is not retried", async () => {
  // It is not published; asking four more times will not publish it.
  const fetcher = flaky({ failing: "mermaid", times: 99, status: 404 });
  await assert.rejects(
    () => fetchModules("py/edufair_renderer/", { fetcher, wait: noWait }),
    (err) => {
      assert.match(err.message, /mermaid\.py is not published/);
      return true;
    }
  );
  assert.equal(fetcher.seen.get("mermaid"), 1);
});

test("a dropped connection is retried too", async () => {
  let n = 0;
  const fetcher = async (url) => {
    if (url.endsWith("runs.py") && ++n === 1) throw new TypeError("Failed to fetch");
    return ok();
  };
  const got = await fetchModules("py/edufair_renderer/", { fetcher, wait: noWait });
  assert.equal(got.length, MODULES.length);
  assert.equal(n, 2);
});

test("it waits longer each time rather than hammering", async () => {
  const waits = [];
  const fetcher = flaky({ failing: "parser", times: 2 });
  await fetchModules("py/edufair_renderer/", {
    fetcher,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assert.deepEqual(waits, [300, 600]);
});

test("the python is stamped with the build, like every other import", () => {
  // Unstamped, Pages' max-age=600 lets a preview mix renderer modules
  // from two builds for ten minutes after a deploy -- and produce a
  // wrong deck rather than an error, which is worse than failing.
  return (async () => {
    const asked = [];
    await fetchModules("py/edufair_renderer/", {
      stamp: "abc1234",
      fetcher: async (url) => {
        asked.push(url);
        return ok();
      },
      wait: noWait,
    });
    assert.ok(asked.every((u) => u.endsWith("?v=abc1234")), asked[0]);
    assert.ok(asked.includes("py/edufair_renderer/assets.py?v=abc1234"));

    // Served without a stamp (a local checkout), it asks plainly.
    const plain = [];
    await fetchModules("py/edufair_renderer/", {
      stamp: null,
      fetcher: async (url) => {
        plain.push(url);
        return ok();
      },
      wait: noWait,
    });
    assert.ok(plain.every((u) => !u.includes("?")), plain[0]);
  })();
});
