// A small mark-aware text field.
//
// Deliberately not Tiptap. Four of our six marks — superscript,
// subscript, strikethrough, inline code in *this* syntax — are not
// Tiptap defaults, so each would need a custom extension with custom
// input rules and a custom serializer. That is more code than this, plus
// a dependency, plus a second definition of the grammar that could drift
// from runs.py. Here the grammar lives in marks.js and both the renderer
// and the editor read from it.
//
// The field edits spans, never raw markdown, and serialises on change.
// If the incoming text does not round-trip (an odd nesting, an unclosed
// marker), the field refuses to open and the caller shows a source box
// instead — better to hand the author their own text back than to
// quietly rewrite it.

import { MARKS, parseMarks, roundTrips, serializeMarks } from "./marks.js";

const TAG = {
  bold: "strong",
  italic: "em",
  superscript: "sup",
  subscript: "sub",
  strike: "s",
  underline: "u",
  code: "code",
};

/** Spans -> DOM, innermost mark closest to the text. */
function spansToHtml(spans) {
  return spans
    .map((span) => {
      const el = document.createTextNode(span.text);
      let node = el;
      for (const mark of MARKS) {
        if (!span[mark]) continue;
        const wrapper = document.createElement(TAG[mark]);
        wrapper.appendChild(node);
        node = wrapper;
      }
      const holder = document.createElement("div");
      holder.appendChild(node);
      return holder.innerHTML;
    })
    .join("");
}

/** DOM -> spans, walking the tree and collecting marks on the way down. */
function htmlToSpans(root) {
  const spans = [];
  const walk = (node, marks) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) spans.push({ text: child.textContent, ...marks });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      const mark = Object.keys(TAG).find((m) => TAG[m] === tag);
      if (tag === "br") {
        spans.push({ text: "\n", ...marks });
        continue;
      }
      walk(child, mark ? { ...marks, [mark]: true } : marks);
    }
  };
  walk(root, Object.fromEntries(MARKS.map((m) => [m, false])));
  return spans;
}

const COMMANDS = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikeThrough",
  superscript: "superscript",
  subscript: "subscript",
};

/**
 * Turn `host` into an editable field for `text`.
 * Calls onChange(markdown) whenever the content changes.
 *
 * Returns {editable, setText, destroy} or null when the text cannot be
 * represented safely — the caller then falls back to a plain textarea.
 */
export function richText(host, text, onChange, { multiline = false } = {}) {
  if (!roundTrips(text)) return null;

  host.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "marks";

  const editable = document.createElement("div");
  editable.className = "rt";
  editable.contentEditable = "true";
  editable.spellcheck = true;
  editable.innerHTML = spansToHtml(parseMarks(text));

  const emit = () => onChange(serializeMarks(htmlToSpans(editable)));

  for (const [mark, command] of Object.entries(COMMANDS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mark";
    button.dataset.mark = mark;
    button.title = mark;
    button.setAttribute("aria-label", mark);
    button.textContent = { bold: "B", italic: "I", underline: "U", strike: "S", superscript: "x²", subscript: "x₂" }[mark];
    // mousedown, not click: click would move focus out of the field first
    // and the selection the command applies to would already be gone.
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.execCommand(command);
      emit();
    });
    bar.appendChild(button);
  }

  const codeButton = document.createElement("button");
  codeButton.type = "button";
  codeButton.className = "mark";
  codeButton.title = "inline code";
  codeButton.setAttribute("aria-label", "inline code");
  codeButton.textContent = "‹›";
  codeButton.addEventListener("mousedown", (e) => {
    e.preventDefault();
    // No execCommand for <code>: wrap the selection by hand.
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const code = document.createElement("code");
    try {
      range.surroundContents(code);
      emit();
    } catch {
      /* selection spans element boundaries: leave it alone */
    }
  });
  bar.appendChild(codeButton);

  editable.addEventListener("input", emit);
  editable.addEventListener("keydown", (e) => {
    // Enter inserts a paragraph break by default, which our grammar has
    // no notion of inside a single text value.
    if (e.key === "Enter" && !multiline) e.preventDefault();
    if (e.key === "Enter" && multiline && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      emit();
    }
  });
  // Paste as plain text: pasted HTML would carry fonts and colours the
  // template owns, and marks we have no syntax for.
  editable.addEventListener("paste", (e) => {
    e.preventDefault();
    const plain = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, plain);
  });

  host.append(bar, editable);

  return {
    editable,
    setText(next) {
      editable.innerHTML = spansToHtml(parseMarks(next));
    },
    destroy() {
      host.innerHTML = "";
    },
  };
}
