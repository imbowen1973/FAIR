// SmartArt is displayed, not edited: the workbench draws the content tree
// as the Mermaid diagram that means the same thing, picked by family.
// These hold the mapping; ../smartart.js does the drawing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { smartartToMermaid, smartartNodes } from "../smartart.js";

const body = (src) => src.split("\n").slice(1); // drop the theme directive

test("each family picks its own diagram form", () => {
  const nodes = ["A", "B", "C"];
  const kind = (family) => body(smartartToMermaid({ family, nodes }))[0];
  assert.equal(kind("process"), "flowchart LR");
  assert.equal(kind("cycle"), "flowchart LR");
  assert.equal(kind("hierarchy"), "flowchart TB");
  assert.equal(kind("list"), "flowchart TB");
  assert.equal(kind("relationship"), "flowchart LR");
  assert.equal(kind("matrix"), "block-beta");
  assert.equal(kind("pyramid"), "block-beta");
  assert.equal(kind("something-new"), "flowchart TB"); // drawn as a list
});

test("a process is a chain; a cycle closes back on its start", () => {
  const process = body(smartartToMermaid({ family: "process", nodes: ["A", "B", "C"] }));
  assert.ok(process.includes("  n0 --> n1 --> n2"));
  const cycle = body(smartartToMermaid({ family: "cycle", nodes: ["A", "B", "C"] }));
  assert.ok(cycle.includes("  n0 --> n1 --> n2 --> n0"));
});

test("a hierarchy draws every level, assistants dotted", () => {
  const src = smartartToMermaid({
    family: "hierarchy",
    nodes: [{ text: "Head", items: ["One", { text: "Aide", assistant: true }] }],
  });
  assert.match(src, /n0 --> n1/);
  assert.match(src, /n0 -\.- n2/);
});

test("sub-points ride inside their step, not as steps of their own", () => {
  const src = smartartToMermaid({
    family: "process",
    nodes: [{ text: "Receive", items: ["Check logger"] }, "Store"],
  });
  assert.match(src, /n0\["<b>Receive<\/b><br\/>• Check logger"\]/);
  assert.ok(!/n2/.test(src));
});

test("a single centre with spokes reads as a mind map", () => {
  const src = smartartToMermaid({
    family: "relationship",
    nodes: [{ text: "Hub", items: ["a", "b"] }],
  });
  assert.equal(body(src)[0], "mindmap");
  assert.match(src, /root\(\("Hub"\)\)/);
});

test("a pyramid widens by two columns a level", () => {
  const src = body(smartartToMermaid({ family: "pyramid", nodes: ["Top", "Mid", "Base"] }));
  assert.equal(src[1], "  columns 5");
  assert.equal(src[2], '  space:2 n0["Top"]:1 space:2');
  assert.equal(src[4], '  n2["Base"]:5');
});

test("text is made safe for Mermaid: quotes, markup, line breaks", () => {
  const src = smartartToMermaid({
    family: "list",
    nodes: ['Say "hi" to **2–8 °C**\nnext line', "a <b>tag</b>"],
  });
  assert.match(src, /Say #quot;hi#quot; to 2–8 °C<br\/>next line/);
  assert.match(src, /a #lt;b#gt;tag#lt;\/b#gt;/);
});

test("nodes normalise whatever the YAML spelled", () => {
  assert.deepEqual(smartartNodes({ nodes: ["x", { text: "y", items: ["z"] }, 3] }), [
    { text: "x", items: [], assistant: false },
    { text: "y", items: [{ text: "z", items: [], assistant: false }], assistant: false },
    { text: "3", items: [], assistant: false },
  ]);
  assert.deepEqual(smartartNodes({}), []);
});

test("the theme's colours reach the drawing", () => {
  const src = smartartToMermaid({ family: "list", nodes: ["a"] }, { accent1: "#123456" });
  assert.match(src.split("\n")[0], /"primaryColor":"#123456"/);
});
