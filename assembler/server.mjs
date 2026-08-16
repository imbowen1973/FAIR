// Minimal static dev server for the task pane.
//
// Office add-ins require HTTPS (localhost included, except older desktop
// builds). If office-addin-dev-certs is installed (`npm install`), we use
// its trusted localhost certificate; otherwise we fall back to plain HTTP
// so the pane can at least be smoke-tested in a browser.

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "web");
const PORT = Number(process.env.PORT ?? 3000);

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
