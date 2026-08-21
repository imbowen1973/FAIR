// Validation and preview, against the real renderer.
//
// The honest-preview rule (authoring-and-tracking.md §2.2): the schematic
// answers "is the content in the right region", but the preview an author
// trusts is the artifact itself. So both validation and Preview deck run
// the actual fair_renderer in Pyodide — the same Python that runs locally
// and in CI. A simulation could drift; this cannot.
//
// The module list is the one thing that must stay in step with the Python
// import graph. assembler/tests/wasm-modules.test.mjs derives it from the
// sources and has caught a missing module twice; this file deliberately
// reuses that list rather than keeping a second copy.

// One level up: the pane is published at the site root, so this resolves
// both on Pages and under the dev server. Importing the module list rather
// than copying it is deliberate — assembler/tests/wasm-modules.test.mjs
// derives that list from the Python import graph, and a second copy here
// would be the thing that drifts.
import { MODULES } from "../wasm-renderer.js";

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const LIB_DIR = "/fairlib"; // never /lib: that is Pyodide's own stdlib
const OUT_DIR = "/out";

let pyodidePromise = null;

async function ensurePyodide(status = () => {}) {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = (async () => {
    if (!globalThis.loadPyodide) {
      status("Loading the Python runtime (one-time, ~10 MB)…");
      await new Promise((ok, err) => {
        const s = document.createElement("script");
        s.src = PYODIDE_URL + "pyodide.js";
        s.onload = ok;
        s.onerror = () => err(new Error("cannot reach the Pyodide runtime"));
        document.head.appendChild(s);
      });
    }
    const py = await globalThis.loadPyodide({ indexURL: PYODIDE_URL });
    status("Loading libraries…");
    await py.loadPackage(["lxml", "pillow", "pyyaml", "micropip"]);
    await py.pyimport("micropip").install("python-pptx");

    status("Loading the FAIR renderer…");
    py.FS.mkdirTree("/py/fair_renderer");
    for (const mod of MODULES) {
      const res = await fetch(`../py/fair_renderer/${mod}.py`);
      if (!res.ok) throw new Error(`cannot load renderer module ${mod} (${res.status})`);
      py.FS.writeFile(`/py/fair_renderer/${mod}.py`, await res.text());
    }
    return py;
  })();
  pyodidePromise.catch(() => (pyodidePromise = null)); // allow retry
  return pyodidePromise;
}

/** Mount the library's files into the Pyodide filesystem. */
function mount(py, files) {
  py.runPython(`import shutil; shutil.rmtree("${LIB_DIR}", ignore_errors=True)`);
  for (const [path, content] of files) {
    const full = `${LIB_DIR}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    py.FS.writeFile(
      full,
      typeof content === "string" ? new TextEncoder().encode(content) : content
    );
  }
}

const VALIDATE = `
import json, sys, traceback
from pathlib import Path
if "/py" not in sys.path:
    sys.path.insert(0, "/py")
from fair_renderer.parser import parse_session, SessionParseError
from fair_renderer.layoutmap import load_layout_map, LayoutMapError
from fair_renderer.library import check_blocks

problems = []
root = Path("${LIB_DIR}")
# Block-level rules live in library.py so fair-corpus and the pane apply
# the same ones; only the grammar checks below are done here.
problems.extend(check_blocks(root))
try:
    bindings = load_layout_map(root / "layout-map.yaml")
except LayoutMapError as e:
    bindings = {}
    problems.append({"where": "layout-map.yaml", "message": str(e)})

for slides in sorted(root.glob("blocks/*/slides.md")):
    block = slides.parent.name
    try:
        session = parse_session(slides)
    except SessionParseError as e:
        problems.append({"where": block, "message": str(e)})
        continue
    for slide in session.slides:
        binding = bindings.get(slide.layout)
        if binding is None:
            problems.append({
                "where": f"{block}/{slide.id}",
                "message": f"unknown layout {slide.layout!r}; the template offers {sorted(bindings)}",
            })
            continue
        for region in slide.regions:
            if region.name not in binding.regions:
                problems.append({
                    "where": f"{block}/{slide.id}",
                    "message": f"region {region.name!r} is not part of layout {slide.layout!r}; "
                               f"it offers {sorted(binding.regions)}",
                })
json.dumps(problems)
`;

/**
 * Grammar and binding errors for the whole library, from the real parser.
 * Returns [] when clean — the Submit button keys off exactly this.
 */
export async function validate(files, status) {
  const py = await ensurePyodide(status);
  mount(py, files);
  status?.("Checking…");
  const out = await py.runPythonAsync(VALIDATE);
  status?.("");
  return JSON.parse(out);
}

const RENDER = `
import shutil, sys
from pathlib import Path
if "/py" not in sys.path:
    sys.path.insert(0, "/py")
shutil.rmtree("${OUT_DIR}", ignore_errors=True)
from fair_renderer.corpus import build_corpus
root = Path("${LIB_DIR}")
fw = root / "competencies/framework.yaml"
cd = root / "credentials"
summary = build_corpus(
    library=root,
    template=root / "template.pptx",
    layout_map=root / "layout-map.yaml",
    out_dir=Path("${OUT_DIR}"),
    framework=fw if fw.exists() else None,
    credentials_dir=cd if cd.exists() else None,
    warn=lambda m: None,
)
str(summary["catalog"])
`;

/**
 * Render the library and hand back the deck for one block.
 * This is the artifact, not an approximation of it.
 */
export async function renderDeck(files, blockId, status) {
  const py = await ensurePyodide(status);
  mount(py, files);
  status?.("Rendering the deck…");
  await py.runPythonAsync(RENDER);

  const catalog = JSON.parse(
    new TextDecoder().decode(py.FS.readFile(`${OUT_DIR}/catalog.json`))
  );
  const block = (catalog.blocks || []).find((b) => b.blockId === blockId);
  if (!block) throw new Error(`the render produced no deck for ${blockId}`);

  const bytes = py.FS.readFile(`${OUT_DIR}/${block.pptx}`);
  status?.("");
  return {
    catalog,
    blob: new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
    filename: block.pptx.split("/").pop(),
  };
}

/** Has the runtime already been paid for this session? */
export function runtimeReady() {
  return pyodidePromise !== null;
}
