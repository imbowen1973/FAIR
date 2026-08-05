import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildInsertPlan,
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
