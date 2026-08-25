// The WYSIWYG document editor.
//
// Milkdown (ProseMirror underneath, remark for markdown) rather than a
// hand-rolled contenteditable: a rich text editor is a deep problem —
// selection, paste, undo, tables, lists, IME — and none of that is what
// this project is for.
//
// Milkdown over the alternatives for one measured reason: it round-trips
// the marks authors already use. Toast UI rewrites `__underlined__` to
// `**bold**` and escapes `H~2~O` to `H\~2\~O`, which is content
// corruption rather than formatting. Milkdown keeps `^sup^`,
// `__underline__` and `~~strike~~` intact.
//
// What it does normalise, on the first edit and once only:
//
//   -  bullets       `- item`  ->  `* item`
//   -  table cells   padded to a common width
//   -  single tilde  `H~2~O`   ->  `H~~2~~O`
//
// The last one matters and is why the Markdown view exists beside this:
// a single tilde is GFM strikethrough, not subscript, so a workbook was
// never going to render `~2~` as subscript anywhere downstream. Milkdown
// is making the file say what it already meant — but an author who wants
// the file left exactly as it is can switch views and edit the source.
//
// Loaded from a CDN at first use. If that fails the caller falls back to
// the source editor, because an editor that silently does not appear is
// worse than one that says why.

const CREPE = "https://esm.sh/@milkdown/crepe@7?bundle";
const STYLES = [
  "https://cdn.jsdelivr.net/npm/@milkdown/crepe@7/lib/theme/common/style.css",
  "https://cdn.jsdelivr.net/npm/@milkdown/crepe@7/lib/theme/frame/style.css",
];

let modulePromise = null;

function loadStyles() {
  return Promise.all(
    STYLES.map((href) => {
      if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
      return new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        // Resolve either way: without the theme it is ugly, not broken,
        // and refusing to open the editor over a stylesheet would be worse.
        link.onload = resolve;
        link.onerror = resolve;
        document.head.appendChild(link);
      });
    })
  );
}

/** The editor module, fetched once per session. */
function loadCrepe() {
  if (!modulePromise) {
    modulePromise = Promise.all([import(/* @vite-ignore */ CREPE), loadStyles()])
      .then(([mod]) => mod.Crepe);
    modulePromise.catch(() => (modulePromise = null)); // allow a retry
  }
  return modulePromise;
}

/** Has it already been paid for this session? */
/**
 * What the editor produced, as markdown somebody would have written.
 *
 * ProseMirror keeps an empty paragraph as a node, and the serializer
 * writes it out as a literal `<br />` on its own line -- so pressing
 * Enter twice put an HTML tag into a lesson plan, and every blank line
 * after that multiplied. In markdown a blank line *is* the paragraph
 * break; it needs nothing else.
 *
 * Only breaks that stand alone are removed. A `<br />` at the end of a
 * line is a hard break inside a paragraph, which is a real thing to
 * write and is left exactly as it is.
 */
export function tidyMarkdown(text) {
  const NL = String.fromCharCode(10);
  const lines = String(text ?? "").split(NL);
  const kept = lines.map((line) =>
    /^\s*<br\s*\/?>\s*$/i.test(line) ? "" : line
  );
  const out = [];
  let blanks = 0;
  for (const line of kept) {
    if (line.trim() === "") {
      blanks += 1;
      // One blank line is a paragraph break. More than one says nothing
      // extra in markdown and renders identically.
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out.join(NL);
}


export function richReady() {
  return modulePromise !== null;
}

/**
 * A rich editor over `text` in `host`.
 *
 * Resolves to `{ setText, destroy }`, or rejects if the editor cannot be
 * loaded — the caller then falls back to editing the source.
 *
 * onChange(markdown) fires only on real edits. Milkdown emits an update
 * as it loads, and committing that would rewrite a document nobody
 * touched: opening a workbook must not change a single byte.
 */
export async function richEditor(host, { text, onChange }) {
  const Crepe = await loadCrepe();
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "rich";
  host.appendChild(root);

  const original = text ?? "";
  // What the editor makes of the file, which is not always the file:
  // hyphen bullets come back as asterisks, table cells get padded. That
  // is the baseline an edit is measured against, so *opening* a document
  // is never a change -- only typing in one is.
  let baseline = original;
  let ready = false;
  const crepe = new Crepe({ root, defaultValue: original });
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      if (!ready || markdown === baseline) return;
      onChange?.(tidyMarkdown(markdown));
    });
  });
  await crepe.create();
  baseline = tidyMarkdown(crepe.getMarkdown());
  ready = true;

  // No setText: ProseMirror owns its document state, and pushing new
  // content into a live editor is how you lose an author's cursor and
  // undo history. Switching documents rebuilds the editor instead.
  return {
    markdown: () => tidyMarkdown(crepe.getMarkdown()),
    /**
     * Whether opening the file reformatted it. The caller says so once,
     * rather than letting an author discover it in a diff.
     */
    normalised: baseline.trimEnd() !== original.trimEnd(),
    destroy: () => crepe.destroy(),
  };
}
