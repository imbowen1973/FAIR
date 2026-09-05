// Task pane wiring: library picker -> catalog -> competency picker ->
// slide list -> insert. Implements spec B.3/B.4 plus git-published
// libraries (platform-architecture.md, public phase). All query logic
// lives in assembler.js.

import {
  arrayBufferToBase64,
  buildInsertPlan,
  buildTree,
  groupBySource,
  isRepoUrl,
  joinUrl,
  normalizeSource,
  parseRepoInput,
  searchCatalog,
  usedCompetencies,
} from "./assembler.js";
import {
  addSource as rememberSource,
  initialSource,
  loadSources,
  rememberLast,
  removeSource as forgetSource,
  repoSource,
} from "./sources.js";

// Decks rendered in-browser (wasm sources), keyed by source url then
// sourcePptx. RAM only — nothing is stored anywhere.
// Which branch of each library is being rendered, keyed by source url.
// Absent means the default branch, which is what most libraries only
// ever have.
const branchBySource = new Map();
let branchesHere = [];

const memoryDecks = new Map();
// Blob URLs for assets a wasm render produced (the funder logo), keyed
// by source url then asset name. RAM only, like the decks.
const memoryAssets = new Map();

// There is deliberately no built-in corpus. The pane used to default to
// whatever the server had built into its own data/ directory, which made
// the tool depend on a server holding content. Every library is now an
// explicit pick: a repo that renders in this tab, or a corpus URL.

let catalog = null;
let currentSource = null;
let tree = [];
let selected = new Set();
let expanded = new Set();
let query = "";
let competencyFilter = "";

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
  el.hidden = !message;
}

// The list lives in sources.js so the Word pane sees the same one: add a
// library here and it is there, and vice versa.
function allSources() {
  return loadSources();
}

function renderSourcePicker() {
  const select = $("source");
  const sources = allSources();
  select.innerHTML = "";

  if (sources.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No library added yet";
    select.appendChild(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const source of sources) {
    const opt = document.createElement("option");
    opt.value = source.url;
    opt.textContent = source.name;
    select.appendChild(opt);
  }
  if (currentSource) select.value = currentSource.url;
}

async function loadCatalog(source) {
  if (source.url.startsWith("wasm:")) {
    const [owner, repo] = source.url.slice(5).split("/");
    const { loadLibraryFromGitHub } = await import("./wasm-renderer.js");
    const ref = branchBySource.get(source.url) ?? null;
    const { catalog, decks, assets } = await loadLibraryFromGitHub(
      owner,
      repo,
      setStatus,
      ref
    );
    memoryDecks.set(source.url, decks);
    const blobs = new Map();
    for (const [name, bytes] of assets ?? []) {
      blobs.set(name, URL.createObjectURL(new Blob([bytes])));
    }
    const previous = memoryAssets.get(source.url);
    if (previous) for (const url of previous.values()) URL.revokeObjectURL(url);
    memoryAssets.set(source.url, blobs);
    return catalog;
  }
  const res = await fetch(joinUrl(source.url, "data/catalog.json"));
  if (!res.ok) {
    throw new Error(
      `no catalog at ${source.name} (${res.status}) — is the library published?`
    );
  }
  return res.json();
}

/** Forget a stored library, then open whatever is left (or nothing). */
function removeSource() {
  if (!currentSource) return;
  forgetSource(currentSource.url);
  currentSource = null;
  renderSourcePicker();
  // Not awaited, so its rejection would be unhandled and silent -- and
  // the first thing it does on every reload is refetch the last library.
  switchSource(initialSource()).catch((err) => {
    setStatus(`Could not open the last library: ${err.message}`, "error");
  });
}

/**
 * Offer the branches a library has, when it has more than one.
 *
 * A library nobody has drafted in has exactly one branch, and a picker
 * with one entry is a question with one answer -- so the row stays away
 * until there is a choice to make. The workbench saves to draft/<login>,
 * which is where that second branch usually comes from, and being unable
 * to render it was why a fix could be made and not seen.
 */
async function renderBranchPicker(source) {
  const row = $("branch-row");
  const select = $("branch");
  branchesHere = [];
  if (!source || !source.url.startsWith("wasm:")) {
    row.hidden = true;
    return;
  }
  const [owner, repo] = source.url.slice(5).split("/");
  const { fetchBranches } = await import("./wasm-renderer.js");
  branchesHere = await fetchBranches(owner, repo);
  if (branchesHere.length < 2) {
    row.hidden = true;
    return;
  }
  select.innerHTML = "";
  for (const branch of branchesHere) {
    const option = document.createElement("option");
    option.value = branch.name;
    option.textContent = branch.isDefault ? `${branch.name} (published)` : branch.name;
    select.appendChild(option);
  }
  const chosen =
    branchBySource.get(source.url) ??
    branchesHere.find((b) => b.isDefault)?.name ??
    branchesHere[0].name;
  select.value = chosen;
  row.hidden = false;
}

/**
 * Say which slides could not be rendered.
 *
 * The render used to stop at the first one, so nothing could be
 * assembled at all -- from a library the person here very often cannot
 * fix. It now carries on and names them, once, above the tree.
 */
function reportProblems(problems) {
  const host = $("step-tree");
  host.querySelector(".render-problems")?.remove();
  if (!problems || !problems.length) return;

  const box = document.createElement("div");
  box.className = "render-problems";
  const count = problems.length;
  const head = document.createElement("p");
  head.textContent =
    `${count} slide${count === 1 ? "" : "s"} could not be rendered and ` +
    `${count === 1 ? "is" : "are"} not listed below. Everything else is here.`;
  box.appendChild(head);

  const list = document.createElement("ul");
  for (const problem of problems.slice(0, 12)) {
    const item = document.createElement("li");
    item.textContent = `${problem.slideId} in ${problem.blockId}: ${problem.message}`;
    list.appendChild(item);
  }
  box.appendChild(list);
  host.prepend(box);
}

async function switchSource(source) {
  currentSource = source;
  $("remove-source").hidden = !source;
  $("competency").disabled = true;
  $("step-assemble").hidden = true;
  // Selection is per-corpus: slide ids from the old catalog mean nothing here.
  selected = new Set();
  expanded = new Set();
  tree = [];

  // Nothing picked: prompt for a library rather than show an empty tree.
  if (!source) {
    catalog = null;
    rememberLast("");
    renderSourcePicker();
    renderCompetencyPicker();
    renderTree();
    renderFunder();
    updateSelectionSummary();
    $("add-source-row").hidden = false;
    setStatus("");
    return;
  }

  rememberLast(source.url);
  setStatus(`Loading ${source.name}…`);
  try {
    // Before the render, so the pane can say which branch it is about to
    // read and the author can change it without waiting for a build.
    await renderBranchPicker(source);
    const on = branchBySource.get(source.url);
    if (on) setStatus(`Loading ${source.name} on ${on}…`);
    catalog = await loadCatalog(source);
    tree = buildTree(catalog);
    // Slides the render could not produce. They are not in the tree and
    // cannot be inserted, so the pane says which and why rather than
    // leaving a deck quietly shorter than the library.
    reportProblems(catalog.problems);
    // A course with several modules opens closed: the top level is the
    // question ("which part of this?"), and answering it with forty rows
    // of slides is answering a question nobody asked. One module has no
    // choice to offer, so it opens.
    expanded = tree.length > 1 ? new Set() : new Set(tree.map((_, i) => String(i)));
    renderCompetencyPicker();
    renderTree();
    renderFunder();
    updateSelectionSummary();
    setStatus("");
  } catch (err) {
    catalog = null;
    tree = [];
    renderTree();
    renderFunder();
    setStatus(err.message, "error");
  }
}

function renderCompetencyPicker() {
  const select = $("competency");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "All competencies";
  select.appendChild(placeholder);
  if (!catalog) {
    select.disabled = true;
    return;
  }
  for (const { id, label } of usedCompetencies(catalog)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label === id ? id : `${id} — ${label}`;
    select.appendChild(opt);
  }
  select.disabled = false;
}

/** Slide ids the competency filter admits; null means "no filter". */
function allowedByCompetency() {
  if (!competencyFilter) return null;
  return new Set(
    catalog.slides
      .filter((s) => (s.develops || []).includes(competencyFilter))
      .map((s) => s.slideId)
  );
}

function updateSelectionSummary() {
  const chosen = catalog
    ? catalog.slides.filter((s) => selected.has(s.slideId))
    : [];
  const decks = new Set(chosen.map((s) => s.sourcePptx)).size;
  $("selection-summary").textContent = chosen.length
    ? `${chosen.length} slide${chosen.length === 1 ? "" : "s"} from ${decks} deck${decks === 1 ? "" : "s"}`
    : "";
  $("step-assemble").hidden = chosen.length === 0;
}

function slideRow(node, allowed) {
  const row = document.createElement("label");
  row.className = "node-row";
  const spacer = document.createElement("span");
  spacer.className = "twisty leaf";
  spacer.setAttribute("aria-hidden", "true");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = selected.has(node.meta.slideId);
  cb.addEventListener("change", () => {
    toggleSlides([node.meta.slideId], cb.checked);
  });
  const label = document.createElement("span");
  label.className = "node-label";
  label.textContent = node.title;
  const dok = document.createElement("span");
  dok.className = "dok";
  // "DOK 2" alone is meaningless read aloud; expand it for the label.
  if (node.meta.dok != null) {
    dok.textContent = `DOK ${node.meta.dok}`;
    dok.setAttribute("aria-label", `Depth of knowledge ${node.meta.dok}`);
  }
  row.append(spacer, cb, label, dok);
  return row;
}

function toggleSlides(ids, on) {
  for (const id of ids) {
    if (on) selected.add(id);
    else selected.delete(id);
  }
  renderTree();
  updateSelectionSummary();
}

function renderNode(node, path, allowed) {
  // A container is worth drawing only if the filter leaves slides in it.
  const ids = allowed ? node.slideIds.filter((id) => allowed.has(id)) : node.slideIds;
  if (ids.length === 0 && node.kind !== "slide") return null;
  if (node.kind === "slide" && allowed && !allowed.has(node.meta.slideId)) return null;

  const el = document.createElement("div");
  el.className = `node node-kind-${node.kind}`;
  el.setAttribute("role", "treeitem");

  if (node.kind === "slide") {
    el.appendChild(slideRow(node, allowed));
    return el;
  }

  // A resource is part of the block but not of the deck: shown and
  // linked, never selectable, because PowerPoint cannot insert a
  // workbook. Hidden while a competency filter is narrowing to slides.
  if (node.kind === "resource") {
    if (allowed) return null;
    const row = document.createElement("div");
    row.className = "node-row";
    const spacer = document.createElement("span");
    spacer.className = "twisty leaf";
    spacer.setAttribute("aria-hidden", "true");
    const link = document.createElement("a");
    link.className = "node-label resource-link";
    link.textContent = node.title;
    link.href = resourceUrl(node.meta.path);
    link.target = "_blank";
    link.rel = "noopener";
    const kind = document.createElement("span");
    kind.className = "res-type";
    kind.textContent = node.meta.type;
    row.append(spacer, link, kind);
    el.appendChild(row);
    return el;
  }

  const open = expanded.has(path);
  el.setAttribute("aria-expanded", String(open));
  const row = document.createElement("div");
  row.className = "node-row";

  const twisty = document.createElement("button");
  twisty.className = "twisty";
  twisty.textContent = open ? "▼" : "▶";
  // The glyph is decorative; the button needs a real name and the
  // expanded state lives on the treeitem, not here.
  twisty.setAttribute("aria-hidden", "true");
  twisty.tabIndex = -1;
  twisty.addEventListener("click", () => {
    if (open) expanded.delete(path);
    else expanded.add(path);
    renderTree();
  });

  const cb = document.createElement("input");
  cb.type = "checkbox";
  const chosen = ids.filter((id) => selected.has(id)).length;
  cb.checked = chosen === ids.length && ids.length > 0;
  cb.indeterminate = chosen > 0 && chosen < ids.length;
  // Without this the row reads as a bare "checkbox", with no clue what
  // ticking it selects.
  cb.setAttribute(
    "aria-label",
    `Select all ${ids.length} slide${ids.length === 1 ? "" : "s"} in ${node.kind} ${node.title}`
  );
  cb.addEventListener("change", () => toggleSlides(ids, cb.checked));

  const label = document.createElement("span");
  label.className = "node-label";
  label.textContent = node.title;
  // Sessions the course does not place. The renderer gathers them into a
  // node of its own, and this says so rather than letting it sit among
  // the author's modules looking like one of them. They are still fully
  // selectable: they build, and being unplaced is a drafting state.
  if (node.meta?.unplaced) {
    row.classList.add("unplaced");
    label.title =
      "These sessions are in the library but the course does not say where " +
      "they come. They still build, and can be used.";
  }

  const meta = document.createElement("span");
  meta.className = node.kind === "credential" && node.meta.ects ? "ects" : "count";
  meta.textContent =
    node.kind === "credential" && node.meta.ects
      ? `${node.meta.ects} ECTS`
      : open
        ? ""
        : `${ids.length}`;

  row.append(twisty, cb, label, meta);
  el.appendChild(row);

  if (open) {
    const kids = document.createElement("div");
    kids.className = "node-children";
    kids.setAttribute("role", "group");
    for (const [i, child] of node.children.entries()) {
      const rendered = renderNode(child, `${path}/${i}`, allowed);
      if (rendered) kids.appendChild(rendered);
    }
    el.appendChild(kids);
  }
  return el;
}

/**
 * `text` with every occurrence of `term` marked.
 *
 * Built as nodes rather than markup: a search term is whatever somebody
 * typed, and a slide title is whatever a library holds. Neither belongs
 * in innerHTML.
 */
function marked(text, term) {
  const out = document.createDocumentFragment();
  const hay = String(text ?? "");
  const needle = String(term ?? "").trim();
  if (!needle) {
    out.append(hay);
    return out;
  }
  const lower = hay.toLowerCase();
  const find = needle.toLowerCase();
  let at = 0;
  for (;;) {
    const i = lower.indexOf(find, at);
    if (i < 0) break;
    if (i > at) out.append(hay.slice(at, i));
    const hit = document.createElement("mark");
    hit.textContent = hay.slice(i, i + find.length);
    out.append(hit);
    at = i + find.length;
  }
  out.append(hay.slice(at));
  return out;
}

/**
 * The layout geometry for the open corpus, fetched once.
 *
 * It sits beside catalog.json for a corpus, and inside the library for
 * one rendered here. Null when a corpus predates it being published, in
 * which case a peek says so rather than drawing a blank rectangle.
 */
let geometry = null;
let geometryFor = null;

async function loadGeometry(source) {
  if (geometryFor === source.url) return geometry;
  geometryFor = source.url;
  geometry = null;
  try {
    if (source.url.startsWith("wasm:")) {
      const [owner, repo] = source.url.slice(5).split("/");
      const ref = branchBySource.get(source.url);
      const at = ref ? encodeURIComponent(ref) : "HEAD";
      const res = await fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${at}/layout-geometry.json`
      );
      if (res.ok) geometry = await res.json();
    } else {
      // Beside catalog.json, which the pane reads from data/.
      const res = await fetch(joinUrl(source.url, "data/layout-geometry.json"));
      if (res.ok) geometry = await res.json();
    }
  } catch {
    /* a peek is a convenience; failing to fetch it is not an error */
  }
  return geometry;
}

/**
 * Show a slide, without inserting it.
 *
 * Drawn from the catalog's own copy of the slide and the template's
 * geometry, by the same code the workbench draws its canvas with — the
 * pane holds decks as PowerPoint bytes and cannot look inside one, so
 * the alternative was no preview at all.
 */
async function showPeek(hit) {
  document.querySelector(".peek-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "peek-backdrop";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  const box = document.createElement("div");
  box.className = "peek";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", `Preview of ${hit.slide.title ?? hit.slideId}`);

  const head = document.createElement("div");
  head.className = "peek-head";
  const name = document.createElement("strong");
  name.textContent = hit.slide.title ?? hit.slideId;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "peek-close";
  close.textContent = "×";
  close.title = "Close";
  close.setAttribute("aria-label", "Close the preview");
  close.addEventListener("click", () => backdrop.remove());
  head.append(name, close);

  const stage = document.createElement("div");
  stage.className = "peek-stage";
  stage.textContent = "Drawing…";

  const foot = document.createElement("p");
  foot.className = "peek-foot";
  foot.textContent = hit.sessionTitle ? `in ${hit.sessionTitle}` : "";

  box.append(head, stage, foot);
  backdrop.append(box);
  document.body.append(backdrop);

  const escape = (e) => {
    if (e.key === "Escape") {
      backdrop.remove();
      document.removeEventListener("keydown", escape);
    }
  };
  document.addEventListener("keydown", escape);
  close.focus();

  const geom = await loadGeometry(currentSource);
  const source = hit.slide.source;
  if (!geom || !source) {
    stage.textContent = !source
      ? "This corpus was built before slides carried their own content, so there is nothing to draw. Re-render the library to see previews."
      : "This corpus has no layout-geometry.json beside it, so there is nothing to draw the slide into.";
    return;
  }

  stage.textContent = "";
  const drawn = drawPeek(stage, geom, hit.slide.layout, source);
  if (!drawn) {
    stage.textContent =
      `The template has no geometry for the ${hit.slide.layout} layout, ` +
      "so there is nothing to draw this slide into.";
  }
}

/**
 * A slide, drawn from the template's geometry and the slide's own text.
 *
 * Deliberately small, and deliberately not the workbench's canvas: that
 * one exists to be typed into and brings its editing, its marks and its
 * media with it. This only has to be recognisable enough to choose
 * between two slides called "Overview", and neither it nor the canvas is
 * the authority on how a slide looks — the renderer is, and this is a
 * preview of what it will produce, not a claim about it.
 */
function drawPeek(host, geom, layoutKey, slide) {
  const layout = geom?.layouts?.[layoutKey];
  if (!layout?.regions) return false;

  const aspect = geom.slide?.aspect || 1.7778;
  const stage = document.createElement("div");
  stage.className = "peek-slide";
  stage.style.aspectRatio = String(aspect);
  stage.style.background = geom.theme?.bg1 || "#ffffff";
  stage.style.color = geom.theme?.tx1 || "#111111";

  for (const [name, rect] of Object.entries(layout.regions)) {
    const value = slide[name];
    if (value === undefined || value === null || value === "") continue;

    const box = document.createElement("div");
    box.className = "peek-region";
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
    if (rect.style?.align === "ctr") box.style.textAlign = "center";
    if (rect.style?.bold) box.style.fontWeight = "700";
    // Relative to the slide's own width, so the preview scales with it
    // rather than pretending every placeholder is the same size.
    if (rect.style?.sizePt) {
      box.style.fontSize = `${(rect.style.sizePt / (geom.slide?.widthPt || 720)) * 100}cqw`;
    }
    const fill = rect.fill?.slot && geom.theme?.[rect.fill.slot];
    if (fill) box.style.background = fill;
    const ink = rect.style?.colorSlot && geom.theme?.[rect.style.colorSlot];
    if (ink) box.style.color = ink;

    fillPeekRegion(box, value);
    stage.append(box);
  }

  host.append(stage);
  return true;
}

/** What one placeholder holds: words, a list, or a picture. */
function fillPeekRegion(box, value) {
  if (typeof value === "string") {
    for (const line of value.split(String.fromCharCode(10))) {
      const p = document.createElement("p");
      p.textContent = line;
      box.append(p);
    }
    return;
  }
  if (Array.isArray(value?.items)) {
    const list = document.createElement(value.type === "ol" ? "ol" : "ul");
    for (const item of value.items) {
      const li = document.createElement("li");
      li.textContent = typeof item === "string" ? item : item?.text ?? "";
      if (typeof item === "object" && item?.marker === "none") li.style.listStyle = "none";
      list.append(li);
    }
    box.append(list);
    return;
  }
  if (value?.type === "image" || value?.type === "video") {
    // No URL is attempted: a corpus serves its media from one place and
    // a repository from another, and a broken image is worse than an
    // honest label.
    const tag = document.createElement("span");
    tag.className = "peek-media";
    tag.textContent = `▨ ${String(value.src ?? value.url ?? "picture").split("/").pop()}`;
    box.append(tag);
    return;
  }
  const p = document.createElement("p");
  p.textContent = String(value?.text ?? "");
  box.append(p);
}

/** The opening of a slide's speaker notes, as a peek at what it does. */
function firstLines(notes, limit = 160) {
  const text = String(notes ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function renderSearchResults(container, allowed) {
  const hits = searchCatalog(catalog, query).filter(
    (h) => !allowed || allowed.has(h.slideId)
  );
  $("tree-heading").textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}`;
  if (hits.length === 0) {
    container.innerHTML = '<p class="empty">Nothing matches that search.</p>';
    return;
  }
  for (const hit of hits) {
    const shown = hit.slide.title ?? hit.slideId;
    const el = document.createElement("div");
    el.className = "hit";

    const row = document.createElement("label");
    row.className = "hit-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(hit.slideId);
    cb.addEventListener("change", () => toggleSlides([hit.slideId], cb.checked));
    cb.setAttribute("aria-label", `Select ${shown}`);

    const title = document.createElement("span");
    title.className = "hit-title";
    title.append(marked(shown, query));

    const field = document.createElement("span");
    field.className = "hit-field";
    field.dataset.field = hit.field;
    field.textContent = hit.field;
    field.setAttribute("aria-label", `matched in ${hit.field}`);

    const peekBtn = document.createElement("button");
    peekBtn.type = "button";
    peekBtn.className = "hit-peek";
    peekBtn.textContent = "peek";
    peekBtn.title = `Look at ${shown} without inserting it`;
    peekBtn.setAttribute("aria-label", `Peek at ${shown}`);
    peekBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPeek(hit);
    });

    row.append(cb, title, field, peekBtn);
    el.append(row);

    // Which session it came from. Two slides called "Overview" are told
    // apart by this and by nothing else on the row.
    if (hit.sessionTitle) {
      const where = document.createElement("p");
      where.className = "hit-where";
      where.append(marked(hit.sessionTitle, query));
      el.append(where);
    }

    // The words that matched, unless they are the title again — which
    // for a title hit they always were, so every result carried its own
    // heading twice and said nothing else.
    //
    // When there is nothing to quote, the slide's own notes stand in.
    // They are the nearest thing to looking at it: a title and a session
    // say which slide this is, and the notes say what it does.
    const snippet = (hit.snippet ?? "").trim();
    const quotable = snippet && snippet !== shown.trim();
    const peek = quotable ? snippet : firstLines(hit.slide.notes);
    if (peek) {
      const snip = document.createElement("p");
      // Not "peek": that is the modal, and the class collided — the styles
      // for a dialog were landing on a paragraph.
      snip.className = quotable ? "hit-snippet" : "hit-snippet from-notes";
      snip.append(marked(peek, quotable ? query : ""));
      el.append(snip);
    }

    container.appendChild(el);
  }
}

function renderTree() {
  const container = $("tree");
  container.innerHTML = "";
  if (!catalog) {
    if (!currentSource) {
      $("tree-heading").textContent = "No library";
      container.innerHTML =
        '<p class="empty">Add a library to begin — <strong>owner/repo</strong> ' +
        "renders in your browser straight from git, or paste a corpus URL.</p>";
    }
    return;
  }
  const allowed = allowedByCompetency();

  if (query.trim()) {
    renderSearchResults(container, allowed);
    return;
  }

  $("tree-heading").textContent = "Course";
  let drawn = 0;
  for (const [i, root] of tree.entries()) {
    const rendered = renderNode(root, `${i}`, allowed);
    if (rendered) {
      container.appendChild(rendered);
      drawn++;
    }
  }
  if (drawn === 0) {
    container.innerHTML = '<p class="empty">No slides match this competency.</p>';
  }
  paintExpandAll();
}

/**
 * Every path in the tree that can be opened, in render order.
 *
 * Slides and resources are leaves: renderNode draws them without a
 * twisty, so a path to one is not a thing that can be open.
 */
function openablePaths() {
  const out = [];
  const walk = (node, path) => {
    if (node.kind === "slide" || node.kind === "resource") return;
    out.push(path);
    (node.children || []).forEach((child, i) => walk(child, `${path}/${i}`));
  };
  tree.forEach((root, i) => walk(root, String(i)));
  return out;
}

const everythingOpen = () => {
  const all = openablePaths();
  return all.length > 0 && all.every((path) => expanded.has(path));
};

/**
 * Keep the button's words true.
 *
 * They used to be set only inside the click handler, from the proxy
 * `expanded.size > tree.length`. Open one twisty by hand -- which is the
 * ordinary way to use the tree -- and that proxy flips while the button
 * still reads "Expand all", so pressing it collapsed the tree instead.
 * The label was not describing the next press; it was describing the
 * last one.
 */
function paintExpandAll() {
  const button = $("expand-all");
  if (button) button.textContent = everythingOpen() ? "Collapse all" : "Expand all";
}

/**
 * Open the way down to every slide a filter kept.
 *
 * Only opens: a container the author shut that holds nothing matching
 * stays shut, and clearing the filter leaves the tree as the filter left
 * it rather than springing back to some remembered shape.
 */
function revealAllowed(allowed) {
  if (!allowed) return;
  const walk = (node, path, ancestors) => {
    if (node.kind === "slide") {
      if (allowed.has(node.meta?.slideId)) for (const a of ancestors) expanded.add(a);
      return;
    }
    const inside = [...ancestors, path];
    (node.children || []).forEach((child, i) => walk(child, `${path}/${i}`, inside));
  };
  tree.forEach((root, i) => walk(root, String(i), []));
}

/** Expand every container, or close the lot. */
function toggleExpandAll() {
  // Collapsed means collapsed. Leaving the roots open was "collapse back
  // to the roots", which from the outside is a button that does not do
  // what it says on a course with one module in it.
  expanded = everythingOpen() ? new Set() : new Set(openablePaths());
  renderTree();
}

/** All slide ids, in document order. */
async function slideIds(context) {
  const slides = context.presentation.slides;
  slides.load("items/id");
  await context.sync();
  return slides.items.map((s) => s.id);
}

/**
 * Where the first batch lands: directly after the slide the user has
 * selected (the last one, if several). getSelectedSlides needs
 * PowerPointApi 1.5; the manifest floor is 1.2, so hosts without it fall
 * back to appending at the end of the deck.
 */
async function resolveAnchor() {
  return PowerPoint.run(async (context) => {
    if (Office.context.requirements.isSetSupported("PowerPointApi", "1.5")) {
      const selected = context.presentation.getSelectedSlides();
      selected.load("items/id");
      await context.sync();
      if (selected.items.length > 0) {
        return selected.items[selected.items.length - 1].id;
      }
    }
    const ids = await slideIds(context);
    return ids.length ? ids[ids.length - 1] : null;
  });
}

async function assemble() {
  const button = $("assemble");
  button.disabled = true;
  try {
    const groups = groupBySource(
      catalog.slides.filter((s) => selected.has(s.slideId))
    );
    const plan = buildInsertPlan(groups, selected);
    if (plan.length === 0) {
      setStatus("Nothing selected.", "error");
      return;
    }
    let anchorId = await resolveAnchor();
    let inserted = 0;
    for (const step of plan) {
      setStatus(`Fetching ${step.sourcePptx}…`);
      let base64;
      const inMemory = memoryDecks.get(currentSource.url);
      if (inMemory) {
        const bytes = inMemory.get(step.sourcePptx);
        if (!bytes) throw new Error(`deck ${step.sourcePptx} missing from the in-browser render`);
        // The bytes, not the buffer they happen to sit in.
        base64 = arrayBufferToBase64(bytes);
      } else {
        const deckUrl = joinUrl(currentSource.url, joinUrl("data", step.sourcePptx));
        const res = await fetch(deckUrl);
        if (!res.ok) throw new Error(`fetch failed for ${step.sourcePptx} (${res.status})`);
        base64 = arrayBufferToBase64(await res.arrayBuffer());
      }

      setStatus(`Inserting ${step.sourceRefs.length} slide(s) from ${step.sourcePptx}…`);
      // Spec B.3: one insert call per source deck, selecting slides by
      // the renderer-emitted slideId#creationId sourceRefs.
      await PowerPoint.run(async (context) => {
        const before = new Set(await slideIds(context));

        const options = {
          formatting: PowerPoint.InsertSlideFormatting.useDestinationTheme,
          sourceSlideIds: step.sourceRefs,
        };
        // Omitting targetSlideId inserts at the *beginning* of the deck.
        if (anchorId) options.targetSlideId = anchorId;

        context.presentation.insertSlidesFromBase64(base64, options);
        await context.sync();

        // Advance the anchor to the last slide just inserted, so the next
        // source deck lands below this batch rather than above it.
        const added = (await slideIds(context)).filter((id) => !before.has(id));
        if (added.length) anchorId = added[added.length - 1];
      });
      inserted += step.sourceRefs.length;
    }
    setStatus(`Inserted ${inserted} slide(s) from ${plan.length} deck(s).`, "ok");
  } catch (err) {
    setStatus(`Assembly failed: ${err.message ?? err}`, "error");
  } finally {
    button.disabled = false;
  }
}

function addSource() {
  const input = $("new-source");
  // A GitHub repo renders IN THE BROWSER: markdown is fetched straight
  // from git and edufair_renderer runs in WebAssembly. git -> ppt, no
  // server, decks only in this tab's memory.
  const repo = parseRepoInput(input.value);
  if (repo) {
    // Described the same way the Word pane describes it, so a library
    // added in either is the same entry in both.
    const source = repoSource(repo.owner, repo.repo);
    rememberSource(source);
    input.value = "";
    renderSourcePicker();
    $("source").value = source.url;
    switchSource(source);
    return;
  }
  if (isRepoUrl(input.value)) {
    setStatus("Only github.com repos render in-browser so far — or paste a corpus server URL.", "error");
    return;
  }
  const source = normalizeSource(input.value);
  if (!source) {
    setStatus("Enter owner/repo (renders in your browser) or an https corpus URL.", "error");
    return;
  }
  if (source.url) rememberSource(source);
  input.value = "";
  renderSourcePicker();
  $("source").value = source.url;
  switchSource(source);
}

/**
 * Follow Office's own theme rather than the webview's.
 *
 * On Windows desktop the pane's webview does not reliably report
 * prefers-color-scheme when Office is set to a dark theme, which is how
 * the pane ended up dark-grey-on-black. officeTheme is authoritative, so
 * derive the mode from its background luminance and stamp data-theme,
 * which the stylesheet honours over the media query.
 */
function applyOfficeTheme() {
  const hex = Office.context?.officeTheme?.bodyBackgroundColor?.replace("#", "");
  if (!hex || hex.length < 6) return;
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  // WCAG relative luminance.
  const L = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  document.documentElement.dataset.theme = L < 0.5 ? "dark" : "light";
}

/**
 * Render the open library's funder credit. Comes from that library's
 * attribution.yaml through catalog.attribution, so switching library
 * switches the credit and no grant is baked into the tool.
 *
 * The logo shows only once it has actually loaded, so a missing or
 * unreachable asset degrades to text rather than a broken-image icon.
 */
function renderFunder() {
  const footer = $("funder");
  const img = $("funder-logo");
  const text = $("funder-text");
  const credit = catalog?.attribution;

  img.hidden = true;
  img.removeAttribute("src");
  if (!credit?.text) {
    footer.hidden = true;
    text.textContent = "";
    return;
  }

  footer.hidden = false;
  text.textContent = credit.text;
  const src = funderLogoUrl(credit.logo);
  if (!src) return;
  img.addEventListener("load", () => {
    img.hidden = false;
  }, { once: true });
  img.src = src;
}

/** Where a block resource lives for the current source. */
function resourceUrl(path) {
  const blobs = memoryAssets.get(currentSource?.url);
  if (blobs?.has(path)) return blobs.get(path);
  if (currentSource?.url?.startsWith("wasm:")) return "#";
  return joinUrl(currentSource.url, joinUrl("data", path));
}

/** Where the credit's logo lives for the current source. */
function funderLogoUrl(logo) {
  if (!logo) return null;
  const blobs = memoryAssets.get(currentSource?.url);
  // wasm libraries never touch the network for assets: the render put
  // the bytes in this tab's memory.
  if (blobs?.has(logo)) return blobs.get(logo);
  if (currentSource?.url?.startsWith("wasm:")) return null;
  return joinUrl(currentSource.url, joinUrl("data", logo));
}

// A pane that throws during start-up shows nothing at all, and Office
// says only that the add-in could not be started. Anything that goes
// wrong from here on has to end up on screen instead.
window.addEventListener("error", (e) => {
  setStatus(`The pane hit an error: ${e.message}`, "error");
});
window.addEventListener("unhandledrejection", (e) => {
  setStatus(`The pane hit an error: ${e.reason?.message ?? e.reason}`, "error");
});

Office.onReady((info) => {
  try {
    start(info);
  } catch (err) {
    setStatus(`The pane could not start: ${err.message}`, "error");
  }
});

function start(info) {
  try {
    applyOfficeTheme();
  } catch {
    /* older hosts have no officeTheme: the media query still applies */
  }
  if (info.host !== Office.HostType.PowerPoint) {
    setStatus("This add-in only runs in PowerPoint.", "error");
    return;
  }
  if (!Office.context.requirements.isSetSupported("PowerPointApi", "1.2")) {
    setStatus(
      "This PowerPoint build lacks PowerPointApi 1.2 (insertSlidesFromBase64 " +
        "with sourceSlideIds). Update Office to use the assembler.",
      "error"
    );
    return;
  }

  renderSourcePicker();
  switchSource(initialSource());

  $("source").addEventListener("change", (e) => {
    const source = allSources().find((s) => s.url === e.target.value) ?? null;
    switchSource(source);
  });
  $("branch").addEventListener("change", (e) => {
    if (!currentSource) return;
    branchBySource.set(currentSource.url, e.target.value);
    // The decks in memory are of the branch that was rendered, not this
    // one; keeping them would insert slides from the wrong version.
    memoryDecks.delete(currentSource.url);
    switchSource(currentSource);
  });
  $("add-source").addEventListener("click", addSource);
  $("remove-source").addEventListener("click", removeSource);
  $("new-source").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSource();
  });
  $("toggle-add").addEventListener("click", () => {
    const row = $("add-source-row");
    row.hidden = !row.hidden;
    if (!row.hidden) $("new-source").focus();
  });

  // Debounced so typing does not re-render the tree on every keystroke.
  let searchTimer = null;
  $("search").addEventListener("input", (e) => {
    const value = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = value;
      renderTree();
    }, 150);
  });

  $("competency").addEventListener("change", (e) => {
    competencyFilter = e.target.value;
    // Filtering hides everything that does not match, and what remains
    // is inside containers that may be shut — so the answer to "which
    // slides build this competency" was an unchanged wall of closed
    // rows. Opening the way down to each of them is the answer.
    if (competencyFilter) revealAllowed(allowedByCompetency());
    renderTree();
  });
  $("expand-all").addEventListener("click", toggleExpandAll);
  $("assemble").addEventListener("click", assemble);
}
