#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "../../packages/daemon/node_modules/jszip/lib/index.js";

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input ?? "plugins/dist");
const output = resolve(args.output ?? "plugins/catalog.json");
const records = [];
for (const name of await readdir(input).catch(() => [])) {
  if (!name.endsWith(".ling-plugin.zip.json")) continue;
  records.push(JSON.parse(await readFile(join(input, name), "utf8")));
}
const grouped = new Map();
for (const artifact of records) {
  const plugin = grouped.get(artifact.pluginId) ?? {
    pluginId: artifact.pluginId,
    displayName: artifact.pluginId,
    trustSummary: "Official Ling plugin distributed through the signed catalog.",
    latestStableVersion: artifact.channel === "stable" ? artifact.version : undefined,
    manifest: { contributions: [], requiredSecrets: [], defaultApprovals: [], healthChecks: [] },
    artifacts: [],
  };
  const archive = await JSZip.loadAsync(await readFile(join(input, artifactFileName(artifact))), { checkCRC32: true });
  const manifestEntry = archive.file(".ling-plugin/plugin.json");
  if (!manifestEntry) throw new Error(`Artifact is missing .ling-plugin/plugin.json: ${artifact.artifactId}`);
  const manifest = JSON.parse(await manifestEntry.async("string"));
  plugin.displayName = manifest.displayName;
  plugin.trustSummary = manifest.trustSummary;
  plugin.description = manifest.description;
  plugin.homepageUrl = manifest.homepageUrl;
  plugin.manifest = {
    contributions: manifest.contributions,
    requiredSecrets: manifest.requiredSecrets ?? [],
    defaultApprovals: manifest.defaultApprovals ?? [],
    healthChecks: manifest.healthChecks ?? [],
  };
  plugin.artifacts.push(artifact);
  if (artifact.channel === "stable" && (!plugin.latestStableVersion || compare(artifact.version, plugin.latestStableVersion) > 0)) {
    plugin.latestStableVersion = artifact.version;
  }
  grouped.set(artifact.pluginId, plugin);
}
for (const plugin of grouped.values()) {
  if (!plugin.latestStableVersion) throw new Error(`Plugin has no stable artifact: ${plugin.pluginId}`);
}
const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: { repository: args.repository ?? "ling-stack-org/ling-stack", releaseTag: args.releaseTag ?? "local" , ...(args.sourceSha ? { sourceSha: args.sourceSha } : {}) },
  plugins: [...grouped.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId)),
};
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ output, pluginCount: catalog.plugins.length, artifactCount: records.length }, null, 2));

function compare(left, right) {
  const a = left.split(/[.+-]/u).slice(0, 3).map(Number), b = right.split(/[.+-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
function artifactFileName(artifact) {
  return `${artifact.pluginId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-|-$/gu, "") || "plugin"}-${artifact.version}-${artifact.platform}-${artifact.arch}.ling-plugin.zip`;
}
function parseArgs(argv) { const result = {}; for (let index = 0; index < argv.length; index += 1) { if (!argv[index].startsWith("--")) continue; result[argv[index].slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index]; } return result; }
