// The slide form — derived from the layout, never hard-coded.
//
// A slide's legal regions come from layout-map.yaml, which comes from the
// library's own template. So the form an author sees is generated from
// their designer's file: change the template, rebind it with
// fair-template, and the form changes with it. There is no list of
// regions anywhere in this file, which is the point.
//
// It offers geometry nowhere: no sizes, no positions, no colours beyond
// the theme slots the grammar allows. Those belong to the template, and
// a form that offered them would recreate the failure the renderer exists
// to prevent.

import { CONTENT_TYPES, layoutRegions, slideRegions } from "./library.js";
import { richText } from "./richtext.js";

const THEME_COLOURS = [
  "",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "dk1",
  "lt1",
  "dk2",
  "lt2",
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelled(text, control, hint) {
  const wrap = el("div", "field");
  const label = el("label", null, text);
  wrap.append(label, control);
  if (hint) wrap.append(el("p", "hint", hint));
  return wrap;
}

/** A text value that may carry inline marks. */
function textField(value, onChange, { multiline = false } = {}) {
  const host = el("div", "rt-host");
  const rich = richText(host, value ?? "", onChange, { multiline });
  if (rich) return host;

  // Could not be represented safely: hand back the author's own source.
  const area = el("textarea", "source");
  area.value = value ?? "";
  area.rows = multiline ? 5 : 2;
  area.addEventListener("input", () => onChange(area.value));
  host.append(
    el("p", "warn", "This text uses markup the editor cannot show visually — editing as source."),
    area
  );
  return host;
}

/** One item of a ul/ol, with its nesting and optional colour. */
function listItem(item, depth, onChange, onRemove) {
  const row = el("div", "item");
  row.style.marginLeft = `${depth * 16}px`;

  const text = typeof item === "string" ? item : item.text ?? "";
  row.append(
    textField(text, (next) => {
      if (typeof item === "string") onChange(next);
      else onChange({ ...item, text: next });
    })
  );

  const tools = el("div", "item-tools");
  const colour = el("select", "colour");
  for (const slot of THEME_COLOURS) {
    const option = el("option", null, slot || "colour");
    option.value = slot;
    colour.appendChild(option);
  }
  colour.value = typeof item === "object" ? item.color ?? "" : "";
  colour.addEventListener("change", () => {
    const base = typeof item === "string" ? { text: item } : { ...item };
    if (colour.value) base.color = colour.value;
    else delete base.color;
    onChange(base.color || base.items ? base : base.text);
  });

  const remove = el("button", "link danger", "remove");
  remove.type = "button";
  remove.addEventListener("click", onRemove);

  tools.append(colour, remove);
  row.appendChild(tools);
  return row;
}

/** Editor for one region's value, offering only that type's shape. */
function regionEditor(value, onChange) {
  const host = el("div", "region-editor");

  const type = el("select", "type");
  for (const candidate of ["text", ...CONTENT_TYPES]) {
    const option = el("option", null, candidate);
    option.value = candidate;
    type.appendChild(option);
  }
  const current = typeof value === "string" || value == null ? "text" : value.type;
  type.value = current;
  type.addEventListener("change", () => {
    const next = type.value;
    if (next === "text") onChange("");
    else if (next === "ul" || next === "ol") onChange({ type: next, items: [""] });
    else if (next === "p") onChange({ type: "p", text: "" });
    else if (next === "video") onChange({ type: "video", url: "" });
    else onChange({ type: next, src: "" });
  });
  host.append(labelled("Content type", type));

  if (current === "text") {
    host.append(textField(value ?? "", onChange));
    return host;
  }

  if (current === "p") {
    host.append(
      textField(value.text ?? "", (next) => onChange({ ...value, text: next }), {
        multiline: true,
      })
    );
  }

  if (current === "ul" || current === "ol") {
    const items = value.items ?? [];
    const list = el("div", "items");
    items.forEach((item, index) => {
      list.appendChild(
        listItem(
          item,
          0,
          (next) => {
            const copy = [...items];
            copy[index] = next;
            onChange({ ...value, items: copy });
          },
          () => onChange({ ...value, items: items.filter((_, i) => i !== index) })
        )
      );
      // Nested items, one level shown inline; deeper nesting is rare and
      // stays editable as source.
      const children = typeof item === "object" ? item.items ?? [] : [];
      children.forEach((child, childIndex) => {
        list.appendChild(
          listItem(
            child,
            1,
            (next) => {
              const copy = [...items];
              const nested = [...children];
              nested[childIndex] = next;
              copy[index] = { ...item, items: nested };
              onChange({ ...value, items: copy });
            },
            () => {
              const copy = [...items];
              copy[index] = {
                ...item,
                items: children.filter((_, i) => i !== childIndex),
              };
              onChange({ ...value, items: copy });
            }
          )
        );
      });
    });

    const add = el("button", "link", "+ item");
    add.type = "button";
    add.addEventListener("click", () =>
      onChange({ ...value, items: [...items, ""] })
    );
    host.append(list, add);
  }

  if (current === "image" || current === "mermaid") {
    const src = el("input", "text");
    src.value = value.src ?? "";
    src.placeholder = "media/chart.png";
    src.addEventListener("input", () => onChange({ ...value, src: src.value }));
    host.append(labelled("Path, relative to the block", src));
  }

  if (current === "video") {
    const url = el("input", "text");
    url.value = value.url ?? "";
    url.placeholder = "https://…";
    url.addEventListener("input", () => onChange({ ...value, url: url.value }));
    host.append(
      labelled("Hosted video URL", url, "Video is never committed — only the link.")
    );
  }

  const colour = el("select", "colour");
  for (const slot of THEME_COLOURS) {
    const option = el("option", null, slot || "no colour");
    option.value = slot;
    colour.appendChild(option);
  }
  colour.value = value.color ?? "";
  colour.addEventListener("change", () => {
    const next = { ...value };
    if (colour.value) next.color = colour.value;
    else delete next.color;
    onChange(next);
  });
  if (["ul", "ol", "p"].includes(current)) {
    host.append(labelled("Colour", colour, "Theme slots only — the template owns the palette."));
  }

  return host;
}

/**
 * Build the whole slide form.
 *
 * onChange(nextSlideData) fires on every edit; onFocusRegion(name) lets
 * the schematic highlight what is being edited.
 */
export function slideForm(host, { slide, layoutMap, competencies, onChange, onFocusRegion }) {
  host.innerHTML = "";
  const data = slide || {};

  const layout = el("select", "layout");
  for (const key of Object.keys(layoutMap).filter((k) => !k.startsWith("_"))) {
    const option = el("option", null, key);
    option.value = key;
    layout.appendChild(option);
  }
  layout.value = data.layout ?? "";
  layout.addEventListener("change", () => onChange({ ...data, layout: layout.value }));
  host.append(labelled("Layout", layout, "From this library's template."));

  const id = el("input", "text");
  id.value = data.id ?? "";
  id.addEventListener("input", () => onChange({ ...data, id: id.value }));
  host.append(
    labelled("Slide id", id, "Stable identity — changing it changes the slide's creationId.")
  );

  const legal = layoutRegions(layoutMap, data.layout);
  const present = slideRegions(data);

  for (const region of legal) {
    const box = el("section", "region-field");
    const head = el("div", "region-head");
    head.append(el("h3", null, region));

    const has = region in data;
    const toggle = el("button", "link", has ? "clear" : "+ add");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      const next = { ...data };
      if (has) delete next[region];
      else next[region] = "";
      onChange(next);
    });
    head.append(toggle);
    box.append(head);

    if (has) {
      box.addEventListener("focusin", () => onFocusRegion?.(region));
      box.append(
        regionEditor(data[region], (value) => onChange({ ...data, [region]: value }))
      );
    }
    host.append(box);
  }

  // Regions the slide carries that this layout does not offer. The build
  // rejects these, so surface them here rather than at commit time.
  for (const region of present.filter((r) => !legal.includes(r))) {
    const box = el("section", "region-field invalid");
    box.append(
      el("h3", null, region),
      el(
        "p",
        "warn",
        `Layout ${data.layout} has no region called "${region}". It offers: ${legal.join(", ") || "none"}.`
      )
    );
    const drop = el("button", "link danger", "remove this region");
    drop.type = "button";
    drop.addEventListener("click", () => {
      const next = { ...data };
      delete next[region];
      onChange(next);
    });
    box.append(drop);
    host.append(box);
  }

  const meta = el("section", "region-field");
  meta.append(el("h3", null, "Meaning"));

  const chips = el("div", "chips");
  const develops = data.develops ?? [];
  for (const [cid, label] of Object.entries(competencies || {})) {
    const chip = el("button", "chip", cid);
    chip.type = "button";
    chip.title = label;
    if (develops.includes(cid)) chip.classList.add("on");
    chip.addEventListener("click", () => {
      const next = develops.includes(cid)
        ? develops.filter((c) => c !== cid)
        : [...develops, cid];
      onChange({ ...data, develops: next });
    });
    chips.appendChild(chip);
  }
  meta.append(labelled("Develops", chips, "From competencies/framework.yaml."));

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
  meta.append(labelled("Depth of knowledge", dok));
  host.append(meta);

  const notes = el("section", "region-field");
  notes.append(el("h3", null, "Speaker notes"));
  notes.append(
    textField(data.notes ?? "", (value) => onChange({ ...data, notes: value }), {
      multiline: true,
    })
  );
  host.append(notes);
}
