// Task pane wiring: catalog -> competency picker -> slide list -> insert.
// Implements spec B.3/B.4. All query logic lives in assembler.js.

import {
  arrayBufferToBase64,
  buildInsertPlan,
  slidesForCompetency,
  usedCompetencies,
} from "./assembler.js";

let catalog = null;
let currentGroups = new Map();

const $ = (id) => document.getElementById(id);

function setStatus(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
  el.hidden = !message;
}

async function loadCatalog() {
  const res = await fetch("data/catalog.json");
  if (!res.ok) {
    throw new Error(
      `catalog.json not found (${res.status}) — run scripts/build_corpus.py first`
    );
  }
  return res.json();
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

async function assemble() {
  const button = $("assemble");
  button.disabled = true;
  try {
    const plan = buildInsertPlan(currentGroups, selectedSlideIds());
    if (plan.length === 0) {
      setStatus("Nothing selected.", "error");
      return;
    }
    let inserted = 0;
    for (const step of plan) {
      setStatus(`Fetching ${step.sourcePptx}…`);
      const res = await fetch(`data/${step.sourcePptx}`);
      if (!res.ok) throw new Error(`fetch failed for ${step.sourcePptx} (${res.status})`);
      const base64 = arrayBufferToBase64(await res.arrayBuffer());

      setStatus(`Inserting ${step.sourceRefs.length} slide(s) from ${step.sourcePptx}…`);
      // Spec B.3: one insert call per source deck, selecting slides by
      // the renderer-emitted slideId#creationId sourceRefs.
      await PowerPoint.run(async (context) => {
        context.presentation.insertSlidesFromBase64(base64, {
          formatting: PowerPoint.InsertSlideFormatting.useDestinationTheme,
          sourceSlideIds: step.sourceRefs,
        });
        await context.sync();
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

  loadCatalog()
    .then((data) => {
      catalog = data;
      renderCompetencyPicker();
      setStatus("");
    })
    .catch((err) => setStatus(err.message, "error"));

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
