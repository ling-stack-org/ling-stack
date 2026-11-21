#!/usr/bin/env node
import { createHash, sign } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import JSZip from "../../packages/daemon/node_modules/jszip/lib/index.js";

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? "packages/daemon/src/features/plugins/bundled/cua-driver");
const output = resolve(args.output ?? "plugins/dist");
const platform = args.platform ?? process.platform;
const arch = args.arch ?? process.arch;
const version = args.version ?? JSON.parse(await readFile(join(root, ".ling-plugin/plugin.json"), "utf8")).version;
const sourceSha = args.sourceSha ?? "local";
if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64", "ia32", "universal"].includes(arch)) throw new Error("Invalid platform or architecture.");

const original = JSON.parse(await readFile(join(root, ".ling-plugin/plugin.json"), "utf8"));
const pluginId = args.pluginId ?? (original.id.startsWith("bundled:") ? `official:${original.id.slice("bundled:".length)}` : original.id);
const artifactId = `${pluginId}-${version}-${platform}-${arch}`;
const manifest = {
  ...original,
  id: pluginId,
  manifestVersion: 2,
  lingInterfaceVersion: "2",
  version,
  sourceKind: "official-remote",
  trustLevel: "official",
  artifactId,
  platform,
  arch,
  ...(args.minLingVersion ? { minLingVersion: args.minLingVersion } : {}),
  ...(args.maxLingVersion ? { maxLingVersion: args.maxLingVersion } : {}),
  rollbackAllowed: args.rollbackAllowed !== "false",
};
const zip = new JSZip();
const entries = await listFiles(root);
for (const path of entries) {
  const name = relative(root, path).split("\\").join("/");
  if (name === ".ling-plugin/plugin.json") continue;
  zip.file(name, await readFile(path), { date: new Date(0) });
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
zip.file(".ling-plugin/plugin.json", manifestBytes, { date: new Date(0) });
const checksums = {};
for (const name of [".ling-plugin/plugin.json", ...entries.map((path) => relative(root, path).split("\\").join("/")).filter((name) => name !== ".ling-plugin/plugin.json")].sort()) {
  const data = name === ".ling-plugin/plugin.json" ? manifestBytes : await readFile(join(root, name));
  checksums[name] = createHash("sha256").update(data).digest("hex");
}
zip.file(".ling-plugin/checksums.json", `${JSON.stringify({ algorithm: "sha256", files: checksums }, null, 2)}\n`, { date: new Date(0) });
zip.file(".ling-plugin/provenance.json", `${JSON.stringify({ schemaVersion: 1, sourceSha, generatedAt: new Date().toISOString(), artifactId }, null, 2)}\n`, { date: new Date(0) });
const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
const artifactName = `${sanitize(pluginId)}-${version}-${platform}-${arch}.ling-plugin.zip`;
await mkdir(output, { recursive: true });
await import("node:fs/promises").then(({ writeFile }) => writeFile(join(output, artifactName), bytes));
const record = {
  artifactId,
  pluginId,
  version,
  platform,
  arch,
  channel: args.channel ?? "dev",
  url: args.url ?? `https://github.com/ling-stack-org/ling-stack/releases/download/${args.releaseTag ?? `plugin-${version}`}/${artifactName}`,
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  ...(process.env.LING_PLUGIN_ARTIFACT_PRIVATE_KEY
    ? { signature: `ed25519:${sign(null, bytes, process.env.LING_PLUGIN_ARTIFACT_PRIVATE_KEY).toString("base64")}` }
    : {}),
  minLingVersion: args.minLingVersion,
  maxLingVersion: args.maxLingVersion,
  rollbackAllowed: args.rollbackAllowed !== "false",
};
await import("node:fs/promises").then(({ writeFile }) => writeFile(join(output, `${artifactName}.json`), `${JSON.stringify(record, null, 2)}\n`));
console.log(JSON.stringify({ artifact: join(output, artifactName), ...record }, null, 2));

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...await listFiles(path));
    else if (info.isFile()) result.push(path);
  }
  return result.sort();
}

function sanitize(value) { return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-|-$/gu, "") || "plugin"; }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    result[token.slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return result;
}
