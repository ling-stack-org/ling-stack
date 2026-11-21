#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "../../packages/daemon/node_modules/jszip/lib/index.js";
import { validateLingPluginCatalog } from "../../packages/plugin-sdk/dist/index.js";

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input ?? "plugins/dist");
const catalogPath = resolve(args.catalog ?? "plugins/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
validateLingPluginCatalog(catalog);
const names = await readdir(input);
const sidecars = names.filter((name) => name.endsWith(".ling-plugin.zip.json"));
if (sidecars.length === 0) throw new Error("No plugin artifact sidecars found.");
const catalogArtifacts = catalog.plugins.flatMap((plugin) => plugin.artifacts);
for (const sidecarName of sidecars) {
  const artifact = JSON.parse(await readFile(join(input, sidecarName), "utf8"));
  const archiveName = sidecarName.slice(0, -5);
  const archivePath = join(input, archiveName);
  const bytes = await readFile(archivePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256 || bytes.length !== artifact.sizeBytes) throw new Error(`Artifact digest or size mismatch: ${archiveName}`);
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  if (!archive.file(".ling-plugin/plugin.json") || !archive.file(".ling-plugin/checksums.json") || !archive.file(".ling-plugin/provenance.json")) {
    throw new Error(`Artifact metadata is incomplete: ${archiveName}`);
  }
  if (!catalogArtifacts.some((candidate) => candidate.artifactId === artifact.artifactId && candidate.sha256 === artifact.sha256)) {
    throw new Error(`Catalog does not contain artifact: ${artifact.artifactId}`);
  }
}
console.log(JSON.stringify({ catalog: catalogPath, artifactCount: sidecars.length, verified: true }, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return result;
}
