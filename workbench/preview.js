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
import { pythonError } from "./errors.js";

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const LIB_DIR = "/fairlib"; // never /lib: that is Pyodide's own stdlib
const COMPANION_DIR = "/faircompanion";
const OUT_DIR = "/out";

let pyodidePromise = null;

async function runPy(py, code, doing) {
  try {
    return await py.runPythonAsync(code);
  } catch (err) {
    throw pythonError(err, doing);
  }
}

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

    status("Loading the FAIR-Ed renderer…");
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
function mount(py, files, dir = LIB_DIR) {
  py.runPython(`import shutil; shutil.rmtree("${dir}", ignore_errors=True)`);
  for (const [path, content] of files) {
    const full = `${dir}/${path}`;
    py.FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    // Pyodide's own complaint about anything else is "Unsupported data
    // type", which names neither the file nor the value. Whatever goes
    // wrong upstream, the report should say where to look.
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      throw new Error(
        `${path} is ${content === undefined ? "missing" : typeof content}, ` +
          "so the library cannot be assembled to check or render it."
      );
    }
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
# The private companion, when one is connected: the same cross-checks its
# own CI runs (questions.py) -- every bank well formed, every block real,
# every assessed outcome defined by the course.
companion_root = Path("${COMPANION_DIR}")
if companion_root.exists():
    from edufair_renderer.questions import QuestionsError, load_companion, validate_against_library
    try:
        twin = load_companion(companion_root, require_banks=False)
        for message in validate_against_library(twin, root):
            problems.append({"where": "🔒 companion", "message": message})
    except QuestionsError as e:
        problems.append({"where": "🔒 companion", "message": str(e).replace(str(companion_root) + "/", "")})
json.dumps(problems)
`;

/**
 * Grammar and binding errors for the whole library, from the real parser.
 * Returns [] when clean — the Submit button keys off exactly this.
 */
export async function validate(files, status, companionFiles = null) {
  const py = await ensurePyodide(status);
  mount(py, files);
  // Mounted only when connected; an absent directory is the check's cue
  // to skip the companion entirely.
  mount(py, companionFiles ?? [], COMPANION_DIR);
  if (!companionFiles) py.runPython(`import shutil; shutil.rmtree("${COMPANION_DIR}", ignore_errors=True)`);
  status?.("Checking…");
  const out = await runPy(py, VALIDATE, "check the course");
  status?.("");
  return JSON.parse(out);
}

const INGEST = `
import json, shutil, sys
from pathlib import Path
if "/py" not in sys.path:
    sys.path.insert(0, "/py")
shutil.rmtree("/ingest-out", ignore_errors=True)
from edufair_renderer.ingest import ingest_pptx
args = json.loads(Path("/ingest-args.json").read_text())
result = ingest_pptx(Path("/ingest-in.pptx").read_bytes(), args["block_id"],
                     source_name=args.get("source_name"))
for rel, data in result.media.items():
    p = Path("/ingest-out") / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
json.dumps({"title": result.title, "slides_md": result.slides_md,
            "report": result.report, "media": sorted(result.media)})
`;

/**
 * An existing .pptx, read in the browser and rescued into the grammar.
 *
 * The deck's bytes go into the Pyodide filesystem, the same extractor
 * that powers edufair-import runs on them, and what comes back is
 * grammar text, policy-clean media bytes, and a per-slide confidence
 * report. The source deck is never uploaded anywhere: it is read in
 * this tab and discarded.
 */
export async function ingestDeck(bytes, blockId, status = () => {}, sourceName = null) {
  const py = await ensurePyodide(status);
  status?.("Reading the deck in your browser…");
  py.FS.writeFile("/ingest-in.pptx", bytes);
  py.FS.writeFile(
    "/ingest-args.json",
    JSON.stringify({ block_id: blockId, source_name: sourceName })
  );
  const out = JSON.parse(await runPy(py, INGEST, "read the deck"));
  const media = new Map();
  for (const rel of out.media) {
    media.set(rel, py.FS.readFile(`/ingest-out/${rel}`));
  }
  status?.("");
  return { title: out.title, slidesMd: out.slides_md, report: out.report, media };
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
  await runPy(py, RENDER, "render the deck");

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
  const text = await runPy(py, GEOMETRY, "read the template");
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.layouts || !Object.keys(parsed.layouts).length) {
    throw new Error("the template reported no layouts at all");
  }
  return JSON.stringify(parsed, null, 2) + String.fromCharCode(10);
}
