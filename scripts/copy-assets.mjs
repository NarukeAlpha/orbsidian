import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const src = path.join(root, "src", "renderer");
const out = path.join(root, "dist", "renderer");

await mkdir(out, { recursive: true });
await cp(src, out, {
  recursive: true,
  filter: (filePath) => !filePath.endsWith(".ts")
});
