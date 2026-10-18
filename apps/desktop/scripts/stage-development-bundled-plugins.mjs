import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuration = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
const resource = configuration.build.extraResources.find(entry => entry.to === "bundled");
if (!resource || !Array.isArray(resource.filter)) throw new Error("bundled_plugin_metadata_missing");

// esbuild relocates import.meta.url; retain the existing module-relative lookup for development.
for (const path of resource.filter) {
  if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new Error("bundled_plugin_metadata_path_invalid");
  }
  const target = resolve(desktopRoot, "dist/daemon/bundled", path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(desktopRoot, resource.from, path), target);
}
console.log(`Staged ${resource.filter.length} bundled plugin metadata files for development.`);
