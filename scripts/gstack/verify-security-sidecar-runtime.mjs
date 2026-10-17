import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { matchesNativeDependency } from "./runtime-dependency-audit.mjs";

const toolNames = ["verify-security-sidecar-runtime.mjs", "security-sidecar-runtime-probe.mjs", "resource-workspace.mjs",
  "verify-shared-command-closure.mjs", "runtime-dependency-audit.mjs"];
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const fail = code => { throw new Error(`gstack_security_runtime_${code}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

export async function verifyGstackSecuritySidecarRuntime({ runtimeRoot, outputRoot = runtimeRoot,
  sourceManifestPath, expectedSourceManifestChecksum }) {
  if (!sourceManifestPath || !/^sha256:[a-f0-9]{64}$/.test(expectedSourceManifestChecksum ?? "")) fail("source_identity_required");
  const lease = await requireResourceLease();
  const root = resolve(runtimeRoot), output = resolve(outputRoot);
  for (const path of [root, output]) if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) fail("root_invalid");
  if (!within(lease.scratchPath, output) && !(within(join(lease.root, "artifacts/native"), output) &&
    output.split(/[\\/]/).some(part => part.startsWith(".gstack-native-stage-")))) fail("output_not_private");
  const path = join(output, "browse/dist/security-sidecar-runtime-verification.json");
  if (await exists(path)) fail("output_exists");
  const toolInputs = async () => Promise.all(toolNames.map(async path => ({ path: `scripts/gstack/${path}`,
    ...await readGstackClosureFileRecord(join(scriptRoot, path)) })));
  const toolsBefore = await toolInputs();
  const source = await readGstackClosureFileRecord(resolve(sourceManifestPath));
  if (source.checksum !== expectedSourceManifestChecksum) fail("source_manifest_mismatch");
  const manifest = JSON.parse(await readFile(sourceManifestPath));
  if (!/^[a-f0-9]{40}$/.test(manifest.upstream?.revision ?? "")) fail("source_manifest_invalid");
  const sourceFiles = new Map(manifest.files.map(file => [file.path, file]));
  const sourceInputs = [];
  for (const name of ["package.json", "bun.lock"]) {
    const expected = sourceFiles.get(`runtime/${name}`), actual = await readGstackClosureFileRecord(join(root, name));
    if (!expected || expected.checksum !== actual.checksum || expected.sizeBytes !== actual.sizeBytes) fail("source_input_mismatch");
    sourceInputs.push({ path: name, ...actual });
  }
  const metadataPath = join(root, "node_modules/@huggingface/transformers/package.json");
  const metadataBefore = await readGstackClosureFileRecord(metadataPath);
  const metadata = JSON.parse(await readFile(metadataPath));
  if (metadata.name !== "@huggingface/transformers" || metadata.type !== "module" ||
    metadata.exports?.node?.import?.default !== "./dist/transformers.node.mjs") fail("external_entry_invalid");
  const node = join(root, `tools/node${process.platform === "win32" ? ".exe" : ""}`);
  const nodeBefore = await readGstackClosureFileRecord(node);
  if (!await matchesNativeDependency(node, { platform: process.platform, arch: process.arch })) fail("node_target_mismatch");
  const worker = join(scriptRoot, toolNames[1]);
  await resourceCheckpoint(lease.root, 4 * 1024 ** 2);
  const env = { HOME: join(lease.scratchPath, "home"), USERPROFILE: join(lease.scratchPath, "home"),
    TMPDIR: join(lease.scratchPath, "tmp"), TMP: join(lease.scratchPath, "tmp"), TEMP: join(lease.scratchPath, "tmp"),
    PATH: process.platform === "win32" ? process.env.SystemRoot ?? "" : "/usr/bin:/bin",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const result = spawnSync(node, ["--no-warnings", "--max-old-space-size=384", "--permission", "--allow-addons",
    `--allow-fs-read=${root}`, `--allow-fs-read=${worker}`, worker, root], {
    cwd: lease.scratchPath, env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 ** 2, windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr) fail(`load_failed:${String(result.stderr || result.error?.message).slice(0, 4000)}`);
  const observation = JSON.parse(result.stdout);
  if (observation.platform !== process.platform || observation.arch !== process.arch ||
    observation.transformers?.pipeline !== "function" || observation.networkAttempts !== 0 ||
    observation.permissions?.fileWrites !== false || observation.permissions?.childProcesses !== false ||
    !Array.isArray(observation.inputs) || !observation.inputs.length || observation.inputs.length > 10000 ||
    !observation.addons?.some(path => path.endsWith("onnxruntime_binding.node")) ||
    !observation.addons?.some(path => /sharp-.*\.node$/.test(path))) fail("observation_invalid");
  const inputs = observation.inputs;
  for (const file of inputs) {
    const absolute = join(root, file.path);
    if (!within(root, absolute) || !file.path.startsWith("node_modules/") && file.path !== "package.json" && absolute !== node) fail("input_invalid");
    const actual = await readGstackClosureFileRecord(absolute);
    if (actual.checksum !== file.checksum || actual.sizeBytes !== file.sizeBytes) fail("inputs_changed");
  }
  for (const file of sourceInputs) if (JSON.stringify(await readGstackClosureFileRecord(join(root, file.path))) !==
    JSON.stringify({ sizeBytes: file.sizeBytes, checksum: file.checksum })) fail("inputs_changed");
  if (JSON.stringify(await readGstackClosureFileRecord(metadataPath)) !== JSON.stringify(metadataBefore)) fail("inputs_changed");
  if (JSON.stringify(await readGstackClosureFileRecord(node)) !== JSON.stringify(nodeBefore) ||
    (await readGstackClosureFileRecord(resolve(sourceManifestPath))).checksum !== source.checksum ||
    JSON.stringify(await toolInputs()) !== JSON.stringify(toolsBefore)) fail("inputs_changed");
  const { inputs: ignoredInputs, ...observed } = observation;
  const report = { schemaVersion: 1, deliveryStage: "native-runtime-prerequisites", releaseEligible: false,
    upstreamRevision: manifest.upstream.revision, sourceManifestChecksum: source.checksum, toolInputs: toolsBefore,
    node: nodeBefore, sourceInputs, observation: observed, inputs, modelDownloaded: false, classifierModelInference: "pending",
    completeDynamicResourceClosure: "pending", licensesAndInstalledClientAcceptance: "pending",
    networkGuard: "javascript-deny-hooks-not-os-network-sandbox" };
  let directory = output;
  for (const segment of ["browse", "dist"]) {
    directory = join(directory, segment);
    if (!await exists(directory)) await mkdir(directory);
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) fail("output_alias");
  }
  let owned = false;
  try {
    const handle = await open(path, "wx", 0o600);
    owned = true;
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); }
    finally { await handle.close(); }
    await resourceCheckpoint(lease.root);
    return report;
  } catch (error) { if (owned) await rm(path); throw error; }
}
