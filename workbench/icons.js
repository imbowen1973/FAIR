// A small inline icon set.
//
// SVG rather than emoji or an icon font: these have to sit next to text
// at 14px, follow the theme through `currentColor`, and stay crisp in
// both light and dark. An icon font would be a network dependency for
// nine glyphs, and emoji render differently on every platform — and
// carry colour we do not control.
//
// Each is a 16x16 stroke path so they share weight with the UI text.

const PATHS = {
  // A tick: "check" runs the validator.
  check: "M3 8.5l3.5 3.5L13 5",
  // A slide with a play mark: render the real deck.
  preview: "M2 3h12v10H2z M6.5 6.5l3.5 2-3.5 2z",
  // A clock hand sweeping back: commits over time.
  history: "M8 4v4l2.5 2M14 8a6 6 0 1 1-2-4.5M14 2v3h-3",
  // A branch: save commits to the draft branch.
  save: "M5 3v10M5 3a1.5 1.5 0 1 0 0 .01M5 13a1.5 1.5 0 1 0 0 .01M12 6a1.5 1.5 0 1 0 0 .01M12 7.5c0 2-3 1.5-5 3",
  // A pull request arrow: submit for review.
  submit: "M4 4v8M4 4a1.5 1.5 0 1 0 0 .01M4 12a1.5 1.5 0 1 0 0 .01M12 12V6l-2.5 2.5M12 6l2.5 2.5M12 12a1.5 1.5 0 1 0 0 .01",
  // A folder: open a library.
  open: "M2 4h4l1.5 2H14v7H2z",
  // A plus in a frame: add a slide.
  add: "M3 3h10v10H3z M8 6v4M6 8h4",
  // Chevron for the picker.
  chevron: "M4 6l4 4 4-4",
  // Arrows curving back and forward: undo and redo.
  undo: "M5.5 3.5l-3 3 3 3M2.5 6.5h6a4 4 0 1 1 0 8H5",
  redo: "M10.5 3.5l3 3-3 3M13.5 6.5h-6a4 4 0 1 0 0 8H11",
  // A framed picture: two peaks and a sun. The universal image glyph,
  // and it has to be that -- this was a box-drawing character, which
  // read as nothing at all.
  media:
    "M2 3.5h12v9H2z M2.5 12l3.5-4 2.5 2.5M8 10.5l2-2 3.5 3.5" +
    "M10.6 6.3a1 1 0 1 0 0 .01",
};

/**
 * An <svg> for `name`, sized to sit on a text line.
 * Decorative by default — the button's own label carries the meaning.
 */
export function icon(name, { size = 15 } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name] ?? "");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

/** Put an icon in front of a button's existing text. */
export function decorate(button, name) {
  if (!button || button.querySelector(".icon")) return button;
  button.prepend(icon(name));
  button.classList.add("with-icon");
  return button;
}
