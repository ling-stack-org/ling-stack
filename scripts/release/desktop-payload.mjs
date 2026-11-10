import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Preserve a plain extracted root while removing OS temporary-directory aliases. */
export async function extractedApplicationPath(artifactRoot, target) {
  if (!["macos-arm64", "windows-x64"].includes(target)) throw new Error("Unsupported native target");
  const original = await lstat(artifactRoot);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Extraction root must be a plain directory");
  const root = await realpath(artifactRoot);
  const observations = await Promise.all([lstat(artifactRoot), lstat(root)]);
  if (observations.some(stat => !stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== original.dev || stat.ino !== original.ino)) throw new Error("Extraction root changed during canonicalization");
  const app = target === "macos-arm64" ? join(root, "Ling Stack.app") : root;
  const stat = await lstat(app);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Application payload root must be a plain directory");
  return app;
}

/** Compare every shipped file, including Web chunks, native modules and runtime DLLs. */
export async function inventoryApplicationTree(directory, { allowLinks = false } = {}) {
  const root = resolve(directory), entries = [];
  let count = 0;
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error("Application payload root must be a plain directory");
  async function visit(prefix, depth) {
    if (depth > 64) throw new Error("Application payload nesting is too deep");
    for (const name of (await readdir(join(root, prefix))).sort()) {
      if (++count > 100_000) throw new Error("Application payload inventory is too large");
      const path = join(root, prefix, name), key = relative(root, path).replaceAll("\\", "/"), stat = await lstat(path);
      if (stat.isDirectory()) await visit(key, depth + 1);
      else if (stat.isSymbolicLink()) {
        const target = await readlink(path), resolved = relative(root, resolve(dirname(path), target));
        if (!allowLinks || isAbsolute(target) || resolved === ".." || resolved.startsWith("../") || resolved.startsWith("..\\") || isAbsolute(resolved)) {
          throw new Error(`Unexpected application payload link: ${key}`);
        }
        entries.push({ name: key, type: "link", target });
      } else if (stat.isFile()) {
        const digest = createHash("sha256");
        for await (const bytes of createReadStream(path)) digest.update(bytes);
        entries.push({ name: key, type: "file", sizeBytes: stat.size, sha256: digest.digest("hex") });
      } else throw new Error(`Unexpected application payload entry: ${key}`);
    }
  }
  await visit("", 0);
  return entries;
}
