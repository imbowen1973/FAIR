// git -> ppt entirely inside the pane: fetch a library's markdown
// straight from GitHub, run the real edufair_renderer (Python) in
// WebAssembly via Pyodide, and hand back catalog + deck bytes in
// memory. No server, no disk, nothing stored anywhere: the render
// lives in this tab's RAM and dies with it.
//
// The Python code is byte-identical to what runs locally and in CI —
// same parser, same placeholder binding, same creationIds, same
// determinism — because it IS the same package, served as static .py
// files under /py/ and imported inside Pyodide.

const LIB_DIR = "/fairlib";
const OUT_DIR = "/out";

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

// edufair_renderer modules to load into the Pyodide filesystem. This must
// cover every module reachable from corpus.build_corpus — a missing name
// is a ModuleNotFoundError at render time, in the browser, where nothing
// else would catch it. tests/wasm-modules.test.mjs derives the required
// set from the Python sources and fails if this list drifts.
export const MODULES = [
  "__init__",
  "assets",
  "attribution",
  "corpus",
  "creation_id",
  "layoutmap",
  "library",
  "mermaid",
  "outcomes",
  "parser",
  "render",
  "runs",
  // Reading a template's own geometry, so a library missing
  // layout-geometry.json can be repaired in the browser rather than by
  // telling somebody to install a command-line tool.
  "template_inspect",
  // Reading YAML, including the flow sequences with a dangling tail
  // that this project's own writer once produced.
  "yamlio",
  "zipnorm",
];

/**
 * Fetch the renderer's Python modules.
 *
 * `base` is where they sit relative to the caller: the assembler page is
 * at the site root, the workbench is one level down.
 *
 * Two things this does that a plain loop did not, both learned from a
 * preview that failed with "cannot load renderer module assets (503)"
 * while every one of those files was being served perfectly well:
 *
 *   it retries what is worth retrying. A 5xx or a dropped connection is
 *   the host having a moment -- Pages answers 503 while a deploy is
 *   going out -- and the right response is to ask again, not to make
 *   somebody re-run the preview and wonder what they did wrong. A 404
 *   is not retried: that file is not published and waiting will not
 *   publish it.
 *
 *   it fetches them together. Fourteen sequential round-trips is
 *   fourteen chances to be unlucky, one after another, and slower than
 *   it needs to be.
 */
export async function fetchModules(
  base,
  {
    fetcher = fetch,
    attempts = 3,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    // The build this page was served as. The workflow stamps every
    // import with it, so this module's own URL carries it -- and the
    // Python it fetches must be stamped too. Pages serves .py with
    // max-age=600, so for ten minutes after a deploy an unstamped
    // fetch can hand back a mix of old and new renderer modules and
    // render something wrong rather than failing. That is worse than
    // the 503 that led here.
    stamp = new URL(import.meta.url).searchParams.get("v"),
  } = {}
) {
  const load = async (mod) => {
    const url = `${base}${mod}.py` + (stamp ? `?v=${stamp}` : "");
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt) await wait(300 * 2 ** (attempt - 1));
      let res;
      try {
        res = await fetcher(url);
      } catch (err) {
        last = new Error(`could not reach ${mod}.py (${err.message})`);
        continue;
      }
      if (res.ok) return [mod, await res.text()];
      if (res.status === 404) {
        // Not published. Retrying cannot help, and pretending otherwise
        // just makes the failure slower.
        throw new Error(
          `the renderer module ${mod}.py is not published on this site (404)`
        );
      }
      last = new Error(`${mod}.py answered ${res.status}`);
    }
    throw new Error(
      `${last.message} after ${attempts} attempts. The site is not serving ` +
        "the renderer right now — this is nothing to do with your library. " +
        "Try Preview again in a moment."
    );
  };

  return Promise.all(MODULES.map(load));
}

const REQUIRED = ["template.pptx", "layout-map.yaml"];

/**
 * Which repo paths a library render needs. Pure, so it is unit-testable:
 * takes the repo tree's path list, returns the paths to fetch, or throws
 * if the repo is not a library.
 */
export function selectLibraryPaths(paths) {
  const wanted = paths.filter(
    (p) =>
      p === "template.pptx" ||
      p === "layout-map.yaml" ||
      p === "attribution.yaml" ||
      p === "course.yaml" ||
      p === "competencies/framework.yaml" ||
      p.startsWith("branding/") ||
      p.startsWith("blocks/") ||
      p.startsWith("sessions/") ||
      (p.startsWith("credentials/") && p.endsWith(".yaml"))
  );
  const missing = REQUIRED.filter((r) => !wanted.includes(r));
  const hasBlocks = wanted.some((p) => /^blocks\/[^/]+\/slides\.md$/.test(p));
  const hasSessions = wanted.some((p) => p.startsWith("sessions/") && p.endsWith(".md"));
  if (!hasBlocks && !hasSessions) {
    missing.push("blocks/*/slides.md");
  }
  if (missing.length) {
    throw new Error(`not a library repo — missing ${missing.join(", ")}`);
  }
  return wanted;
}

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
    status("Loading libraries (lxml, Pillow)…");
    await py.loadPackage(["lxml", "pillow", "pyyaml", "micropip"]);
    status("Installing python-pptx…");
    await py.pyimport("micropip").install("python-pptx");

    status("Loading the FAIR renderer…");
    py.FS.mkdirTree("/py/edufair_renderer");
    for (const [mod, source] of await fetchModules("py/edufair_renderer/")) {
      py.FS.writeFile(`/py/edufair_renderer/${mod}.py`, source);
    }
    return py;
  })();
  pyodidePromise.catch(() => (pyodidePromise = null)); // allow retry
  return pyodidePromise;
}

async function fetchRepoTree(owner, repo) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
  );
  if (res.status === 404) {
    throw new Error(`${owner}/${repo} not found (private repos need the server or local mode)`);
  }
  if (res.status === 403) {
    throw new Error("GitHub rate limit reached from this network — try again in a while");
  }
  if (!res.ok) throw new Error(`GitHub tree fetch failed (${res.status})`);
  const data = await res.json();
  if (data.truncated) throw new Error("repository tree too large to fetch in-browser");
  return data.tree.filter((e) => e.type === "blob").map((e) => e.path);
}

async function fetchFiles(owner, repo, paths, status) {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`;
  const files = new Map();
  const queue = [...paths];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const path = queue.shift();
      const res = await fetch(base + path);
      if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
      files.set(path, new Uint8Array(await res.arrayBuffer()));
      status(`Fetching content ${++done}/${paths.length}…`);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return files;
}

const DRIVER = `
import json, shutil, sys
from pathlib import Path
if "/py" not in sys.path:
    sys.path.insert(0, "/py")
shutil.rmtree("${OUT_DIR}", ignore_errors=True)
from edufair_renderer.corpus import build_corpus
root = Path("${LIB_DIR}")
fw = root / "competencies/framework.yaml"
cd = root / "credentials"
is_course = (root / "course.yaml").exists() and (root / "blocks").is_dir()
build_corpus(
    library=root if is_course else None,
    sessions_dir=None if is_course else root / "sessions",
    template=root / "template.pptx",
    layout_map=root / "layout-map.yaml",
    out_dir=Path("${OUT_DIR}"),
    framework=fw if fw.exists() else None,
    credentials_dir=cd if cd.exists() else None,
)
Path("${OUT_DIR}/catalog.json").read_text()
`;

/**
 * The whole flow: repo tree -> raw files -> Pyodide FS -> edufair_renderer
 * -> {catalog, decks}. Decks is Map<sourcePptx, Uint8Array>, alive only
 * in this tab's memory.
 */
export async function loadLibraryFromGitHub(owner, repo, status = () => {}) {
  const py = await ensurePyodide(status);

  // Always the repository's default branch. This add-in assembles from
  // published content and has no notion of a branch -- which is worth
  // saying out loud, because the workbench saves to draft/<login>, so an
  // author can fix a slide there, reload the add-in, and see the old
  // failure unchanged. Reloading is not the problem and reinstalling
  // does not help: the branch it reads has not moved.
  status(`Reading the default branch of ${owner}/${repo}…`);
  const paths = selectLibraryPaths(await fetchRepoTree(owner, repo));
  const files = await fetchFiles(owner, repo, paths, status);

  // Clear only our own mount. Never /lib — that is Pyodide's stdlib.
  py.runPython(`import shutil; shutil.rmtree("${LIB_DIR}", ignore_errors=True)`);
  for (const [path, bytes] of files) {
    const full = `${LIB_DIR}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(full, bytes);
  }

  status("Rendering slides in your browser…");
  let catalogJson;
  try {
    catalogJson = await py.runPythonAsync(DRIVER);
  } catch (err) {
    // A renderer error names a slide id and nothing about where it was
    // read from, so an author who has just fixed that slide somewhere
    // else has no way to tell why it is still failing.
    const detail = String(err.message ?? err).trim().split(String.fromCharCode(10)).pop();
    throw new Error(
      `${detail} — read from the default branch of ${owner}/${repo}. ` +
        "Edits saved in the workbench are on a draft branch until they are " +
        "submitted, so a fix made there will not show here yet."
    );
  }
  const catalog = JSON.parse(catalogJson);

  const decks = new Map();
  for (const session of catalog.sessions) {
    decks.set(session.pptx, py.FS.readFile(`${OUT_DIR}/${session.pptx}`));
  }

  // The funder logo the build copied beside the catalog. Comes back as
  // bytes because there is no server to fetch it from.
  const assets = new Map();
  const logo = catalog.attribution?.logo;
  if (logo) {
    try {
      assets.set(logo, py.FS.readFile(`${OUT_DIR}/${logo}`));
    } catch {
      /* library declares a logo the build did not emit: text-only credit */
    }
  }

  status("");
  return { catalog, decks, assets };
}
