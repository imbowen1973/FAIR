// SmartArt, shown — not made.
//
// An imported deck's SmartArt arrives as a content tree plus the name of
// the PowerPoint layout that draws it (renderer/src/edufair_renderer/
// smartart.py). The deck gets real SmartArt back. The workbench cannot
// run PowerPoint's layout engine, and should not pretend to: what it owes
// the person looking is the MEANING — that this is a process, a cycle, a
// hierarchy — so it draws the tree as the Mermaid diagram that says the
// same thing, chosen by the layout's family.
//
// Display only. The tree is edited in the source view, like a table; the
// look is PowerPoint's, and the deck is where it is judged.

import { plainText } from "./marks.js";

// Pinned, like every other runtime dependency the workbench loads.
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

export const FAMILIES = [
  "process", "cycle", "hierarchy", "list", "relationship", "matrix", "pyramid",
];

/** A node as {text, items, assistant}, whatever the YAML spelled. */
function norm(node) {
  if (node && typeof node === "object") {
    return {
      text: String(node.text ?? ""),
      items: Array.isArray(node.items) ? node.items.map(norm) : [],
      assistant: Boolean(node.assistant),
    };
  }
  return { text: String(node ?? ""), items: [], assistant: false };
}

export function smartartNodes(value) {
  return Array.isArray(value?.nodes) ? value.nodes.map(norm) : [];
}

/** Text Mermaid will print literally: no markup, no quotes, no breaks. */
function label(text) {
  return plainText(String(text))
    .replace(/"/g, "#quot;")
    .replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"))
    .split(String.fromCharCode(10))
    .join("<br/>");
}

/** A node's own text, with its sub-points under it as bullets. */
function withPoints(node) {
  const lines = [];
  const walk = (items, depth) => {
    for (const item of items) {
      lines.push(`${"  ".repeat(depth)}• ${label(item.text)}`);
      walk(item.items, depth + 1);
    }
  };
  walk(node.items, 0);
  const head = `<b>${label(node.text)}</b>`;
  return lines.length ? `${head}<br/>${lines.join("<br/>")}` : label(node.text);
}

function themeInit(theme = {}) {
  const vars = {
    primaryColor: theme.accent1 || "#4F81BD",
    primaryTextColor: theme.lt1 || "#FFFFFF",
    primaryBorderColor: theme.accent1 || "#4F81BD",
    lineColor: theme.tx2 || theme.dk2 || "#1F497D",
    secondaryColor: theme.accent2 || "#C0504D",
    tertiaryColor: theme.bg2 || theme.lt2 || "#EEECE1",
    fontFamily: "inherit",
  };
  return `%%{init: ${JSON.stringify({ theme: "base", themeVariables: vars })}}%%`;
}

/**
 * The Mermaid source that says what this SmartArt says. Pure: the
 * family picks the form, the tree fills it.
 */
export function smartartToMermaid(value, theme) {
  const nodes = smartartNodes(value);
  const family = FAMILIES.includes(value?.family) ? value.family : "list";
  const out = [themeInit(theme)];
  let n = 0;
  const id = () => `n${n++}`;
  const single = nodes.length === 1 && nodes[0].items.length > 0 ? nodes[0] : null;

  if (family === "hierarchy") {
    out.push("flowchart TB");
    const walk = (node, parent) => {
      const me = id();
      out.push(`  ${me}["${label(node.text)}"]`);
      if (parent) out.push(node.assistant ? `  ${parent} -.- ${me}` : `  ${parent} --> ${me}`);
      for (const child of node.items) walk(child, me);
    };
    for (const node of nodes) walk(node, null);
    return out.join("\n");
  }

  if (family === "process") {
    out.push("flowchart LR");
    const ids = nodes.map((node) => {
      const me = id();
      out.push(`  ${me}["${withPoints(node)}"]`);
      return me;
    });
    if (ids.length > 1) out.push(`  ${ids.join(" --> ")}`);
    return out.join("\n");
  }

  if (family === "cycle") {
    out.push("flowchart LR");
    // A centre with spokes and a ring (radial cycle), or a plain ring.
    const ring = single ? single.items : nodes;
    const hub = single ? id() : null;
    if (hub) out.push(`  ${hub}(("${label(single.text)}"))`);
    const ids = ring.map((node) => {
      const me = id();
      out.push(`  ${me}(["${withPoints(node)}"])`);
      if (hub) out.push(`  ${hub} --- ${me}`);
      return me;
    });
    if (ids.length > 1) out.push(`  ${[...ids, ids[0]].join(" --> ")}`);
    return out.join("\n");
  }

  if (family === "relationship") {
    if (single) {
      // One idea and what surrounds it: exactly what a mind map draws.
      out.push("mindmap");
      out.push(`  root(("${label(single.text)}"))`);
      const walk = (items, depth) => {
        for (const item of items) {
          out.push(`${"  ".repeat(depth + 2)}${id()}["${label(item.text)}"]`);
          walk(item.items, depth + 1);
        }
      };
      walk(single.items, 0);
      return out.join("\n");
    }
    // Peers that overlap or relate: circles side by side, joined.
    out.push("flowchart LR");
    const ids = nodes.map((node) => {
      const me = id();
      out.push(`  ${me}(("${withPoints(node)}"))`);
      return me;
    });
    if (ids.length > 1) out.push(`  ${ids.join(" --- ")}`);
    return out.join("\n");
  }

  if (family === "matrix") {
    // A theme at the centre with its quadrants (PowerPoint's own matrix
    // shape), or a plain grid of peers.
    out.push("block-beta");
    out.push("  columns 2");
    const cells = single ? single.items : nodes;
    if (single) out.push(`  ${id()}["${label(single.text)}"]:2`);
    for (const node of cells) out.push(`  ${id()}["${withPoints(node)}"]`);
    if (cells.length % 2) out.push("  space");
    return out.join("\n");
  }

  if (family === "pyramid") {
    // Levels widening downwards: each row two columns wider than the last.
    const width = 2 * nodes.length - 1;
    out.push("block-beta");
    out.push(`  columns ${width}`);
    nodes.forEach((node, level) => {
      const span = 2 * level + 1;
      const pad = (width - span) / 2;
      const row = [];
      if (pad) row.push(`space:${pad}`);
      row.push(`${id()}["${withPoints(node)}"]:${span}`);
      if (pad) row.push(`space:${pad}`);
      out.push(`  ${row.join(" ")}`);
    });
    return out.join("\n");
  }

  // list (and anything unrecognised): blocks stacked in reading order.
  out.push("flowchart TB");
  const ids = nodes.map((node) => {
    const me = id();
    out.push(`  ${me}["${withPoints(node)}"]`);
    return me;
  });
  if (ids.length > 1) out.push(`  ${ids.join(" ~~~ ")}`);
  return out.join("\n");
}

/** The tree as an indented outline: shown while Mermaid loads, and kept
 *  if it cannot (offline, or a diagram it refuses). */
export function outline(value) {
  const list = document.createElement("ul");
  list.className = "smartart-outline";
  const walk = (items, into) => {
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = plainText(item.text);
      if (item.items.length) {
        const sub = document.createElement("ul");
        walk(item.items, sub);
        li.appendChild(sub);
      }
      into.appendChild(li);
    }
  };
  walk(smartartNodes(value), list);
  return list;
}

let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import(/* @vite-ignore */ MERMAID).then((m) => {
      const mermaid = m.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
      return mermaid;
    });
    mermaidPromise.catch(() => (mermaidPromise = null)); // allow a retry
  }
  return mermaidPromise;
}

// The canvas redraws on every keystroke; a diagram that has not changed
// is not drawn again.
const svgCache = new Map();
let serial = 0;

/**
 * Fill a region box with the SmartArt as a diagram. The outline goes in
 * at once; the drawing replaces it when Mermaid is ready.
 */
export function drawSmartArt(box, value, theme, { compact = false } = {}) {
  const frame = document.createElement("div");
  frame.className = "smartart";
  const family = FAMILIES.includes(value?.family) ? value.family : "diagram";
  frame.dataset.family = family;
  frame.title =
    `SmartArt (${value?.layout || family}). Shown here as a diagram; the deck ` +
    "gets the real SmartArt. Its text is edited in the source view.";

  const drawing = document.createElement("div");
  drawing.className = "smartart-drawing";
  frame.appendChild(drawing);

  const source = smartartToMermaid(value, theme);
  const cached = svgCache.get(source);
  if (cached) {
    drawing.innerHTML = cached;
  } else {
    drawing.appendChild(outline(value));
    loadMermaid()
      .then((mermaid) => mermaid.render(`smartart-${serial++}`, source))
      .then(({ svg }) => {
        svgCache.set(source, svg);
        drawing.innerHTML = svg;
      })
      .catch(() => {
        frame.classList.add("smartart-fallback"); // the outline stays
      });
  }

  if (!compact) {
    const badge = document.createElement("span");
    badge.className = "smartart-badge";
    badge.textContent = `SmartArt · ${family}`;
    frame.appendChild(badge);
  }
  box.appendChild(frame);
}
