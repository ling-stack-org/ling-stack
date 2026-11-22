#!/usr/bin/env node
import { createHash, sign } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const JSZip = require(require.resolve("jszip", {
  paths: [
    fileURLToPath(new URL(".", import.meta.url)),
    fileURLToPath(new URL("../../packages/daemon", import.meta.url)),
  ],
}));

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? "packages/daemon/src/features/plugins/bundled/cua-driver");
const output = resolve(args.output ?? "plugins/dist");
const platform = args.platform ?? process.platform;
const arch = args.arch ?? process.arch;
const original = JSON.parse(await readFile(join(root, ".ling-plugin/plugin.json"), "utf8"));
const version = args.version ?? original.version;
const sourceSha = args.sourceSha ?? "local";
const sourceRepository = args.repository ?? "ling-stack-org/ling-stack";
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Invalid plugin version.");
if (typeof sourceRepository !== "string" || !/^[0-9A-Za-z-]+\/[0-9A-Za-z_.-]+$/u.test(sourceRepository)) {
  throw new Error("Invalid plugin release repository.");
}
if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64", "ia32", "universal"].includes(arch)) throw new Error("Invalid platform or architecture.");

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
const manifestPath = ".ling-plugin/plugin.json";
const checksumsPath = ".ling-plugin/checksums.json";
const provenancePath = ".ling-plugin/provenance.json";
const checksums = Object.create(null);
const date = new Date(0);
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
zip.file(manifestPath, manifestBytes, { date });
checksums[manifestPath] = sha256(manifestBytes);
for (const file of await listFiles(root)) {
  const name = relative(root, file.path).split(sep).join("/");
  if (name === manifestPath) continue;
  if (name === checksumsPath || name === provenancePath) {
    throw new Error("Plugin package input includes reserved metadata: " + name);
  }
  const data = await readFile(file.path);
  zip.file(name, data, { date, unixPermissions: file.executable ? 0o100755 : 0o100644 });
  checksums[name] = sha256(data);
}
zip.file(checksumsPath, JSON.stringify({ algorithm: "sha256", files: checksums }, null, 2) + "\n", { date });
const provenance = { schemaVersion: 1, sourceSha, generatedAt: new Date().toISOString(), artifactId };
zip.file(provenancePath, JSON.stringify(provenance, null, 2) + "\n", { date });
const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 9 } });
const artifactName = `${sanitize(pluginId)}-${version}-${platform}-${arch}.ling-plugin.zip`;
await mkdir(output, { recursive: true });
await writeFile(join(output, artifactName), bytes);
const record = {
  artifactId,
  pluginId,
  version,
  platform,
  arch,
  channel: args.channel ?? "dev",
  url: args.url ?? `https://github.com/${sourceRepository}/releases/download/${args.releaseTag ?? `plugin-${version}`}/${artifactName}`,
  sizeBytes: bytes.length,
  sha256: sha256(bytes),
  ...(process.env.LING_PLUGIN_ARTIFACT_PRIVATE_KEY
    ? { signature: `ed25519:${sign(null, bytes, process.env.LING_PLUGIN_ARTIFACT_PRIVATE_KEY).toString("base64")}` }
    : {}),
  minLingVersion: args.minLingVersion,
  maxLingVersion: args.maxLingVersion,
  rollbackAllowed: args.rollbackAllowed !== "false",
};
await writeFile(join(output, `${artifactName}.json`), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ artifact: join(output, artifactName), ...record }, null, 2));

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const info = await lstat(path);
    if (info.isDirectory()) result.push(...await listFiles(path));
    else if (info.isFile()) result.push({ path, executable: Boolean(info.mode & 0o111) });
    else throw new Error("Plugin package input contains a non-regular entry: " + path);
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

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
