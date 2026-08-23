// Changing a slide's layout, without losing what is in it.
//
// Layouts do not offer the same regions, so some changes have nowhere to
// put some of the content. Silently keeping the old key looked harmless
// and was not: the canvas stopped drawing it and the renderer refuses an
// unknown region, so an author saw their words disappear and found out
// why at build time.
//
// This asks. It names every region that has nowhere to go, offers the
// free regions of the new layout, and defaults to pairing them off in
// order — which is right often enough to be a single click, and visible
// enough to be corrected when it is not.

import { layoutChange, layoutRegions } from "./library.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A short, readable summary of what is in a region. */
export function describeRegion(value) {
  if (value == null) return "empty";
  if (typeof value === "string") return `"${value.slice(0, 40)}"`;
  if (Array.isArray(value.items)) {
    const n = value.items.length;
    return `${n} item${n === 1 ? "" : "s"}`;
  }
  if (value.src) return `image ${String(value.src).split("/").pop()}`;
  if (value.url) return "a video";
  if (typeof value.text === "string") return `"${value.text.slice(0, 40)}"`;
  return "content";
}

/**
 * Ask where orphaned content should go, then apply.
 *
 * onApply(moves)  moves maps each orphaned region to a region of the new
 *                 layout, or "" to discard it.
 * onCancel()      the layout is not changed at all.
 */
export function relayoutPanel(host, { slide, layoutMap, nextLayout, onApply, onCancel }) {
  const { orphans, free, suggested } = layoutChange(slide, layoutMap, nextLayout);
  const panel = el("div", "import-panel relayout-panel");
  panel.append(el("h4", null, `Change layout to ${nextLayout}`));
  panel.append(
    el(
      "p",
      "hint",
      free.length
        ? `${nextLayout} does not have ${orphans.length === 1 ? "a region" : "regions"} ` +
          `called ${orphans.join(", ")}. Say where that content should go, ` +
          "or it will be dropped."
        : `${nextLayout} has nowhere to put ${orphans.join(", ")}. ` +
          "Changing to it will drop that content."
    )
  );

  const selects = new Map();
  for (const region of orphans) {
    const row = el("div", "relayout-row");
    row.append(el("span", "relayout-from", `${region} — ${describeRegion(slide[region])}`));
    row.append(el("span", "relayout-arrow", "→"));

    const pick = el("select", "layout");
    // "Discard" is always last and never the default while somewhere
    // remains to put the content.
    for (const target of free) {
      const option = el("option", null, target);
      option.value = target;
      pick.append(option);
    }
    const drop = el("option", null, "discard it");
    drop.value = "";
    pick.append(drop);
    pick.value = suggested[region] ?? "";
    pick.setAttribute("aria-label", `Where ${region} should go`);
    selects.set(region, pick);
    row.append(pick);
    panel.append(row);
  }

  // Two orphans cannot go to the same place: the second would overwrite
  // the first, which is the loss this whole panel exists to prevent.
  const warning = el("p", "warn");
  panel.append(warning);
  const review = () => {
    const chosen = [...selects.values()].map((s) => s.value).filter(Boolean);
    const clash = chosen.find((v, i) => chosen.indexOf(v) !== i);
    warning.textContent = clash
      ? `Two of these would go into ${clash}, and one would overwrite the other.`
      : "";
    apply.disabled = Boolean(clash);
  };

  const actions = el("div", "card-actions");
  const apply = el("button", "primary", "Change layout");
  apply.type = "button";
  const cancel = el("button", "link", "Keep the layout it has");
  cancel.type = "button";
  actions.append(apply, cancel);
  panel.append(actions);

  for (const pick of selects.values()) pick.addEventListener("change", review);
  apply.addEventListener("click", () => {
    const moves = {};
    for (const [region, pick] of selects) moves[region] = pick.value;
    onApply?.(moves);
  });
  cancel.addEventListener("click", () => onCancel?.());

  host.innerHTML = "";
  host.append(panel);
  review();
  panel.scrollIntoView({ block: "nearest" });
  return panel;
}

/** Whether changing to `nextLayout` needs asking at all. */
export function needsAsking(slide, layoutMap, nextLayout) {
  if (!layoutRegions(layoutMap, nextLayout).length) return false;
  return layoutChange(slide, layoutMap, nextLayout).orphans.length > 0;
}
