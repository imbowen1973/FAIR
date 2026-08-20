// Static server for the task pane + the pull-and-render endpoint.
//
// Runs in two modes with the same code:
//
//   Local (default): binds 127.0.0.1. Office add-ins require HTTPS, so if
//   office-addin-dev-certs is installed (`npm install`) we use its trusted
//   localhost certificate; otherwise plain HTTP for browser smoke tests.
//
//   Hosted: FAIR_BIND=0.0.0.0 behind a TLS-terminating reverse proxy
//   (see docs/deploy-server.md). This is middle-layer v0: anyone with
//   PowerPoint can paste a public git URL and get slides — the server
//   renders at point of use and never stores or publishes a deck (the
//   per-library render directory is an ephemeral cache, rebuilt on pull).
//
// Env: PORT, FAIR_BIND, FAIR_PYTHON, FAIR_PULL_TOKEN (require a bearer
// token on /api/pull), FAIR_PULL_FRESH (seconds a pull stays fresh, 60),
// FAIR_PULL_TIMEOUT (seconds before a pull is killed, 180),
// FAIR_PULL_MAX (concurrent pulls, 3), FAIR_RENDER_TTL (seconds a
// render is kept for the pane before being swept, 3600).

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, rm } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "web");
const REPO = join(HERE, "..");
const PORT = Number(process.env.PORT ?? 3000);

// The venv the renderer is installed into, so the pane does not depend on
// whatever `python` happens to be first on PATH.
const PYTHON =
  process.env.FAIR_PYTHON ??
  (process.platform === "win32"
    ? join(REPO, ".venv", "Scripts", "python.exe")
    : join(REPO, ".venv", "bin", "python"));

const GIT_HOSTS = new Set(["github.com", "www.github.com", "gitlab.com", "bitbucket.org"]);

const BIND = process.env.FAIR_BIND ?? "127.0.0.1";
const PULL_TOKEN = process.env.FAIR_PULL_TOKEN || null;
const FRESH_MS = Number(process.env.FAIR_PULL_FRESH ?? 60) * 1000;
const PULL_TIMEOUT_MS = Number(process.env.FAIR_PULL_TIMEOUT ?? 180) * 1000;
const MAX_ACTIVE_PULLS = Number(process.env.FAIR_PULL_MAX ?? 3);

// One pull per library at a time; concurrent requests for the same
// library await the same promise instead of racing git and the renderer
// over one directory.
const inFlight = new Map(); // name -> Promise<{status, body}>
const lastPulled = new Map(); // name -> epoch ms
let activePulls = 0;

// The render is the only thing that touches disk (the source repo lives
// in a temp dir inside pull_library.py and is deleted before it exits).
// Renders live just long enough for the pane to browse and fetch decks,
// then are swept; a restart starts from nothing.
const RENDER_TTL_MS = Number(process.env.FAIR_RENDER_TTL ?? 3600) * 1000;
const LIBRARIES_DIR = join(ROOT, "libraries");
await rm(LIBRARIES_DIR, { recursive: true, force: true });
setInterval(() => {
  for (const [name, at] of lastPulled) {
    if (Date.now() - at > RENDER_TTL_MS) {
      lastPulled.delete(name);
      rm(join(LIBRARIES_DIR, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}, 60_000).unref();

function runPull(name, href) {
  const out = join(ROOT, "libraries", name, "data");
  return new Promise((resolve) => {
    activePulls++;
    // Array args, never a shell string, so the URL cannot inject a command.
    const proc = spawn(PYTHON, [join(REPO, "scripts", "pull_library.py"), href, "--out", out]);
    let log = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), PULL_TIMEOUT_MS);
    proc.stdout.on("data", (d) => (log += d));
    proc.stderr.on("data", (d) => (log += d));
    proc.on("error", (e) => {
      clearTimeout(timer);
      activePulls--;
      resolve({ status: 500, body: { error: `cannot run ${PYTHON}: ${e.message}` } });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      activePulls--;
      if (code === 0) {
        lastPulled.set(name, Date.now());
        resolve({ status: 200, body: { name, base: `/libraries/${name}`, log: log.trim() } });
      } else {
        resolve({ status: 500, body: { error: log.trim() || `pull failed (exit ${code})` } });
      }
    });
  });
}

/**
 * POST /api/pull {url} — clone/update a library repo and render it into
 * web/libraries/<name>/data, then hand the pane a same-origin base URL.
 * The browser cannot clone or render; this is the piece that can.
 */
async function pullLibrary(req, res) {
  const body = await new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
  });

  let repoUrl;
  try {
    repoUrl = new URL(JSON.parse(body).url);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not a URL" }));
    return;
  }
  // Only https git hosts: this spawns git against whatever it is given.
  if (repoUrl.protocol !== "https:" || !GIT_HOSTS.has(repoUrl.hostname.toLowerCase())) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `not a supported git host: ${repoUrl.hostname}` }));
    return;
  }

  const name = repoUrl.pathname.replace(/\/+$/, "").split("/").pop().replace(/\.git$/, "");
  // The name becomes a directory under web/libraries; refuse anything
  // that is not a plain path segment (e.g. "", ".", "..").
  if (!/^[\w][\w.-]*$/.test(name)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `cannot derive a library name from ${repoUrl.pathname}` }));
    return;
  }

  if (PULL_TOKEN) {
    if ((req.headers.authorization ?? "") !== `Bearer ${PULL_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "pull requires an access token" }));
      return;
    }
  }

  // Freshly pulled? Serve the existing render instead of re-cloning —
  // an ephemeral freshness window, not a store: the next window re-pulls.
  const at = lastPulled.get(name);
  if (at && Date.now() - at < FRESH_MS) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name, base: `/libraries/${name}`, cached: true }));
    return;
  }

  let pending = inFlight.get(name);
  if (!pending) {
    if (activePulls >= MAX_ACTIVE_PULLS) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server is busy pulling other libraries — retry shortly" }));
      return;
    }
    pending = runPull(name, repoUrl.href).finally(() => inFlight.delete(name));
    inFlight.set(name, pending);
  }
  const result = await pending;
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".xml": "text/xml; charset=utf-8",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function handler(req, res) {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/api/pull" && req.method === "POST") {
      await pullLibrary(req, res);
      return;
    }
    // The fair_renderer sources, for the in-browser (Pyodide) renderer.
    // Published deployments serve these as static files under /py/.
    const PY_ROOT = join(REPO, "renderer", "src");
    let filePath;
    if (urlPath.startsWith("/py/")) {
      filePath = normalize(join(PY_ROOT, urlPath.slice(4)));
      if (!filePath.startsWith(PY_ROOT)) {
        res.writeHead(403).end();
        return;
      }
    } else {
      filePath = normalize(join(ROOT, urlPath === "/" ? "index.html" : urlPath));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

let server;
if (process.env.FAIR_BIND) {
  // Hosted mode: plain HTTP behind a TLS-terminating reverse proxy.
  server = createHttpServer(handler);
  server.listen(PORT, BIND, () =>
    console.log(`hosted mode: http://${BIND}:${PORT} (put TLS in front — see docs/deploy-server.md)`)
  );
} else {
  try {
    const { getHttpsServerOptions } = await import("office-addin-dev-certs");
    server = createHttpsServer(await getHttpsServerOptions(), handler);
    server.listen(PORT, BIND, () => console.log(`https://localhost:${PORT}/taskpane.html`));
  } catch {
    console.warn(
      "office-addin-dev-certs not available — serving plain HTTP. " +
        "Run `npm install` in assembler/ for the HTTPS certs sideloading needs."
    );
    server = createHttpServer(handler);
    server.listen(PORT, BIND, () => console.log(`http://localhost:${PORT}/taskpane.html`));
  }
}
