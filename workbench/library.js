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
  "outcomes",
  "dok",
  "role",
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
      p === "outcomes.yaml" ||
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
    // A block is a folder, identified by either of the two files that
    // can stand alone in one: the manifest or the deck. A session may be
    // a lesson plan and a workbook with no slides, and an older block
    // may be a deck with no manifest; both are libraries.
    paths.some((p) => /^blocks\/[^/]+\/(block\.yaml|slides\.md)$/.test(p))
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
  // A block with no deck yet: an empty list, ready for a first slide.
  if (!parsed) return [];
  return parsed.slides.map((slide, index) => {
    // A title the renderer will refuse is mended here rather than at
    // preview time. Marked dirty on purpose: mending it in memory alone
    // would leave the branch broken, because an untouched slide is
    // copied to the file byte for byte.
    const mended = withPlainTitle(slide.data);
    return {
    sourceIndex: index,
    data: mended,
    dirty: mended !== slide.data,
    // Why a slide came back empty. Dropping this is how a file the
    // workbench itself had written badly was reported as a missing
    // layout: js-yaml said exactly what was wrong with line 16 and
    // nobody was listening, so the canvas blamed the geometry and an
    // author went and read a template that was never the problem.
    error: slide.error ?? null,
    };
  });
}

// ---- changing a layout without losing what is in it ---------------------
//
// Layouts do not offer the same regions. Moving a slide from one that has
// `full` to one that has `left`/`right` used to keep the `full:` key: the
// canvas stopped drawing it, because there is no placeholder to draw it
// in, and the renderer refuses an unknown region outright. So the author
// saw their words vanish and the deck would not build.
//
// Nothing here decides on the author's behalf. It works out what fits,
// what does not, and where the rest could go -- the caller shows that and
// asks.

/**
 * What changing `slide` to `nextLayout` would do to its content.
 *
 * `kept`    regions the new layout also has
 * `orphans` regions with content that it does not, in file order
 * `free`    regions of the new layout that nothing has claimed
 * `suggested` a default destination for each orphan, or "" to discard
 */
export function layoutChange(slide, layoutMap, nextLayout, geometry = null) {
  const next = layoutRegions(layoutMap, nextLayout, geometry);
  const filled = slideRegions(slide).filter((r) => !isEmptyRegion(slide[r]));
  const kept = filled.filter((r) => next.includes(r));
  const orphans = filled.filter((r) => !next.includes(r));
  const free = next.filter((r) => !kept.includes(r));

  // A content placeholder belongs in a content placeholder, in either
  // direction: the body of a Full slide should land in Comparison's
  // left column, and Comparison's left column should land back in
  // `full` -- accepting that `right` then has nowhere to go, which is
  // true and worth being asked about.
  //
  // Pairing them off in file order did neither. Going one way it put the
  // body into Comparison's left *heading*, because that is the region
  // the map happens to list first.
  //
  // So the template is asked what each placeholder is for. Exact matches
  // are taken first, across the whole layout, before anything settles
  // for a placeholder of another kind.
  const rankOf = (layout, region) => {
    const type = String(
      geometry?.layouts?.[layout]?.regions?.[region]?.type ?? ""
    ).toLowerCase();
    if (type === "object" || type === "picture") return 2; // holds anything
    if (type === "body") return 1; // holds words
    return 0;
  };

  const suggested = {};
  const spare = orphans.filter(() => true);
  const take = (target, wanted) => {
    const i = spare.findIndex((o) => rankOf(slide.layout, o) === wanted);
    if (i < 0) return false;
    suggested[spare.splice(i, 1)[0]] = target;
    return true;
  };

  const unclaimed = [];
  for (const target of free) {
    if (!take(target, rankOf(nextLayout, target))) unclaimed.push(target);
  }
  // Anything left over goes somewhere it fits rather than nowhere.
  for (const target of unclaimed) {
    if (!spare.length) break;
    suggested[spare.shift()] = target;
  }
  for (const orphan of orphans) if (!(orphan in suggested)) suggested[orphan] = "";
  return { kept, orphans, free, suggested };
}

/** Whether a region holds anything worth worrying about losing. */
export function isEmptyRegion(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value !== "object") return false;
  if (Array.isArray(value.items)) return value.items.length === 0;
  if (typeof value.text === "string") return value.text.trim() === "";
  // An image or a video is content even with nothing else on it.
  return !value.src && !value.url && !value.type;
}

/**
 * The slide after a layout change, with orphaned content moved.
 *
 * `moves` maps an orphaned region to where it should go: a region of the
 * new layout, or "" to drop it. An orphan with no entry is dropped, so
 * the caller has to have decided about every one of them.
 */
export function applyLayoutChange(slide, layoutMap, nextLayout, moves = {}, geometry = null) {
  const { orphans } = layoutChange(slide, layoutMap, nextLayout, geometry);
  const out = { ...slide, layout: nextLayout };
  for (const region of orphans) {
    const target = moves[region];
    const value = out[region];
    delete out[region];
    if (target) out[target] = value;
  }

  // Empty regions the new layout has not got. They are not orphans --
  // nothing is in them, so nobody was asked about them -- and they were
  // simply left behind, which is how `full: ""` ended up on a Comparison
  // slide and stopped a deck rendering over a placeholder holding
  // nothing. Dropped here, where the layout is changing anyway.
  const offered = layoutRegions(layoutMap, nextLayout, geometry);
  if (offered.length) {
    for (const region of slideRegions(out)) {
      if (!offered.includes(region) && isEmptyRegion(out[region])) delete out[region];
    }
  }
  return out;
}

// ---- slide ids ----------------------------------------------------------
//
// An id is identity, not position. It is the key of slide-id-map.json,
// the `slideId` the PowerPoint pane ticks, and it is written into the
// provenance and the attribution line of every rendered deck. So a deck
// already in circulation says what `s-03` is, and this side must never
// disagree: **an id is allocated once, and never reused or renamed.**
//
// Position is the number in the rail, which comes from the index. The
// two look alike on a deck nobody has edited yet and diverge the moment
// one is moved -- that is correct, and the id is the one that must not
// move.
//
// Lowest-free allocation, which this replaced, resurrected the id of a
// deleted slide onto unrelated content. Highest-plus-one is not enough
// on its own: delete the last slide, add one, and the number comes back.
// So the high-water mark is kept in the deck's own frontmatter and only
// ever rises.

const SEQ_KEY = "slide_seq";
const SEQ_LINE = /^slide_seq:[ \t]*\d+[ \t]*$/m;

/** The trailing number of an id, or 0 for one that has none. */
export function slideNumber(id) {
  const match = /(\d+)$/.exec(String(id ?? ""));
  return match ? Number(match[1]) : 0;
}

/** The high-water mark a deck carries: the last id it ever handed out. */
export function slideMark(parsed, working = []) {
  return Math.max(
    Number(parsed?.frontmatter?.[SEQ_KEY]) || 0,
    0,
    ...(parsed?.slides || []).map((s) => slideNumber(s.data?.id)),
    ...working.map((e) => slideNumber(e?.data?.id ?? e?.id))
  );
}

/**
 * Ids for `count` new slides: above everything this deck has ever used.
 *
 * `mark` is the deck's high-water mark. Pass it or ids come back that
 * a deleted slide once owned.
 */
export function mintSlideIds(count, existing = [], mark = 0) {
  const ids = existing.filter(Boolean).map(String);
  const stem = (ids[0] || "s-01").replace(/\d+$/, "") || "s-";
  const taken = new Set(ids);
  let n = Math.max(mark, 0, ...ids.map(slideNumber));
  const out = [];
  while (out.length < count) {
    n += 1;
    const id = `${stem}${String(n).padStart(2, "0")}`;
    // Only reachable when a stem repeats a number some other way; the
    // mark makes it unreachable in practice and it costs one compare.
    if (taken.has(id)) continue;
    taken.add(id);
    out.push(id);
  }
  return { ids: out, mark: n };
}

/**
 * Record the high-water mark in the deck's frontmatter -- but only when
 * it cannot be worked out from the slides that are still there.
 *
 * While the highest id present *is* the mark, the line would be noise,
 * and an untouched save has to rebuild the file byte-for-byte or every
 * review fills with churn. It earns its place the moment the highest
 * slide is deleted, which is exactly when the number would be lost.
 */
function withSlideSeq(header, mark, present, nl) {
  if (!mark) return header;
  if (mark <= present && !SEQ_LINE.test(header)) return header;
  const fm = header.match(FRONTMATTER);
  if (!fm) return `---${nl}${SEQ_KEY}: ${mark}${nl}---${nl}${nl}${header}`;
  const body = SEQ_LINE.test(fm[1])
    ? fm[1].replace(SEQ_LINE, `${SEQ_KEY}: ${mark}`)
    : `${fm[1]}${nl}${SEQ_KEY}: ${mark}`;
  return `---${nl}${body}${nl}---${nl}` + header.slice(fm[0].length);
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
/**
 * The frontmatter a new deck starts with.
 *
 * `session`, `title` and `version` are what the renderer requires. The
 * session id comes from the block's own number where it has one, because
 * that is what names the rendered file.
 */
function frontmatterFor(block, nl) {
  const id = String(block?.id ?? "");
  const number = /^(\d+)/.exec(id);
  // `||` not `??`: an empty string is as absent as undefined here, and
  // the renderer requires all three to be present and non-empty.
  const session = String(block?.meta?.code || number?.[1] || id || "01");
  const title = String(block?.meta?.title || id || "Session");
  return [
    "---",
    `session: ${JSON.stringify(session)}`,
    `title: ${JSON.stringify(title)}`,
    "version: 0.1.0",
    "---",
    "",
    "",
  ].join(nl);
}

/** The line ending this file already uses — a repo may hold either. */
function newlineOf(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function renderSlidesFile(parsed, working, block = null) {
  // A block that had no deck: there is no original text to splice into,
  // so every slide is emitted fresh. Everything below still holds.
  if (!parsed) parsed = { text: "", slides: [] };
  const nl = newlineOf(parsed.text);
  const hasSlides = parsed.slides.length > 0;
  let header = hasSlides
    ? parsed.text.slice(0, parsed.slides[0].start)
    : parsed.text.endsWith(nl)
      ? parsed.text
      : parsed.text + nl;

  // A deck written from nothing needs frontmatter. Without it the file
  // parses here -- this reader is lenient -- and the renderer refuses it
  // outright: "file must begin with '---' frontmatter". So slides
  // imported into a session that had no deck looked perfectly fine in
  // the rail and broke the moment they were saved.
  if (!FRONTMATTER.test(header)) {
    header = frontmatterFor(block, nl) + header.replace(/^\s+/, "");
  }

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
  // The mark only rises, so a deck that loses its highest slide does not
  // hand that number out again.
  const out =
    withSlideSeq(
      header,
      slideMark(parsed, working),
      Math.max(0, ...working.map((e) => slideNumber(e?.data?.id))),
      nl
    ) +
    bodies.join(nl + nl) +
    (tail.trim() ? tail : nl);
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
 *
 * `geometry` is optional and only affects one thing: every layout with a
 * single content placeholder also answers to `full`, whatever the map
 * calls it — see mainContentRegion. Passing it keeps this in step with
 * the renderer, which applies the same rule; leaving it out gives the
 * literal contents of the file.
 */
export function layoutRegions(layoutMap, layoutKey, geometry = null) {
  const entry = layoutMap?.[layoutKey];
  if (!entry || !entry.regions) return [];
  const named = Object.keys(entry.regions);
  if (named.includes(MAIN_CONTENT_REGION)) return named;
  const main = mainContentRegion(geometry, layoutKey, named);
  return main ? [...named, MAIN_CONTENT_REGION] : named;
}

/** The name a slide uses for "the content placeholder". */
export const MAIN_CONTENT_REGION = "full";

// What PowerPoint will let you drop a picture into. A body placeholder
// takes text and nothing else, which is why a section header's subtitle
// is not a candidate however alone it is on the slide.
const PLACEHOLDER_TAKES_A_PICTURE = new Set(["object", "picture"]);

/**
 * The one region of a layout that holds the slide's content, or null
 * when there is a real choice to make.
 *
 * The layout map names the same PowerPoint placeholder differently in
 * every layout -- `full` in Title and Content, `picture` in Picture with
 * Caption -- so a slide written for one was undeclared in the next for
 * no reason but the name. Where a layout has exactly one such
 * placeholder it answers to `full` as well. Where it has two --
 * Comparison, Split, Cards -- this returns null, because guessing which
 * column somebody meant is worse than asking.
 *
 * Mirrors layoutmap.apply_content_aliases in the renderer, from the same
 * placeholder types the template itself declares.
 */
export function mainContentRegion(geometry, layoutKey, named = null) {
  const regions = geometry?.layouts?.[layoutKey]?.regions;
  if (!regions) return null;
  const holders = Object.entries(regions)
    .filter(([name]) => !named || named.includes(name))
    .filter(([, rect]) =>
      PLACEHOLDER_TAKES_A_PICTURE.has(String(rect?.type ?? "").toLowerCase())
    )
    .map(([name]) => name);
  return holders.length === 1 ? holders[0] : null;
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
  const outcomes = parseYaml(files.get("outcomes.yaml") || "") || {};
  const geometry = files.has("layout-geometry.json")
    ? JSON.parse(files.get("layout-geometry.json"))
    : null;

  // Discovery is by `block.yaml`, not by the deck. A block is a session,
  // and a session may well be a lesson plan and a workbook with no slides
  // at all -- keying off slides.md made those blocks invisible.
  const blocks = new Map();
  for (const path of files.keys()) {
    const m = path.match(/^blocks\/([^/]+)\/(?:block\.yaml|slides\.md)$/);
    if (!m) continue;
    const id = m[1];
    if (blocks.has(id)) continue;
    const slidesPath = `blocks/${id}/slides.md`;
    const slides = files.get(slidesPath);
    const meta = files.get(`blocks/${id}/block.yaml`);
    blocks.set(id, {
      id,
      meta: meta === undefined ? {} : parseYaml(meta) || {},
      slidesPath: slides === undefined ? null : slidesPath,
      parsed: slides === undefined ? null : parseSlides(slides),
    });
  }

  const competencies = {};
  for (const [id, entry] of Object.entries(framework.competencies || {})) {
    competencies[id] = typeof entry === "string" ? entry : entry?.label || id;
  }

  return { course, layoutMap, geometry, competencies, outcomes, blocks };
}

// ---- the title is text, and only text -----------------------------------
//
// The renderer is strict about one region: `title` must be a plain
// string. Everywhere else a region may be a list, an image, a diagram.
//
// The workbench did not know that, so several ordinary actions wrote a
// title the renderer then refused, and the author found out from a
// Python traceback naming a line number:
//
//     'title' must be a plain string
//
// It took a list button pressed with the title selected -- but also,
// and more quietly, simply typing a second line into it: turning a
// multi-line region back into "no list" yields {type: p, text}, which
// is not a string either.
//
// Newlines are not the problem and are not removed: the renderer writes
// a line break for one, so a two-line title renders as a two-line
// title. Only the wrapper has to go.

/** Regions the renderer will only take as plain text. */
export const TEXT_ONLY_REGIONS = new Set(["title"]);

/**
 * A region value as the plain string a title has to be, or null when it
 * holds something that cannot become text without throwing it away --
 * an image, a video, a diagram. Callers refuse rather than destroy.
 */
export function asPlainText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => asPlainText(v) ?? "").join("\n");
  if (typeof value !== "object") return "";

  const type = value.type ?? null;
  if (type === "ul" || type === "ol") return listLines(value.items).join("\n");
  if (type === null || type === "p" || type === "text") return String(value.text ?? "");
  // image, video, mermaid: there is no honest text for these.
  return null;
}

/**
 * A slide with its title made legal, if it can be. Applied wherever a
 * slide is committed, so no control has to remember the rule and none
 * can get round it.
 */
export function withPlainTitle(slide) {
  if (!slide || typeof slide !== "object") return slide;
  for (const region of TEXT_ONLY_REGIONS) {
    if (!(region in slide)) continue;
    const value = slide[region];
    if (typeof value === "string") continue;
    const text = asPlainText(value);
    if (text === null) continue; // media: left alone, and refused above
    slide = { ...slide, [region]: text };
  }
  return slide;
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
