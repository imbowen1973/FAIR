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
export function slideMeta(host, { slide, competencies, onChange }) {
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

  const compField = el("div", "meta-field grow");
  compField.append(el("label", null, "Develops"));
  const chips = el("div", "chips");
  const develops = data.develops ?? [];
  const entries = Object.entries(competencies || {});
  if (!entries.length) {
    chips.append(
      el("span", "hint", "No competencies/framework.yaml in this library.")
    );
  }
  for (const [cid, label] of entries) {
    const chip = el("button", "chip", cid);
    chip.type = "button";
    chip.title = label;
    if (develops.includes(cid)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      const next = develops.includes(cid)
        ? develops.filter((c) => c !== cid)
        : [...develops, cid];
      const slideNext = { ...data };
      if (next.length) slideNext.develops = next;
      else delete slideNext.develops;
      onChange(slideNext);
    });
    chips.appendChild(chip);
  }
  compField.append(chips);
  row.append(compField);
  host.append(row);

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
