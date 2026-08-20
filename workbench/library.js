// A library repo, as the editor sees it.
//
// Mirrors renderer/library.py: course.yaml is the recipe, blocks/ holds
// the content, and a block is a folder of everything taught together.
// Nothing here renders — the real renderer runs in Pyodide (preview.js).
// This is the shape the forms bind to.
//
// Slide blocks are YAML documents inside slides.md, separated by
// `--- slide` / `---`. Parsing and re-emitting them is lossy by nature
// (comments and key order are not preserved by a YAML round trip), so
// the editor only ever rewrites the slides it actually touched, splicing
// them back into the original text. An untouched slide keeps its bytes.

import { parse as parseYaml, stringify as stringifyYaml } from "./yaml.js";

export const RESERVED_SLIDE_KEYS = new Set([
  "id",
  "layout",
  "notes",
  "develops",
  "dok",
]);

export const CONTENT_TYPES = ["ul", "ol", "p", "image", "mermaid", "video"];

/** Which repo paths a library render needs — mirrors wasm-renderer.js. */
export function libraryPaths(paths) {
  return paths.filter(
    (p) =>
      p === "template.pptx" ||
      p === "layout-map.yaml" ||
      p === "attribution.yaml" ||
      p === "course.yaml" ||
      p === "layout-geometry.json" ||
      p === "competencies/framework.yaml" ||
      p.startsWith("branding/") ||
      p.startsWith("blocks/") ||
      (p.startsWith("credentials/") && p.endsWith(".yaml"))
  );
}

export function isLibrary(paths) {
  return (
    paths.includes("course.yaml") &&
    paths.some((p) => /^blocks\/[^/]+\/slides\.md$/.test(p))
  );
}

// ---- slides.md ----------------------------------------------------------

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
// [ \t]* not \s*: \s would swallow the blank line between slides, and
// every following slide would shift when one was rewritten.
const SLIDE_BLOCK = /^--- slide\r?\n([\s\S]*?)\r?\n---[ \t]*$/gm;

/**
 * Split slides.md into its frontmatter and slides, keeping each slide's
 * exact source and offsets so an untouched slide can be written back
 * byte-for-byte.
 */
export function parseSlides(text) {
  const fm = text.match(FRONTMATTER);
  const frontmatter = fm ? parseYaml(fm[1]) : {};

  const slides = [];
  SLIDE_BLOCK.lastIndex = 0;
  let match;
  while ((match = SLIDE_BLOCK.exec(text)) !== null) {
    let data;
    let error = null;
    try {
      data = parseYaml(match[1]);
    } catch (err) {
      data = {};
      error = err.message;
    }
    slides.push({
      data: data || {},
      source: match[1],
      start: match.index,
      end: match.index + match[0].length,
      error,
    });
  }
  return { frontmatter, frontmatterRaw: fm ? fm[1] : "", slides, text };
}

/**
 * Write edited slides back into the original text.
 *
 * `edits` is a Map of slide index -> new data object. Slides not in the
 * map are copied verbatim, so opening a session and saving one slide
 * produces a one-slide diff rather than a reformat of the whole file.
 */
export function writeSlides(parsed, edits) {
  if (!edits.size) return parsed.text;

  let out = "";
  let cursor = 0;
  parsed.slides.forEach((slide, index) => {
    out += parsed.text.slice(cursor, slide.start);
    if (edits.has(index)) {
      out += `--- slide\n${stringifyYaml(edits.get(index)).trimEnd()}\n---`;
    } else {
      // Verbatim: trimming here would drop the separator and shift the file.
      out += parsed.text.slice(slide.start, slide.end);
    }
    cursor = slide.end;
  });
  out += parsed.text.slice(cursor);
  return out.endsWith("\n") ? out : out + "\n";
}

/** Region keys on a slide: everything that is not reserved. */
export function slideRegions(slide) {
  return Object.keys(slide || {}).filter((k) => !RESERVED_SLIDE_KEYS.has(k));
}

/**
 * The regions a layout offers, from layout-map.yaml, in map order.
 * `_style` is a settings block, not a layout.
 */
export function layoutRegions(layoutMap, layoutKey) {
  const entry = layoutMap?.[layoutKey];
  return entry && entry.regions ? Object.keys(entry.regions) : [];
}

export function layoutKeys(layoutMap) {
  return Object.keys(layoutMap || {}).filter((k) => !k.startsWith("_"));
}

// ---- course.yaml --------------------------------------------------------

/** Flatten the recipe into rows the outline can draw. */
export function flattenStructure(structure, depth = 0, out = []) {
  for (const node of structure || []) {
    if (node.block) {
      out.push({ kind: "block", block: node.block, depth });
    } else {
      out.push({
        kind: node.kind || "group",
        title: node.title || "",
        depth,
      });
      flattenStructure(node.children, depth + 1, out);
    }
  }
  return out;
}

/** Block ids the recipe places, in order. */
export function placedBlocks(structure, out = []) {
  for (const node of structure || []) {
    if (node.block) out.push(node.block);
    else placedBlocks(node.children, out);
  }
  return out;
}

/**
 * The whole library, assembled from files already fetched.
 * `files` is a Map of path -> text.
 */
export function readLibrary(files) {
  const course = parseYaml(files.get("course.yaml") || "") || {};
  const layoutMap = parseYaml(files.get("layout-map.yaml") || "") || {};
  const framework = parseYaml(files.get("competencies/framework.yaml") || "") || {};
  const geometry = files.has("layout-geometry.json")
    ? JSON.parse(files.get("layout-geometry.json"))
    : null;

  const blocks = new Map();
  for (const [path, text] of files) {
    const m = path.match(/^blocks\/([^/]+)\/slides\.md$/);
    if (!m) continue;
    const id = m[1];
    const metaText = files.get(`blocks/${id}/block.yaml`);
    blocks.set(id, {
      id,
      meta: metaText ? parseYaml(metaText) || {} : {},
      slidesPath: path,
      parsed: parseSlides(text),
    });
  }

  const competencies = {};
  for (const [id, entry] of Object.entries(framework.competencies || {})) {
    competencies[id] = typeof entry === "string" ? entry : entry?.label || id;
  }

  return { course, layoutMap, geometry, competencies, blocks };
}
