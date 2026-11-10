import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { create, list } from "tar";
import { fileRecord } from "./desktop-release.mjs";
import { inventoryApplicationTree } from "./desktop-payload.mjs";

export async function inventoryDistribution(directory) {
  return (await inventoryApplicationTree(directory)).map(({ type, ...file }) => file);
}

/** Read archive members without extracting paths supplied by an archive. */
export async function verifyDistributionArchive(archivePath, expected) {
  const files = [], paths = new Set();
  let invalid = false;
  await list({ file: archivePath, strict: true, onReadEntry(entry) {
    const path = entry.path.replace(/\/$/u, "");
    if (paths.has(path) || path.includes("\\") || path.split("/").some(part => ["", ".", ".."].includes(part))
      || path !== "distribution" && !path.startsWith("distribution/")) invalid = true;
    paths.add(path);
    if (entry.type === "Directory") return;
    if (entry.type !== "File" || !path.startsWith("distribution/")) { invalid = true; return; }
    const digest = createHash("sha256");
    let sizeBytes = 0;
    entry.on("data", bytes => { digest.update(bytes); sizeBytes += bytes.length; });
    entry.on("end", () => files.push({ name: path.slice(13), sizeBytes, sha256: digest.digest("hex") }));
  } });
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const sorted = [...expected].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (invalid || !files.length || !isDeepStrictEqual(files, sorted)) throw new Error("Distribution archive differs from the verified embedded materials");
  return fileRecord(archivePath);
}

export async function createVerifiedDistributionArchive({ directory, archivePath, expected }) {
  if (basename(directory) !== "distribution") throw new Error("Expected the distribution materials directory");
  try { await lstat(archivePath); throw new Error("Distribution archive already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await create({ file: archivePath, cwd: dirname(directory), gzip: true, portable: true }, ["distribution"]);
  return verifyDistributionArchive(archivePath, expected);
}
