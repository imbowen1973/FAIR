// Validation and preview, against the real renderer.
//
// The honest-preview rule (authoring-and-tracking.md §2.2): the schematic
// answers "is the content in the right region", but the preview an author
// trusts is the artifact itself. So both validation and Preview deck run
// the actual edufair_renderer in Pyodide — the same Python that runs locally
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
import { fetchModules } from "../wasm-renderer.js";

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
    py.FS.mkdirTree("/py/edufair_renderer");
    for (const [mod, source] of await fetchModules("../py/edufair_renderer/")) {
      py.FS.writeFile(`/py/edufair_renderer/${mod}.py`, source);
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
from edufair_renderer.parser import parse_session, SessionParseError
from edufair_renderer.layoutmap import load_layout_map, LayoutMapError
from edufair_renderer.library import check_alignment, check_blocks

problems = []
root = Path("${LIB_DIR}")
# Block-level rules live in library.py so edufair-corpus and the pane apply
# the same ones; only the grammar checks below are done here.
problems.extend(check_blocks(root))
# Where the course's claims and its content disagree. Warnings here are
# gaps worth seeing, not reasons to stop -- a library mid-migration is
# full of them and still perfectly buildable.
problems.extend(check_alignment(root))
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
from edufair_renderer.corpus import build_corpus
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

/**
 * Read a template's own geometry, in the browser.
 *
 * A library whose layout-geometry.json is missing a layout cannot draw
 * it: the canvas has no rectangles to put anything in. The message used
 * to say "run edufair-template", which is a dead end in a tool whose
 * whole claim is that nothing needs installing -- and the renderer is
 * already here, running the same Python.
 */
const GEOMETRY = `
import json, sys, traceback
from pathlib import Path
if "/py" not in sys.path:
    sys.path.insert(0, "/py")
# The result is assigned, then named on the last line: runPythonAsync
# hands back the last *expression*, and a try block is not one.
out = None
try:
    from edufair_renderer.template_inspect import inspect_template, layout_geometry
    template = Path("${LIB_DIR}/template.pptx")
    results = inspect_template(template)
    out = json.dumps(layout_geometry(template, results), indent=2, sort_keys=True)
except Exception as exc:
    out = json.dumps({"error": f"{type(exc).__name__}: {exc}",
                      "trace": traceback.format_exc()[-800:]})
out
`;

export async function buildGeometry(files, status = () => {}) {
  const py = await ensurePyodide(status);
  mount(py, files);
  status("Reading the template's layouts…");
  const text = await py.runPythonAsync(GEOMETRY);
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.layouts || !Object.keys(parsed.layouts).length) {
    throw new Error("the template reported no layouts at all");
  }
  return JSON.stringify(parsed, null, 2) + String.fromCharCode(10);
}
