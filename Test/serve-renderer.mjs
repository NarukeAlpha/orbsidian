import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 4173);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = path.join(projectRoot, "dist", "renderer");

const mimeByExtension = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

const server = createServer(async (request, response) => {
  const rawUrl = request.url ?? "/";
  const urlPath = rawUrl.split("?")[0] || "/";
  const relativePath = urlPath === "/" ? "wizard.html" : urlPath.replace(/^\/+/, "");
  const resolvedPath = path.resolve(rendererRoot, relativePath);

  if (!resolvedPath.startsWith(rendererRoot)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const details = await stat(resolvedPath);
    if (!details.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeType = mimeByExtension[extension] ?? "application/octet-stream";
    const data = await readFile(resolvedPath);

    response.writeHead(200, {
      "content-type": mimeType,
      "cache-control": "no-store"
    });
    response.end(data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Renderer test server running at http://127.0.0.1:${port}\n`);
});
