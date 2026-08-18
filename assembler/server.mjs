// Minimal static dev server for the task pane.
//
// Office add-ins require HTTPS (localhost included, except older desktop
// builds). If office-addin-dev-certs is installed (`npm install`), we use
// its trusted localhost certificate; otherwise we fall back to plain HTTP
// so the pane can at least be smoke-tested in a browser.

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
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
  const out = join(ROOT, "libraries", name, "data");

  // Array args, never a shell string, so the URL cannot inject a command.
  const proc = spawn(PYTHON, [join(REPO, "scripts", "pull_library.py"), repoUrl.href, "--out", out]);
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  proc.on("error", (e) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `cannot run ${PYTHON}: ${e.message}` }));
  });
  proc.on("close", (code) => {
    if (res.headersSent) return;
    res.writeHead(code === 0 ? 200 : 500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        code === 0
          ? { name, base: `/libraries/${name}`, log: log.trim() }
          : { error: log.trim() || `pull failed (exit ${code})` }
      )
    );
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function handler(req, res) {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/api/pull" && req.method === "POST") {
      await pullLibrary(req, res);
      return;
    }
    let filePath = normalize(join(ROOT, urlPath === "/" ? "taskpane.html" : urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
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
try {
  const { getHttpsServerOptions } = await import("office-addin-dev-certs");
  server = createHttpsServer(await getHttpsServerOptions(), handler);
  server.listen(PORT, () => console.log(`https://localhost:${PORT}/taskpane.html`));
} catch {
  console.warn(
    "office-addin-dev-certs not available — serving plain HTTP. " +
      "Run `npm install` in assembler/ for the HTTPS certs sideloading needs."
  );
  server = createHttpServer(handler);
  server.listen(PORT, () => console.log(`http://localhost:${PORT}/taskpane.html`));
}
