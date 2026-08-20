// Marks <-> DOM, shared by everything that shows or edits marked text.
//
// One definition, because the editable slide, the field editor and the
// thumbnail all have to agree about what `H~2~O` looks like. Two
// implementations would drift, and the drift would only show up as a
// diff nobody meant to make.

import { MARKS, parseMarks, serializeMarks } from "./marks.js";

export const TAG = {
  bold: "strong",
  italic: "em",
  superscript: "sup",
  subscript: "sub",
  strike: "s",
  underline: "u",
  code: "code",
};

const TAG_TO_MARK = Object.fromEntries(
  Object.entries(TAG).map(([mark, tag]) => [tag, mark])
);
// What contenteditable actually produces, whatever we asked for.
Object.assign(TAG_TO_MARK, {
  b: "bold",
  i: "italic",
  strike: "strike",
  del: "strike",
  ins: "underline",
});

/** Marked-up text -> nodes, innermost mark closest to the text. */
export function toNodes(text) {
  const fragment = document.createDocumentFragment();
  for (const span of parseMarks(text ?? "")) {
    let node = document.createTextNode(span.text);
    for (const mark of MARKS) {
      if (!span[mark]) continue;
      const wrapper = document.createElement(TAG[mark]);
      wrapper.appendChild(node);
      node = wrapper;
    }
    fragment.appendChild(node);
  }
  return fragment;
}

export function toHtml(text) {
  const holder = document.createElement("div");
  holder.appendChild(toNodes(text));
  return holder.innerHTML;
}

/** An edited element -> marked-up text. */
export function fromElement(root) {
  const spans = [];
  const walk = (node, marks) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) spans.push({ text: child.textContent, ...marks });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "br") {
        spans.push({ text: "\n", ...marks });
        continue;
      }
      // A browser may express a mark as a style rather than a tag.
      const style = child.getAttribute?.("style") || "";
      const inferred = [];
      if (/font-weight:\s*(bold|[6-9]00)/.test(style)) inferred.push("bold");
      if (/font-style:\s*italic/.test(style)) inferred.push("italic");
      if (/text-decoration[^;]*underline/.test(style)) inferred.push("underline");
      if (/text-decoration[^;]*line-through/.test(style)) inferred.push("strike");

      const mark = TAG_TO_MARK[tag];
      const next = { ...marks };
      if (mark) next[mark] = true;
      for (const extra of inferred) next[extra] = true;
      walk(child, next);
    }
  };
  walk(root, Object.fromEntries(MARKS.map((m) => [m, false])));
  return serializeMarks(spans);
}
