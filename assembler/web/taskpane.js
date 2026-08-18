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

// Decks rendered in-browser (wasm sources), keyed by source url then
// sourcePptx. RAM only — nothing is stored anywhere.
const memoryDecks = new Map();

const DEFAULT_SOURCE = { name: "This corpus", url: "" };
const STORE_KEY = "fair.sources";

let catalog = null;
let currentSource = DEFAULT_SOURCE;
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

function loadStoredSources() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.url) : [];
  } catch {
    return [];
  }
}

function storeSources(sources) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sources));
  } catch {
    /* private-mode webviews: picker still works for this session */
  }
}

function allSources() {
  return [DEFAULT_SOURCE, ...loadStoredSources()];
}

function renderSourcePicker() {
  const select = $("source");
  select.innerHTML = "";
  for (const source of allSources()) {
    const opt = document.createElement("option");
    opt.value = source.url;
    opt.textContent = source.name;
    select.appendChild(opt);
  }
  select.value = currentSource.url;
}

async function loadCatalog(source) {
  if (source.url.startsWith("wasm:")) {
    const [owner, repo] = source.url.slice(5).split("/");
    const { loadLibraryFromGitHub } = await import("./wasm-renderer.js");
    const { catalog, decks } = await loadLibraryFromGitHub(owner, repo, setStatus);
    memoryDecks.set(source.url, decks);
    return catalog;
  }
  const res = await fetch(joinUrl(source.url, "data/catalog.json"));
  if (!res.ok) {
    throw new Error(
      source.url
        ? `no catalog at ${source.name} (${res.status}) — is the library published?`
        : "no local corpus here — add a library below: owner/repo renders in your browser"
    );
  }
  return res.json();
}

/** Forget a stored library. The built-in "This library" is not removable. */
function removeSource() {
  if (!currentSource.url) return;
  storeSources(loadStoredSources().filter((s) => s.url !== currentSource.url));
  renderSourcePicker();
  switchSource(DEFAULT_SOURCE);
}

async function switchSource(source) {
  currentSource = source;
  $("remove-source").hidden = !source.url;
  $("competency").disabled = true;
  $("step-assemble").hidden = true;
  // Selection is per-corpus: slide ids from the old catalog mean nothing here.
  selected = new Set();
  expanded = new Set();
  tree = [];
  setStatus(`Loading ${source.name}…`);
  try {
    catalog = await loadCatalog(source);
    tree = buildTree(catalog);
    // Open the roots so the pane never lands on a wall of collapsed rows.
    expanded = new Set(tree.map((_, i) => String(i)));
    renderCompetencyPicker();
    renderTree();
    updateSelectionSummary();
    setStatus("");
  } catch (err) {
    catalog = null;
    tree = [];
    renderTree();
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
  dok.textContent = node.meta.dok != null ? `DOK ${node.meta.dok}` : "";
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

  if (node.kind === "slide") {
    el.appendChild(slideRow(node, allowed));
    return el;
  }

  const open = expanded.has(path);
  const row = document.createElement("div");
  row.className = "node-row";

  const twisty = document.createElement("button");
  twisty.className = "twisty";
  twisty.textContent = open ? "▼" : "▶";
  twisty.setAttribute("aria-expanded", String(open));
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
  cb.addEventListener("change", () => toggleSlides(ids, cb.checked));

  const label = document.createElement("span");
  label.className = "node-label";
  label.textContent = node.title;

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
  if (!catalog) return;
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
}

/** Expand every container, or collapse back to the roots. */
function toggleExpandAll() {
  if (expanded.size > tree.length) {
    expanded = new Set(tree.map((_, i) => String(i)));
    $("expand-all").textContent = "Expand all";
  } else {
    expanded = new Set();
    const mark = (node, path) => {
      if (node.kind === "slide") return;
      expanded.add(path);
      node.children.forEach((c, i) => mark(c, `${path}/${i}`));
    };
    tree.forEach((root, i) => mark(root, String(i)));
    $("expand-all").textContent = "Collapse all";
  }
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
  // from git and fair_renderer runs in WebAssembly. git -> ppt, no
  // server, decks only in this tab's memory.
  const repo = parseRepoInput(input.value);
  if (repo) {
    const source = {
      name: `${repo.owner}/${repo.repo}`,
      url: `wasm:${repo.owner}/${repo.repo}`,
    };
    const stored = loadStoredSources();
    if (!stored.some((s) => s.url === source.url)) {
      stored.push(source);
      storeSources(stored);
    }
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
  const stored = loadStoredSources();
  if (!stored.some((s) => s.url === source.url) && source.url !== "") {
    stored.push(source);
    storeSources(stored);
  }
  input.value = "";
  renderSourcePicker();
  $("source").value = source.url;
  switchSource(source);
}

Office.onReady((info) => {
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
  switchSource(DEFAULT_SOURCE);

  $("source").addEventListener("change", (e) => {
    const source = allSources().find((s) => s.url === e.target.value) ?? DEFAULT_SOURCE;
    switchSource(source);
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
});
