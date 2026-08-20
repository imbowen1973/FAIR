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
 * The editable working copy of a block's slides.
 *
 * An index-keyed edit map can express "change slide 3" but not "insert a
 * slide", "delete one" or "move one" — the indices shift underneath it.
 * So the app holds an ordered list instead, where each entry either
 * points back at a slide in the original file or is new.
 */
export function workingSlides(parsed) {
  return parsed.slides.map((slide, index) => ({
    sourceIndex: index,
    data: slide.data,
    dirty: false,
  }));
}

/** A new slide, with only what the grammar requires. */
export function blankSlide(layout, id) {
  return { sourceIndex: null, data: { id, layout }, dirty: true };
}

/**
 * Rebuild slides.md from the working list.
 *
 * A slide that is neither edited nor moved is copied from the original
 * text byte-for-byte, so opening a file and adding one slide leaves the
 * others untouched in review. Anything edited, new, or whose neighbours
 * changed around it is re-emitted from its data.
 */
/** The line ending this file already uses — a repo may hold either. */
function newlineOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function renderSlidesFile(parsed, working) {
  const nl = newlineOf(parsed.text);
  const hasSlides = parsed.slides.length > 0;
  const header = hasSlides
    ? parsed.text.slice(0, parsed.slides[0].start)
    : parsed.text.endsWith(nl)
      ? parsed.text
      : parsed.text + nl;

  const bodies = working.map((entry) => {
    // Untouched, wherever it now sits: its own bytes, moved or not.
    if (!entry.dirty && entry.sourceIndex !== null) {
      const slide = parsed.slides[entry.sourceIndex];
      return parsed.text.slice(slide.start, slide.end);
    }
    // js-yaml always emits \n; match the file rather than mixing endings,
    // or every rewritten slide shows as wholly changed on a CRLF repo.
    const body = stringifyYaml(entry.data).trimEnd().replace(/\r?\n/g, nl);
    return `--- slide${nl}${body}${nl}---`;
  });

  const tail = hasSlides
    ? parsed.text.slice(parsed.slides[parsed.slides.length - 1].end)
    : "";
  const out = header + bodies.join(nl + nl) + (tail.trim() ? tail : nl);
  return out.endsWith(nl) ? out : out + nl;
}

/**
 * Write edited slides back into the original text, by index.
 * Kept for the simple edit path and for the tests that pin it.
 */
export function writeSlides(parsed, edits) {
  if (!edits.size) return parsed.text;

  let out = "";
  let cursor = 0;
  parsed.slides.forEach((slide, index) => {
    out += parsed.text.slice(cursor, slide.start);
    if (edits.has(index)) {
      const nl = newlineOf(parsed.text);
      const body = stringifyYaml(edits.get(index)).trimEnd().replace(/\r?\n/g, nl);
      out += `--- slide${nl}${body}${nl}---`;
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

/** A list's items as plain lines, depth first. */
function listLines(items) {
  const out = [];
  for (const item of items ?? []) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    out.push(item.text ?? "");
    out.push(...listLines(item.items));
  }
  return out;
}

/**
 * A region's value re-cast as `kind`: "ul", "ol", or null for no list at
 * all. Whether a region is a list is a property of the region, not of a
 * selection inside it -- the grammar has no half-list -- so this converts
 * the whole value.
 *
 * Turning a nested list into plain text loses the nesting, because plain
 * text has nowhere to keep it. Everything else survives: the words, and
 * any keys the region carries such as `color`.
 *
 * Returns the value unchanged when there is nothing to do, so a caller
 * can use identity to decide whether to commit.
 */
export function asListType(value, kind) {
  const object = typeof value === "object" && value !== null ? value : null;
  const type = object?.type ?? null;
  const wasList = type === "ul" || type === "ol";
  if (type === kind || (!kind && !wasList)) return value;
  // Images, video and diagrams are not text and cannot become lists.
  if (type && !["ul", "ol", "p", "text"].includes(type)) return value;

  const lines = wasList
    ? listLines(object.items)
    : String((object ? object.text : value) ?? "").split("\n");

  const extras = { ...(object ?? {}) };
  delete extras.type;
  delete extras.items;
  delete extras.text;

  if (kind) return { type: kind, ...extras, items: lines };

  const text = lines.join("\n");
  // A bare string is the cleanest thing to put in the file, but it means
  // exactly one line: the canvas draws it as a single paragraph, so several
  // lines in one would run together on the slide. More than one line needs
  // the `p` wrapper that can hold them.
  const bare = lines.length === 1 && !Object.keys(extras).length;
  return bare ? text : { type: "p", ...extras, text };
}
