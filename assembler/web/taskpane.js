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
    // Open the roots so the pane never lands on a wall of collapsed rows.
    expanded = new Set(tree.map((_, i) => String(i)));
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
    const el = document.createElement("div");
    el.className = "hit";
    const row = document.createElement("label");
    row.className = "hit-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(hit.slideId);
    cb.addEventListener("change", () => toggleSlides([hit.slideId], cb.checked));
    const title = document.createElement("span");
    title.className = "hit-title";
    title.textContent = hit.slide.title ?? hit.slideId;
    const field = document.createElement("span");
    field.className = "hit-field";
    field.dataset.field = hit.field;
    field.textContent = hit.field;
    field.setAttribute("aria-label", `matched in ${hit.field}`);
    cb.setAttribute("aria-label", `Select ${hit.slide.title ?? hit.slideId}`);
    row.append(cb, title, field);
    const snip = document.createElement("p");
    snip.className = "hit-snippet";
    snip.textContent = hit.snippet;
    el.append(row, snip);
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

/** Expand every container, or collapse back to the roots. */
function toggleExpandAll() {
  expanded = everythingOpen()
    ? new Set(tree.map((_, i) => String(i)))
    : new Set(openablePaths());
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
        base64 = arrayBufferToBase64(bytes.buffer);
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
    renderTree();
  });
  $("expand-all").addEventListener("click", toggleExpandAll);
  $("assemble").addEventListener("click", assemble);
}
