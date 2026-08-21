// What sits below the slide: its identity, its meaning, and the words
// you will say.
//
// Everything here is real content that has nowhere to live on the canvas.
// Speaker notes in particular are the largest thing an author writes and
// never appear on the slide, so they get the room — a deck's notes are
// usually longer than its bullets.

import { richText } from "./richtext.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build the metadata strip.
 * onChange(nextSlideData) fires on every edit.
 */
export function slideMeta(host, { slide, competencies, outcomes, onChange }) {
  host.innerHTML = "";
  const data = slide || {};

  const row = el("div", "meta-row");

  const idField = el("div", "meta-field");
  idField.append(el("label", null, "Slide id"));
  const id = el("input", "text");
  id.value = data.id ?? "";
  id.size = 12;
  id.title =
    "Stable identity. Changing it changes the slide's creationId, so a deck " +
    "assembled from this slide before the change will not match it after.";
  id.addEventListener("change", () => onChange({ ...data, id: id.value }));
  idField.append(id);
  row.append(idField);

  const dokField = el("div", "meta-field");
  dokField.append(el("label", null, "Depth of knowledge"));
  const dok = el("select", "dok");
  for (const level of ["", "1", "2", "3", "4"]) {
    const option = el("option", null, level || "not set");
    option.value = level;
    dok.appendChild(option);
  }
  dok.value = data.dok != null ? String(data.dok) : "";
  dok.addEventListener("change", () => {
    const next = { ...data };
    if (dok.value) next.dok = Number(dok.value);
    else delete next.dok;
    onChange(next);
  });
  dokField.append(dok);
  row.append(dokField);

  // What the slide is *for*. The competencies below follow from this:
  // a slide cannot claim more than the outcomes it serves.
  const outField = el("div", "meta-field grow");
  outField.append(el("label", null, "Serves outcomes"));
  const outChips = el("div", "chips");
  const serves = (data.outcomes ?? []).map(String);
  const outEntries = Object.entries(outcomes || {});
  if (!outEntries.length) {
    outChips.append(
      el("span", "hint", "No outcomes.yaml yet — add outcomes from the course entry above the blocks.")
    );
  }
  for (const [oid, outcome] of outEntries) {
    const chip = el("button", "chip", oid);
    chip.type = "button";
    chip.title = outcome.statement || oid;
    if (serves.includes(oid)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      const next = serves.includes(oid)
        ? serves.filter((o) => o !== oid)
        : [...serves, oid];
      const slideNext = { ...data };
      if (next.length) slideNext.outcomes = next;
      else delete slideNext.outcomes;
      onChange(slideNext);
    });
    outChips.appendChild(chip);
  }
  outField.append(outChips);
  row.append(outField);
  host.append(row);

  // Derived, and shown read-only so an author can see what the slide
  // actually claims rather than having to work it out from the outcomes.
  const derived = [];
  for (const oid of serves) {
    for (const cid of outcomes?.[oid]?.develops ?? []) {
      if (!derived.includes(cid)) derived.push(cid);
    }
  }
  const direct = (data.develops ?? []).filter((c) => !derived.includes(c));

  const compRow = el("div", "meta-row");
  const compField = el("div", "meta-field grow");
  compField.append(el("label", null, "Develops"));
  const chips = el("div", "chips");
  const entries = Object.entries(competencies || {});
  if (!entries.length) {
    chips.append(
      el("span", "hint", "No competencies/framework.yaml in this library.")
    );
  }
  for (const cid of derived) {
    const chip = el("span", "chip on derived", cid);
    chip.title =
      `${competencies?.[cid] ?? cid} — from ` +
      serves.filter((o) => (outcomes?.[o]?.develops ?? []).includes(cid)).join(", ");
    chips.appendChild(chip);
  }
  for (const [cid, label] of entries) {
    if (derived.includes(cid)) continue; // already shown, and not removable here
    const chip = el("button", "chip", cid);
    chip.type = "button";
    chip.title = label;
    if (direct.includes(cid)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      const next = direct.includes(cid)
        ? direct.filter((c) => c !== cid)
        : [...direct, cid];
      const slideNext = { ...data };
      if (next.length) slideNext.develops = next;
      else delete slideNext.develops;
      onChange(slideNext);
    });
    chips.appendChild(chip);
  }
  compField.append(chips);
  if (derived.length) {
    compField.append(
      el("p", "hint", "Filled chips come from the outcomes above. Click a competency to add one directly.")
    );
  }
  compRow.append(compField);
  host.append(compRow);

  const notes = el("div", "notes");
  const head = el("div", "notes-head");
  head.append(el("h3", null, "Speaker notes"));
  const count = el("span", "muted");
  const words = (data.notes ?? "").trim().split(/\s+/).filter(Boolean).length;
  // At a normal speaking pace, roughly 130 words a minute.
  count.textContent = words
    ? `${words} words · about ${Math.max(1, Math.round(words / 130))} min`
    : "";
  head.append(count);
  notes.append(head);

  const field = el("div", "notes-field");
  const rich = richText(
    field,
    data.notes ?? "",
    (value) => onChange({ ...data, notes: value }),
    { multiline: true }
  );
  if (!rich) {
    const area = el("textarea", "source");
    area.rows = 6;
    area.value = data.notes ?? "";
    area.addEventListener("input", () => onChange({ ...data, notes: area.value }));
    field.append(
      el("p", "warn", "These notes use markup the editor cannot show visually — editing as source."),
      area
    );
  }
  notes.append(field);
  host.append(notes);
}
