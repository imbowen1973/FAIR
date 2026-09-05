import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  arrayBufferToBase64,
  buildInsertPlan,
  buildTree,
  groupBySource,
  isRepoUrl,
  searchCatalog,
  joinUrl,
  normalizeSource,
  slidesForCompetency,
  usedCompetencies,
} from "../web/assembler.js";

const FIXTURE = {
  sessions: [
    { sessionId: "01", title: "One", pptx: "sessions/01/session-01.pptx" },
    { sessionId: "03", title: "Three", pptx: "sessions/03/session-03.pptx" },
  ],
  competencies: { C1: "Cold chain monitoring", C3: "Audit preparation" },
  slides: [
    {
      slideId: "s01-03",
      sessionId: "01",
      sourceRef: "258#807997854",
      sourcePptx: "sessions/01/session-01.pptx",
      title: "Cold chain integrity",
      develops: ["C1", "C4"],
      dok: 2,
    },
    {
      slideId: "s03-02",
      sessionId: "03",
      sourceRef: "257#901",
      sourcePptx: "sessions/03/session-03.pptx",
      title: "Detecting an excursion",
      develops: ["C1"],
      dok: 3,
    },
    {
      slideId: "s03-03",
      sessionId: "03",
      sourceRef: "258#902",
      sourcePptx: "sessions/03/session-03.pptx",
      title: "The excursion report",
      develops: ["C3"],
      dok: 2,
    },
  ],
};

test("slidesForCompetency groups matches by source deck (spec B.2)", () => {
  const groups = slidesForCompetency(FIXTURE, "C1");
  assert.equal(groups.size, 2);
  assert.deepEqual(
    groups.get("sessions/01/session-01.pptx").map((s) => s.slideId),
    ["s01-03"]
  );
  assert.deepEqual(
    groups.get("sessions/03/session-03.pptx").map((s) => s.slideId),
    ["s03-02"]
  );
});

test("slidesForCompetency returns empty map for unknown competency", () => {
  assert.equal(slidesForCompetency(FIXTURE, "C99").size, 0);
});

test("usedCompetencies lists only referenced competencies, labeled", () => {
  const used = usedCompetencies(FIXTURE);
  assert.deepEqual(
    used.map((c) => c.id),
    ["C1", "C3", "C4"]
  );
  assert.equal(used[0].label, "Cold chain monitoring");
  assert.equal(used[2].label, "C4"); // unlabeled falls back to id
});

test("buildInsertPlan carries sourceRefs and drops deselected slides", () => {
  const groups = slidesForCompetency(FIXTURE, "C1");
  const plan = buildInsertPlan(groups, new Set(["s03-02"]));
  assert.equal(plan.length, 1);
  assert.equal(plan[0].sourcePptx, "sessions/03/session-03.pptx");
  assert.deepEqual(plan[0].sourceRefs, ["257#901"]);
});

test("normalizeSource strips data/catalog.json down to the site root", () => {
  for (const given of [
    "https://corpus.example/lib/data/catalog.json",
    "https://corpus.example/lib/data/",
    "https://corpus.example/lib",
  ]) {
    assert.deepEqual(normalizeSource(given), {
      name: "corpus.example/lib",
      url: "https://corpus.example/lib",
    });
  }
});

test("parseRepoInput handles slugs and github URLs", async () => {
  const { parseRepoInput } = await import("../web/assembler.js");
  assert.deepEqual(parseRepoInput("Agrifoodskills/Clinical-Educator-"), {
    owner: "Agrifoodskills",
    repo: "Clinical-Educator-",
  });
  assert.deepEqual(parseRepoInput("https://github.com/o/r.git"), { owner: "o", repo: "r" });
  assert.equal(parseRepoInput("https://gitlab.com/o/r"), null);
  assert.equal(parseRepoInput("https://corpus.example/lib"), null);
  assert.equal(parseRepoInput("not a repo"), null);
});

test("selectLibraryPaths picks library files and rejects non-libraries", async () => {
  const { selectLibraryPaths } = await import("../web/wasm-renderer.js");
  const picked = selectLibraryPaths([
    "README.md",
    "template.pptx",
    "layout-map.yaml",
    "sessions/ce-01.md",
    "sessions/assets/x.png",
    "competencies/framework.yaml",
    "credentials/clinical-educator.yaml",
    ".github/workflows/ci.yml",
  ]);
  assert.ok(picked.includes("sessions/ce-01.md"));
  assert.ok(picked.includes("sessions/assets/x.png"));
  assert.ok(picked.includes("credentials/clinical-educator.yaml"));
  assert.ok(!picked.includes("README.md"));
  assert.ok(!picked.includes(".github/workflows/ci.yml"));

  assert.throws(
    () => selectLibraryPaths(["README.md", "src/app.js"]),
    /not a library repo/
  );
});

test("normalizeSource accepts only https URLs — no repo slugs", () => {
  assert.equal(normalizeSource(""), null);
  assert.equal(normalizeSource("   "), null);
  assert.equal(normalizeSource("http://insecure.example/data"), null);
  assert.equal(normalizeSource("not a url at all"), null);
  // a bare owner/repo slug is a git reference, not a corpus server
  assert.equal(normalizeSource("imbowen1973/FAIR"), null);
  assert.equal(normalizeSource("Agrifoodskills/Clinical-Educator-"), null);
});

test("joinUrl keeps relative paths for the default source", () => {
  assert.equal(joinUrl("", "data/catalog.json"), "data/catalog.json");
  assert.equal(
    joinUrl("https://x.github.io/FAIR", "data/sessions/01/session-01.pptx"),
    "https://x.github.io/FAIR/data/sessions/01/session-01.pptx"
  );
});

test("real catalog: C1 spans sessions 01 and 03 (build order step 5)", (t) => {
  const catalogPath = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "web",
    "data",
    "catalog.json"
  );
  if (!existsSync(catalogPath)) {
    t.skip("catalog.json not built — run scripts/build_corpus.py");
    return;
  }
  const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
  const groups = slidesForCompetency(catalog, "C1");
  if (groups.size === 0) {
    // web/data is whichever library was last built there (see
    // scripts/pull_library.py); only the examples corpus defines C1.
    t.skip("another library is built — run scripts/build_corpus.py for the examples");
    return;
  }
  const sessions = new Set(
    [...groups.values()].flat().map((s) => s.sessionId)
  );
  assert.ok(sessions.has("01") && sessions.has("03"), "C1 must span sessions 01 and 03");
  for (const slides of groups.values()) {
    for (const s of slides) {
      assert.match(s.sourceRef, /^\d+#\d+$/);
    }
  }
});

test("a git repo URL is not a corpus server", () => {
  // The pane fetches <base>/data/catalog.json; a repo serves HTML and
  // holds only markdown, so this must fail at validation, not as CORS.
  for (const repo of [
    "https://github.com/Agrifoodskills/Clinical-Educator-",
    "https://github.com/Agrifoodskills/Clinical-Educator-.git",
    "https://www.github.com/org/lib",
    "https://gitlab.com/org/lib",
    "https://bitbucket.org/org/lib",
    "Agrifoodskills/Clinical-Educator-",
  ]) {
    assert.equal(isRepoUrl(repo), true, repo);
    assert.equal(normalizeSource(repo), null, repo);
  }
});

test("corpus servers are still accepted, including Pages hosts", () => {
  for (const ok of [
    "https://corpus.example/lib",
    "https://agrifoodskills.github.io/Clinical-Educator-",
  ]) {
    assert.equal(isRepoUrl(ok), false, ok);
    assert.notEqual(normalizeSource(ok), null, ok);
  }
});

// --- hierarchy -----------------------------------------------------------

const NESTED = {
  sessions: [
    { sessionId: "ce-01", title: "Foundations", durationMinutes: 180 },
    { sessionId: "ce-02", title: "Feedback", durationMinutes: 180 },
    { sessionId: "ce-99", title: "Orphan session", durationMinutes: 30 },
  ],
  competencies: { CE1: "Designing clinical teaching" },
  credentials: [
    {
      id: "clinical-educator",
      title: "Clinical Educator",
      ects: 5,
      modules: [
        {
          title: "Foundations",
          days: [
            {
              title: "Day 1",
              blocks: [
                { title: "Morning", sessions: ["ce-01"] },
                { title: "Afternoon", sessions: ["ce-02"] },
              ],
            },
          ],
        },
      ],
    },
  ],
  slides: [
    { slideId: "a", sessionId: "ce-01", sourcePptx: "d1.pptx", sourceRef: "1#1", title: "Why the clinic is not a classroom", develops: ["CE1"], dok: 2, notes: "Contrast andragogy with clinical reality; feedback comes later." },
    { slideId: "b", sessionId: "ce-02", sourcePptx: "d2.pptx", sourceRef: "2#2", title: "Feedback that lands", develops: [], dok: 3, notes: "Potassium rises fast in an obstructed cat." },
    { slideId: "c", sessionId: "ce-99", sourcePptx: "d3.pptx", sourceRef: "3#3", title: "Loose end", develops: [], dok: null, notes: null },
  ],
};

const FLAT = {
  sessions: [{ sessionId: "ce-01", title: "Foundations" }],
  competencies: {},
  credentials: [{ id: "x", title: "Flat course", modules: [{ title: "Module A", sessions: ["ce-01"] }] }],
  slides: [
    { slideId: "a", sessionId: "ce-01", sourcePptx: "d1.pptx", sourceRef: "1#1", title: "One", develops: [], dok: null, notes: null },
  ],
};

const kinds = (node) => {
  const out = [];
  const go = (n) => { out.push(n.kind); (n.children || []).forEach(go); };
  go(node);
  return out;
};

test("buildTree nests credential > module > day > block > session > slide", () => {
  const [cred] = buildTree(NESTED);
  assert.equal(cred.kind, "credential");
  assert.equal(cred.title, "Clinical Educator");
  assert.equal(cred.meta.ects, 5);
  assert.deepEqual(kinds(cred).slice(0, 6), [
    "credential", "module", "day", "block", "session", "slide",
  ]);
  // Containers aggregate the slide ids of everything beneath them.
  assert.deepEqual(cred.slideIds, ["a", "b"]);
});

test("buildTree collapses absent levels for a flat modules[].sessions[]", () => {
  const [cred] = buildTree(FLAT);
  assert.deepEqual(kinds(cred), ["credential", "module", "session", "slide"]);
  assert.deepEqual(cred.slideIds, ["a"]);
});

test("buildTree puts sessions no credential claims under Unassigned", () => {
  const roots = buildTree(NESTED);
  const last = roots[roots.length - 1];
  assert.equal(last.title, "Unassigned sessions");
  assert.deepEqual(last.slideIds, ["c"]);
});

test("buildTree with no credentials still browses every session", () => {
  const { credentials, ...noCreds } = NESTED;
  const roots = buildTree(noCreds);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].title, "All sessions");
  assert.deepEqual(roots[0].slideIds, ["a", "b", "c"]);
});

// --- search --------------------------------------------------------------

test("searchCatalog matches speaker notes, not just titles", () => {
  const hits = searchCatalog(NESTED, "potassium");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].slideId, "b");
  assert.equal(hits[0].field, "notes");
  assert.match(hits[0].snippet, /Potassium rises fast/);
});

test("searchCatalog ranks a title hit above a notes hit", () => {
  // "feedback" is slide b's title and appears in slide a's notes.
  const hits = searchCatalog(NESTED, "feedback");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => [h.slideId, h.field]), [
    ["b", "title"],
    ["a", "notes"],
  ]);
});

test("searchCatalog is empty for a blank query and tolerates null notes", () => {
  assert.deepEqual(searchCatalog(NESTED, "   "), []);
  assert.deepEqual(searchCatalog(NESTED, "zzzznotfound"), []);
});

test("groupBySource output feeds buildInsertPlan unchanged", () => {
  const chosen = NESTED.slides.filter((s) => ["a", "b"].includes(s.slideId));
  const plan = buildInsertPlan(groupBySource(chosen), new Set(["a", "b"]));
  assert.deepEqual(plan.map((p) => p.sourcePptx), ["d1.pptx", "d2.pptx"]);
  assert.deepEqual(plan.flatMap((p) => p.sourceRefs), ["1#1", "2#2"]);
});


test("sessions the course does not place are marked, not disguised", () => {
  // load_library gathers unplaced blocks into a node of its own making
  // and flags it. Carrying the flag is what stops the pane listing
  // "Unplaced blocks" among the author's modules, looking exactly like
  // one of them -- which is how it was reported.
  const catalog = {
    structure: [
      { kind: "module", title: "Foundations", children: [{ kind: "block", block: "01" }] },
      {
        kind: "group",
        title: "Not in the running order",
        unplaced: true,
        children: [{ kind: "block", block: "02" }],
      },
    ],
    blocks: [
      { blockId: "01", resources: [] },
      { blockId: "02", resources: [] },
    ],
    sessions: [
      { sessionId: "s1", blockId: "01" },
      { sessionId: "s2", blockId: "02" },
    ],
    slides: [
      { slideId: "s1-1", sessionId: "s1", title: "One" },
      { slideId: "s2-1", sessionId: "s2", title: "Two" },
    ],
  };

  const roots = buildTree(catalog);
  assert.equal(roots.length, 2);
  assert.equal(roots[0].title, "Foundations");
  assert.equal(roots[0].meta.unplaced, undefined, "an authored module must not be flagged");
  assert.equal(roots[1].meta.unplaced, true);
  // Still fully usable: unplaced is a drafting state, not a quarantine.
  assert.deepEqual(roots[1].slideIds, ["s2-1"]);
});


test("the branches offered, and the published one marked", async () => {
  // A library nobody has drafted in has one branch and gets no picker;
  // the interesting case is the second branch, which is where the
  // workbench saves and which the add-in could not read at all.
  const { fetchBranches } = await import("../web/wasm-renderer.js");
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes("/branches")
        ? [{ name: "main" }, { name: "draft/ada" }]
        : { default_branch: "main" },
  });
  try {
    assert.deepEqual(await fetchBranches("o", "r"), [
      { name: "main", isDefault: true },
      { name: "draft/ada", isDefault: false },
    ]);
  } finally {
    globalThis.fetch = real;
  }
});

test("a library that cannot be listed offers no branches, and does not throw", async () => {
  // A private repo or a rate limit. Not being able to offer a choice is
  // not a reason to fail before anything has been rendered.
  const { fetchBranches } = await import("../web/wasm-renderer.js");
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  try {
    assert.deepEqual(await fetchBranches("o", "r"), []);
  } finally {
    globalThis.fetch = real;
  }
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    assert.deepEqual(await fetchBranches("o", "r"), []);
  } finally {
    globalThis.fetch = real;
  }
});


test("a deck is encoded as the file, not as the buffer it sits in", async () => {
  // A filesystem read hands back a view into a larger buffer — Pyodide's
  // does — and reaching for `.buffer` encoded everything around the file
  // as well as the file. PowerPoint answers a .pptx with foreign bytes
  // wrapped round it by offering to repair it, which is what every deck
  // the pane assembled was doing.
  const store = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const file = store.subarray(2, 6);

  const decode = (b64) =>
    [...Buffer.from(b64, "base64").values()];

  assert.deepEqual(decode(arrayBufferToBase64(file)), [2, 3, 4, 5]);

  // A real ArrayBuffer still works, which is the other caller.
  const whole = new Uint8Array([9, 8, 7]).buffer;
  assert.deepEqual(decode(arrayBufferToBase64(whole)), [9, 8, 7]);
});

test("a big deck survives the chunking", async () => {
  // The chunk exists because String.fromCharCode.apply has an argument
  // limit; a deck is megabytes, so the boundary is crossed every time.
  const size = 0x8000 * 3 + 17;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 256;
  const back = Buffer.from(arrayBufferToBase64(bytes), "base64");
  assert.equal(back.length, size);
  assert.ok(back.equals(Buffer.from(bytes)), "bytes changed crossing a chunk boundary");

  // ...and the same when it is a view, which is the case that broke.
  const padded = new Uint8Array(size + 64);
  padded.set(bytes, 32);
  const view = padded.subarray(32, 32 + size);
  const fromView = Buffer.from(arrayBufferToBase64(view), "base64");
  assert.ok(fromView.equals(Buffer.from(bytes)));
});
