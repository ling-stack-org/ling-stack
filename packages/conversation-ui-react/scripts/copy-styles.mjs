import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const source = resolve(packageRoot, "src/styles");
const target = resolve(packageRoot, "dist/styles");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
