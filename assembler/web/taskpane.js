// Task pane wiring: library picker -> catalog -> competency picker ->
// slide list -> insert. Implements spec B.3/B.4 plus git-published
// libraries (platform-architecture.md, public phase). All query logic
// lives in assembler.js.

import {
  arrayBufferToBase64,
  buildInsertPlan,
  joinUrl,
  normalizeSource,
  slidesForCompetency,
  usedCompetencies,
} from "./assembler.js";

const DEFAULT_SOURCE = { name: "This library", url: "" };
const STORE_KEY = "fair.sources";

let catalog = null;
let currentGroups = new Map();
let currentSource = DEFAULT_SOURCE;

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
  const res = await fetch(joinUrl(source.url, "data/catalog.json"));
  if (!res.ok) {
    throw new Error(
      source.url
        ? `no catalog at ${source.name} (${res.status}) — is the library published?`
        : `catalog.json not found (${res.status}) — run scripts/build_corpus.py first`
    );
  }
  return res.json();
}

async function switchSource(source) {
  currentSource = source;
  $("competency").disabled = true;
  $("step-slides").hidden = true;
  $("step-assemble").hidden = true;
  setStatus(`Loading ${source.name}…`);
  try {
    catalog = await loadCatalog(source);
    renderCompetencyPicker();
    setStatus("");
  } catch (err) {
    catalog = null;
    setStatus(err.message, "error");
  }
}

function renderCompetencyPicker() {
  const select = $("competency");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a competency…";
  select.appendChild(placeholder);
  for (const { id, label } of usedCompetencies(catalog)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label === id ? id : `${id} — ${label}`;
    select.appendChild(opt);
  }
  select.disabled = false;
}

function sessionTitle(sourcePptx) {
  const session = catalog.sessions.find((s) => s.pptx === sourcePptx);
  return session ? `Session ${session.sessionId}: ${session.title}` : sourcePptx;
}

function renderSlideList(cId) {
  currentGroups = slidesForCompetency(catalog, cId);
  const container = $("slide-list");
  container.innerHTML = "";

  if (currentGroups.size === 0) {
    container.textContent = "No slides develop this competency.";
  }

  for (const [sourcePptx, slides] of currentGroups) {
    const group = document.createElement("div");
    group.className = "session-group";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = sessionTitle(sourcePptx);
    group.appendChild(title);

    for (const slide of slides) {
      const row = document.createElement("label");
      row.className = "slide-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.slideId = slide.slideId;
      const text = document.createElement("span");
      text.textContent = slide.title ?? slide.slideId;
      const dok = document.createElement("span");
      dok.className = "dok";
      dok.textContent = slide.dok != null ? `DOK ${slide.dok}` : "";
      row.append(cb, text, dok);
      group.appendChild(row);
    }
    container.appendChild(group);
  }

  $("step-slides").hidden = false;
  $("step-assemble").hidden = currentGroups.size === 0;
}

function selectedSlideIds() {
  const ids = new Set();
  for (const cb of $("slide-list").querySelectorAll("input[type=checkbox]:checked")) {
    ids.add(cb.dataset.slideId);
  }
  return ids;
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
    const plan = buildInsertPlan(currentGroups, selectedSlideIds());
    if (plan.length === 0) {
      setStatus("Nothing selected.", "error");
      return;
    }
    let anchorId = await resolveAnchor();
    let inserted = 0;
    for (const step of plan) {
      setStatus(`Fetching ${step.sourcePptx}…`);
      const deckUrl = joinUrl(currentSource.url, joinUrl("data", step.sourcePptx));
      const res = await fetch(deckUrl);
      if (!res.ok) throw new Error(`fetch failed for ${step.sourcePptx} (${res.status})`);
      const base64 = arrayBufferToBase64(await res.arrayBuffer());

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
  const source = normalizeSource(input.value);
  if (!source) {
    setStatus("Enter the https URL of a corpus server (its catalog or site root).", "error");
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
  $("new-source").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSource();
  });

  $("competency").addEventListener("change", (e) => {
    const cId = e.target.value;
    if (cId) renderSlideList(cId);
    else {
      $("step-slides").hidden = true;
      $("step-assemble").hidden = true;
    }
  });
  $("assemble").addEventListener("click", assemble);
});
