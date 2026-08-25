// Bringing slides in from outside.
//
// Paste a deck, drop a file, or hand over plain markdown and let it be
// turned into slides. The point of this is not convenience: it is that
// content written elsewhere — by a colleague, by a model, by an older
// course — has one door into a library, and that door checks.
//
// **Everything is validated before anything is added.** An import that
// silently produces broken slides is worse than one that refuses: the
// slides look fine in a list and fail at render, by which time nobody
// remembers where they came from. So a layout the template does not
// have, or a region that layout does not offer, is reported against the
// slide it came from and the import does not proceed until it is fixed.
//
// A model generating eduFAIR content will get the grammar nearly right
// and occasionally not. This is where that gets caught.

import {
  layoutRegions,
  mintSlideIds,
  parseSlides,
  RESERVED_SLIDE_KEYS,
  slideNumber,
} from "./library.js";

/** A heading that starts a slide, when converting plain markdown. */
const HEADING = /^(#{1,3})\s+(.+)$/;
const BULLET = /^\s*[-*+]\s+(.+)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/;

/**
 * What an import would add, and everything wrong with it.
 *
 * Returns `{slides, problems, kind}` where `kind` says how the text was
 * read — as the slide grammar, or as plain markdown turned into slides.
 * `problems` entries are `{where, message, fatal}`; a fatal one means
 * the import cannot proceed.
 */
export function readImport(text, { layoutMap, geometry, existingIds = [] } = {}) {
  const source = String(text ?? "").trim();
  if (!source) return { slides: [], problems: [], kind: "empty" };

  const looksLikeGrammar = /^---\s*slide\s*$/m.test(source);
  const { slides, kind } = looksLikeGrammar
    ? { slides: parseSlides(source).slides.map((s) => s.data), kind: "grammar" }
    : { slides: slidesFromMarkdown(source, { layoutMap }), kind: "markdown" };

  return {
    slides,
    kind,
    problems: checkSlides(slides, { layoutMap, geometry, existingIds }),
  };
}

/**
 * Every reason an import should not proceed, and every reason to look
 * twice at one that can.
 */
export function checkSlides(slides, { layoutMap, geometry, existingIds = [] } = {}) {
  const problems = [];
  const layouts = Object.keys(layoutMap || {}).filter((k) => !k.startsWith("_"));
  const seen = new Set(existingIds);

  slides.forEach((slide, index) => {
    const where = slide?.id || `slide ${index + 1}`;
    const add = (message, fatal = true) => problems.push({ where, message, fatal });

    if (!slide || typeof slide !== "object") {
      add("this is not a slide: it should be a YAML mapping");
      return;
    }
    // Ids are ours to manage: `renumber` gives one to a slide that has
    // none and moves one that clashes. Neither is a reason to refuse an
    // import -- but both are worth saying, because an id is what a
    // rendered slide is addressed by and an author may have chosen it.
    if (!slide.id) add("no id — one will be given", false);
    else if (seen.has(slide.id)) {
      add(`the id ${slide.id} is already in this deck — it will be renumbered`, false);
    } else seen.add(slide.id);

    if (!slide.layout) {
      add("no layout");
    } else if (layouts.length && !layouts.includes(slide.layout)) {
      add(
        `unknown layout ${slide.layout}. This template offers ${layouts.join(", ")}`
      );
    } else if (layouts.length) {
      // A layout can be in layout-map.yaml and have no rectangles in
      // layout-geometry.json. The slide is valid and cannot be drawn, so
      // this is worth saying at import rather than leaving somebody to
      // find a blank canvas -- but it is not a reason to refuse: the
      // workbench can read the geometry from the template.
      if (geometry?.layouts && !geometry.layouts[slide.layout]) {
        add(
          `${slide.layout} has no geometry in this library, so it will not ` +
            "draw until it is read from the template",
          false
        );
      }
      // Regions are only checkable once the layout is known to exist.
      const allowed = layoutRegions(layoutMap, slide.layout);
      for (const key of Object.keys(slide)) {
        if (RESERVED_SLIDE_KEYS.has(key)) continue;
        if (!allowed.includes(key)) {
          add(
            `${slide.layout} has no region called ${key}. It offers ${allowed.join(", ")}`
          );
        }
      }
      const filled = Object.keys(slide).filter((k) => !RESERVED_SLIDE_KEYS.has(k));
      if (!filled.length) {
        // Not fatal: an empty slide is a legitimate thing to add and
        // then fill in, and refusing it would be officious.
        add("nothing in it yet", false);
      }
    }
  });
  return problems;
}

/**
 * Plain markdown, turned into slides.
 *
 * Headings become slides and what follows them becomes the body. This is
 * a convenience and it is honest about being one — the result is a
 * starting point to edit, not a rendering. It exists because content
 * arrives as prose far more often than as this grammar, and because a
 * model asked for slides will sometimes hand back a document.
 */
export function slidesFromMarkdown(text, { layoutMap } = {}) {
  const layouts = Object.keys(layoutMap || {}).filter((k) => !k.startsWith("_"));
  const pick = (...wanted) => wanted.find((w) => layouts.includes(w)) || layouts[0] || "Full";
  const bodyLayout = pick("Full", "Content", "Title and Content");
  const titleLayout = pick("Title", "Section");
  const bodyRegion = () => {
    const regions = layoutRegions(layoutMap, bodyLayout).filter((r) => r !== "title");
    return regions[0] || "full";
  };

  const slides = [];
  let current = null;
  let items = [];
  let prose = [];

  const flush = () => {
    if (!current) return;
    const region = bodyRegion();
    if (items.length) current[region] = { type: "ul", items: [...items] };
    else if (prose.length) current[region] = prose.join(" ");
    slides.push(current);
    current = null;
    items = [];
    prose = [];
  };

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const depth = heading[1].length;
      current = {
        id: `s-${String(slides.length + 1).padStart(2, "0")}`,
        // A lone top-level heading reads as a section marker; anything
        // below it is a content slide.
        layout: depth === 1 ? titleLayout : bodyLayout,
        title: heading[2].trim(),
      };
      continue;
    }
    if (!current) continue;

    const bullet = line.match(BULLET) || line.match(NUMBERED);
    if (bullet) {
      items.push(bullet[1].trim());
      continue;
    }
    if (line.trim()) prose.push(line.trim());
  }
  flush();

  // A title slide with nothing under it keeps its layout; one that
  // collected content needs a layout that has somewhere to put it.
  for (const slide of slides) {
    const filled = Object.keys(slide).filter((k) => !RESERVED_SLIDE_KEYS.has(k) && k !== "title");
    if (filled.length && slide.layout === titleLayout) slide.layout = bodyLayout;
  }
  return slides;
}

/**
 * Ids that will not collide with what is already there.
 *
 * An import carrying `s-01` into a deck that has one is the commonest
 * way a paste goes wrong, and renumbering silently is kinder than
 * refusing — the ids are ours, not the author's.
 */
export function renumber(slides, existingIds = [], mark = 0) {
  const taken = [...existingIds];
  let water = mark;
  return slides.map((slide) => {
    // An id that does not clash is the author's and is kept. Only a
    // genuine collision moves, and it moves *above* everything this deck
    // has ever handed out -- never into the gap a deleted slide left.
    if (slide.id && !taken.includes(slide.id)) {
      taken.push(slide.id);
      water = Math.max(water, slideNumber(slide.id));
      return { ...slide };
    }
    const minted = mintSlideIds(1, taken, water);
    water = minted.mark;
    taken.push(minted.ids[0]);
    return { ...slide, id: minted.ids[0] };
  });
}

// ---- the panel ----------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Paste or drop slides, see what would happen, then do it.
 *
 * The summary is the point. An import that just says "done" leaves an
 * author to find out afterwards what arrived; this says how many slides,
 * read which way, and everything wrong with them, before anything is
 * added.
 *
 * onAdd(slides)      put them after the current slide
 * onReplace(slides)  make them the deck
 */
export function importPanel(host, { layoutMap, geometry, existingIds = [], mark = 0, onAdd, onReplace, onClose }) {
  host.innerHTML = "";
  const panel = el("div", "import-panel");
  panel.append(el("h4", null, "Import slides"));
  panel.append(
    el(
      "p",
      "hint",
      "Paste slides in the eduFAIR grammar, or plain markdown with " +
        "headings — headings become slides and what follows them becomes " +
        "the body. Everything is checked against this template before " +
        "anything is added."
    )
  );

  const file = el("input");
  file.type = "file";
  file.accept = ".md,.markdown,.yaml,.yml,.txt";
  file.id = "import-file";
  const label = el("label", "media-droplabel", "Open a file…");
  label.htmlFor = file.id;
  panel.append(label, file);

  const area = el("textarea", "mdsource import-source");
  area.rows = 12;
  area.placeholder = "--- slide\nid: s-01\nlayout: Full\ntitle: …\n---";
  area.setAttribute("aria-label", "Slides to import");
  panel.append(area);

  const summary = el("div", "import-summary");
  panel.append(summary);

  const actions = el("div", "card-actions");
  const add = el("button", "primary", "Add to this deck");
  add.type = "button";
  const replace = el("button", null, "Replace the deck");
  replace.type = "button";
  const cancel = el("button", "link", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => onClose?.());
  actions.append(add, replace, cancel);
  panel.append(actions);

  let ready = [];

  const review = () => {
    const result = readImport(area.value, { layoutMap, geometry, existingIds });
    summary.innerHTML = "";
    ready = [];

    if (result.kind === "empty") {
      add.disabled = true;
      replace.disabled = true;
      return;
    }

    const fatal = result.problems.filter((p) => p.fatal);
    const notes = result.problems.filter((p) => !p.fatal);

    const line = el("p", fatal.length ? "warn" : "ok");
    line.textContent =
      `${result.slides.length} slide${result.slides.length === 1 ? "" : "s"}, ` +
      (result.kind === "markdown"
        ? "read as plain markdown and turned into slides"
        : "read as eduFAIR slides") +
      (fatal.length ? ` — ${fatal.length} to fix first` : "");
    summary.append(line);

    for (const problem of [...fatal, ...notes]) {
      const row = el("p", problem.fatal ? "problem" : "hint");
      row.textContent = `${problem.where}: ${problem.message}`;
      summary.append(row);
    }

    if (!fatal.length) {
      const list = el("ul", "import-list");
      for (const slide of result.slides) {
        list.append(el("li", null, `${slide.layout} — ${slide.title ?? slide.id}`));
      }
      summary.append(list);
      ready = renumber(result.slides, existingIds, mark);
    }

    add.disabled = Boolean(fatal.length);
    replace.disabled = Boolean(fatal.length);
  };

  area.addEventListener("input", review);
  file.addEventListener("change", async () => {
    if (!file.files?.length) return;
    area.value = await file.files[0].text();
    review();
  });
  add.addEventListener("click", () => onAdd?.(ready));
  replace.addEventListener("click", () => onReplace?.(ready));

  host.append(panel);
  review();
  area.focus();
}
