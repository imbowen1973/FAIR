// Rendering markdown into Word, in the browser.
//
// Same trick as wasm-renderer.js and for the same reason: the renderer is
// Python, and Pyodide runs it in the tab. Nothing is uploaded, nothing is
// stored, and there is no server to install.
//
// The Word half needs a different set of packages from the PowerPoint
// half — python-docx and markdown-it-py rather than python-pptx — so it
// has its own loader. A pane only ever uses one of the two, so nothing
// pays for the other's download.
//
// **No template is fetched, because none is needed.** A .docx carries its
// own styles.xml, and Word's built-in styles are defined against the
// theme rather than against literal fonts and colours, so a rendered
// document takes its appearance from the reader's own Word.

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

/** Top-level modules the Word renderer reaches for. */
export const WORD_BASE_MODULES = ["__init__", "runs"];

/** The word/ subpackage itself, in dependency order. */
export const WORD_MODULES = ["__init__", "blocks", "runs", "template", "render"];

let pyodidePromise = null;

async function ensurePyodide(status) {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = (async () => {
    if (!globalThis.loadPyodide) {
      status("Loading Python runtime (one-time, ~10 MB)…");
      await new Promise((ok, err) => {
        const s = document.createElement("script");
        s.src = PYODIDE_URL + "pyodide.js";
        s.onload = ok;
        s.onerror = () => err(new Error("cannot load the Pyodide runtime"));
        document.head.appendChild(s);
      });
    }
    const py = await globalThis.loadPyodide({ indexURL: PYODIDE_URL });
    status("Loading libraries…");
    await py.loadPackage(["lxml", "micropip"]);
    status("Installing python-docx…");
    await py.pyimport("micropip").install(["python-docx", "markdown-it-py"]);

    status("Loading the eduFAIR renderer…");
    py.FS.mkdirTree("/py/edufair_renderer/word");
    const put = async (path, into) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`cannot load ${path} (${res.status})`);
      py.FS.writeFile(into, await res.text());
    };
    for (const mod of WORD_BASE_MODULES) {
      await put(`py/edufair_renderer/${mod}.py`, `/py/edufair_renderer/${mod}.py`);
    }
    for (const mod of WORD_MODULES) {
      await put(
        `py/edufair_renderer/word/${mod}.py`,
        `/py/edufair_renderer/word/${mod}.py`
      );
    }
    py.runPython("import sys; sys.path.insert(0, '/py')");
    return py;
  })();
  pyodidePromise.catch(() => (pyodidePromise = null)); // allow retry
  return pyodidePromise;
}

/**
 * Render markdown into a .docx, as bytes.
 *
 * `meta` fills the content controls a house-style template may expose —
 * title, project, author, funding. Without a template they are simply
 * unused, which is the ordinary case.
 */
export async function renderMarkdownToDocx(markdown, meta = {}, status = () => {}) {
  const py = await ensurePyodide(status);
  status("Rendering…");

  py.FS.writeFile("/work.md", markdown);
  const globals = py.toPy({
    title: meta.title ?? "",
    project: meta.project ?? "",
    author: meta.author ?? "",
    funding: meta.funding ?? "",
    version: meta.version ?? "",
  });
  py.runPython(
    [
      "from pathlib import Path",
      "from edufair_renderer.word.render import render_document, DocumentMeta",
      "meta = DocumentMeta(",
      "    title=title, project=project, author=author,",
      "    funding=funding, version=version,",
      ")",
      // No template: the styles are Word's own and follow the reader's theme.
      "render_document(Path('/work.md'), None, Path('/out.docx'), meta=meta)",
    ].join("\n"),
    { globals }
  );
  return py.FS.readFile("/out.docx");
}

/** Base64, which is how Word's own API takes a file. */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000; // argument limits, not memory, decide this
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Every markdown document in a repo, newest-looking first. */
export async function listDocuments(owner, repo) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
  );
  if (res.status === 404) throw new Error(`${owner}/${repo} not found`);
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const tree = await res.json();
  if (tree.truncated) throw new Error("that repo is too large to list");
  return (tree.tree || [])
    .filter((t) => t.type === "blob" && t.path.endsWith(".md"))
    // slides.md is a deck in the slide grammar, not a document: rendering
    // it as prose would produce pages of YAML.
    .filter((t) => !t.path.endsWith("slides.md"))
    .map((t) => t.path)
    .sort();
}

export async function fetchDocument(owner, repo, path) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`
  );
  if (!res.ok) throw new Error(`cannot read ${path} (${res.status})`);
  return res.text();
}
