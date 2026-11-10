import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireResourceLease, within } from "./resource-workspace.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = reason => { throw new Error(`gstack_native_url_${reason}`); };
const expected = {
  "package.json": "sha256:000a0b3b037d4e3e211e7b7ca559a5a62a39b96ca2c6bcdaed3aba0a545eedba",
  "lib/index.js": "sha256:79541f01338e70f4ff6f8a1d12f5c2914d4c6ab2ba96b7ddf48d2add01c13813",
  "lib/index.es.js": "sha256:f786ccb522a08d5296a808bd0aef4bcfb8d9c9b4347e874fbbf6a64c6c1f8b97",
  "lib/index.mjs": "sha256:751ad19bb1be0a02e9d453eedd4a034e68b433bfbf4789c1645ab058882d11f6",
  "LICENSE.md": "sha256:84eaa985e1ef71b8c630e8aba73404c219ff425c6fdb45c62e998b58d4fbdc8e",
};

// Only the unsupported old-Node URL fallback changes. This does not authorize
// deleting legacy packages or treating old compiled binaries as newly rebuilt.
export async function applyLegacyNodeFetchURLPatch({ runtimeRoot }) {
  const lease = await requireResourceLease(), root = resolve(runtimeRoot);
  if (root !== await realpath(root) || !(await lstat(root)).isDirectory()) fail("root_invalid");
  const candidate = dirname(root), stage = dirname(candidate);
  const privateNative = basename(root) === "runtime" && basename(candidate) === "candidate" &&
    basename(stage).startsWith(".gstack-native-stage-") && dirname(stage) === join(lease.root, "artifacts/native");
  if (!within(lease.scratchPath, root) && !privateNative) fail("private_staging_required");
  const packageRoot = join(root, "node_modules/node-fetch");
  if (await realpath(packageRoot) !== packageRoot) fail("root_invalid");
  const inputs = [], sources = new Map();
  for (const [path, checksum] of Object.entries(expected)) {
    const file = await readGstackClosureFileRecord(join(packageRoot, path), { retain: true, maximumBytes: 128 * 1024 });
    if (file.checksum !== checksum) fail("input_changed");
    sources.set(path, file.bytes.toString("utf8"));
    inputs.push({ path, sizeBytes: file.sizeBytes, checksum });
  }
  const metadata = JSON.parse(sources.get("package.json"));
  if (metadata.name !== "node-fetch" || metadata.version !== "2.7.0" || metadata.dependencies?.["whatwg-url"] !== "^5.0.0") fail("input_changed");
  delete metadata.dependencies["whatwg-url"];
  if (!Object.keys(metadata.dependencies).length) delete metadata.dependencies;
  const outputs = new Map([["package.json", `${JSON.stringify(metadata, null, 2)}\n`]]);
  for (const path of ["lib/index.js", "lib/index.es.js", "lib/index.mjs"]) {
    const source = sources.get(path), importLine = path.endsWith("index.js")
      ? "var whatwgUrl = _interopDefault(require('whatwg-url'));\n" : "import whatwgUrl from 'whatwg-url';\n";
    if (source.split(importLine).length !== 2 || source.split("Url.URL || whatwgUrl.URL").length !== 3) fail("input_changed");
    outputs.set(path, source.replace(importLine, "// Ling: bundled Node and Bun provide native URL.\n")
      .replaceAll("Url.URL || whatwgUrl.URL", "Url.URL"));
  }
  for (const file of inputs) if ((await readGstackClosureFileRecord(join(packageRoot, file.path))).checksum !== file.checksum) fail("input_changed");
  const patchPath = "patches/ling-native-url-fallback.mjs";
  const producer = await readGstackClosureFileRecord(fileURLToPath(import.meta.url), { retain: true, maximumBytes: 128 * 1024 });
  await mkdir(join(root, "patches"), { recursive: true });
  if (await realpath(join(root, "patches")) !== join(root, "patches")) fail("root_invalid");
  await writeFile(join(root, patchPath), producer.bytes, { flag: "wx", mode: 0o600 });
  const artifacts = [];
  for (const [path, source] of outputs) {
    await writeFile(join(packageRoot, path), source);
    const actual = await readGstackClosureFileRecord(join(packageRoot, path));
    if (actual.checksum !== hash(source)) fail("output_changed");
    artifacts.push({ path, ...actual });
  }
  const patches = artifacts.map(file => ({ package: "node-fetch", version: metadata.version,
    adaptation: "native-url-without-legacy-fallback", path: `node_modules/node-fetch/${file.path}`,
    beforeChecksum: inputs.find(input => input.path === file.path).checksum, afterChecksum: file.checksum,
    patchPath, patchChecksum: producer.checksum, licenseChecksum: expected["LICENSE.md"],
    legacyPackageRemoval: "pending-complete-runtime-closure" }));
  return { package: "node-fetch", version: metadata.version, adaptation: "native-url-without-legacy-fallback",
    inputs, artifacts, patches, licenseChecksum: expected["LICENSE.md"],
    legacyPackageRemoval: "pending-complete-runtime-closure" };
}
