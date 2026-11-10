import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { compilerInputPath, readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const base = "lib/diagram-render", entry = `${base}/src/entry.ts`, producer = `${base}/scripts/build.ts`;
const artifactsPaths = [`${base}/dist/diagram-render.html`, `${base}/dist/BUILD_INFO.json`];
const reportPath = `${base}/dist/diagram-build-provenance.json`;
const tooling = ["build-diagram-resource.mjs", "build-portable-resources.ts", "verify-shared-command-closure.mjs", "resource-workspace.mjs"];
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const fail = code => { throw new Error(`gstack_diagram_${code}`); };

// Fresh workers avoid Bun's file-module cache. Both passes execute the original
// producer with its real import.meta path; its writes stay in memory.
if (!isMainThread && workerData?.kind === "ling-diagram-build") {
  const { root, output } = workerData;
  const originalBuild = Bun.build, originalWrite = Bun.write;
  let build, calls = 0;
  const outputs = new Map();
  try {
    Bun.build = async options => {
      if (++calls !== 1 || options.entrypoints?.length !== 1 || options.entrypoints[0] !== join(root, entry) ||
        options.target !== "browser" || options.minify !== true) fail("build_contract_changed");
      try {
        build = await originalBuild({ ...options, define: { ...options.define, __dirname: '"."' }, write: false, metafile: true });
      } catch (error) { fail(`compile_failed:${String(error).slice(0, 1000)}`); }
      if (!build.success || build.outputs.length !== 1 || !build.metafile?.inputs) fail("compile_failed");
      return build;
    };
    Bun.write = async (destination, bytes) => {
      if (typeof destination !== "string") fail("build_contract_changed");
      const path = compilerInputPath({ rootPath: root, inputPath: destination });
      if (!artifactsPaths.includes(path) || outputs.has(path) || typeof bytes !== "string") fail("build_contract_changed");
      const data = Buffer.from(bytes);
      if (!data.length || data.length > 32 * 1024 ** 2 || data.includes(Buffer.from(root)) || data.includes(Buffer.from(output))) fail("compiled_output_invalid");
      outputs.set(path, data);
      return data.length;
    };
    await import(pathToFileURL(join(root, producer)).href);
    if (calls !== 1 || outputs.size !== 2 || !build) fail("build_contract_changed");
    parentPort.postMessage({ outputs: [...outputs], inputs: build.metafile.inputs });
  } finally { Bun.build = originalBuild; Bun.write = originalWrite; }
}

async function upstreamPass(root, output) {
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { kind: "ling-diagram-build", root, output } });
  try {
    return await new Promise((resolve, reject) => {
      let result, messages = 0;
      worker.on("message", value => { result = value; messages++; });
      worker.once("error", reject);
      worker.once("exit", code => {
        if (code !== 0 || messages !== 1) reject(new Error("gstack_diagram_build_contract_changed"));
        else resolve(result);
      });
    });
  } finally { await worker.terminate(); }
}

async function outputDirectory(root, create = false) {
  let path = root;
  for (const segment of ["lib", "diagram-render", "dist"]) {
    path = join(path, segment);
    if (!await exists(path)) {
      if (!create) return;
      await mkdir(path);
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail("output_root_invalid");
  }
}

export async function buildGstackDiagramResource({ runtimeRoot, outputRoot = runtimeRoot,
  sourceManifestPath, expectedSourceManifestChecksum, expectedCompilerChecksum }) {
  if (!globalThis.Bun || !validChecksum(expectedSourceManifestChecksum) ||
    expectedCompilerChecksum !== undefined && !validChecksum(expectedCompilerChecksum)) fail("detached_inputs_required");
  const lease = await requireResourceLease();
  const root = resolve(runtimeRoot), output = resolve(outputRoot);
  for (const [path, label] of [[root, "input"], [output, "output"]]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail(`${label}_root_invalid`);
  }
  if (await realpath(process.cwd()) !== join(root, base)) fail("build_cwd_required");
  if (output === root) {
    const candidate = dirname(root), staging = dirname(candidate);
    if (basename(root) !== "runtime" || basename(candidate) !== "candidate" ||
      !basename(staging).startsWith(".gstack-native-stage-")) fail("private_staging_required");
    if (!within(lease.scratchPath, staging) && dirname(staging) !== join(lease.root, "artifacts/native")) fail("output_outside_scratch");
  } else if (!within(lease.scratchPath, output) || within(root, output) || within(output, root)) fail("output_outside_scratch");
  await resourceCheckpoint(lease.root, 64 * 1024 ** 2);
  await outputDirectory(output);
  for (const path of [...artifactsPaths, reportPath]) if (await exists(join(output, path))) fail("output_already_exists");
  const manifestFile = resolve(sourceManifestPath);
  const source = await readGstackClosureFileRecord(manifestFile, { retain: true, maximumBytes: 16 * 1024 ** 2 });
  if (source.checksum !== expectedSourceManifestChecksum) fail("source_manifest_mismatch");
  const manifest = JSON.parse(source.bytes);
  if (manifest.schemaVersion !== 1 || manifest.deliveryStage !== "source" || !Array.isArray(manifest.files) ||
    manifest.files.length > 100_000 || !/^[a-f0-9]{40}$/.test(manifest.upstream?.revision ?? "")) fail("source_manifest_invalid");
  const sources = new Map();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !validChecksum(file.checksum) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
      compilerInputPath({ rootPath: root, inputPath: file.path, platform: "darwin" }) !== file.path) fail("source_manifest_invalid");
    if (!file.path.startsWith("runtime/")) continue;
    const key = file.path.slice(8);
    if (sources.has(key)) fail("source_manifest_invalid");
    sources.set(key, file);
  }
  const compilerPath = await realpath(process.execPath), compiler = await readGstackClosureFileRecord(compilerPath);
  if (expectedCompilerChecksum && compiler.checksum !== expectedCompilerChecksum) fail("compiler_mismatch");
  const tools = async () => Promise.all(tooling.map(async path => ({ path: `scripts/gstack/${path}`,
    ...await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url))) })));
  const toolInputs = await tools();
  async function input(path, requireSource = false) {
    const actual = await readGstackClosureFileRecord(join(root, path));
    const expected = sources.get(path);
    if (expected && (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) || requireSource && !expected) fail(`source_input_mismatch:${path}`);
    if (!expected && !/(?:^|\/)node_modules\//.test(path)) fail(`input_unlisted:${path}`);
    return { path, ...actual };
  }
  const required = [producer, entry, `${base}/package.json`];
  for (const path of required) await input(path, true);
  const recipe = { producer, target: "browser", minify: true, define: { __dirname: '"."' }, write: false, metafile: true };
  async function compile() {
    const result = await upstreamPass(root, output);
    const outputs = new Map(result.outputs.map(([path, bytes]) => [path, Buffer.from(bytes)]));
    const entries = Object.entries(result.inputs);
    if (!entries.length || entries.length > 100_000) fail("compiler_graph_invalid");
    const inputs = [], seen = new Set();
    for (const [name, info] of entries) {
      if (!isAbsolute(name) && /^[a-z]:/i.test(name)) fail("compiler_graph_invalid");
      const path = compilerInputPath({ rootPath: root, inputPath: resolve(name) });
      if (seen.has(path)) fail("compiler_graph_invalid");
      seen.add(path);
      const actual = await input(path);
      if (actual.sizeBytes !== info.bytes) fail("build_inputs_changed");
      inputs.push(actual);
    }
    if (!seen.has(entry)) fail("entry_not_compiled");
    const metadata = new Set(required);
    for (const path of [entry, ...seen]) {
      let directory = posix.dirname(path);
      while (true) {
        for (const name of ["package.json", "tsconfig.json", "bunfig.toml"]) metadata.add(posix.join(directory, name));
        if (directory === ".") break;
        directory = posix.dirname(directory);
      }
    }
    for (const path of metadata) if (!seen.has(path) && await exists(join(root, path))) inputs.push(await input(path, required.includes(path)));
    inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
    return { outputs, inputs };
  }
  const first = await compile(), second = await compile(), inputBytes = Buffer.from(JSON.stringify(first.inputs));
  if (!inputBytes.equals(Buffer.from(JSON.stringify(second.inputs))) ||
    artifactsPaths.some(path => !first.outputs.get(path).equals(second.outputs.get(path)))) fail("build_inputs_changed");
  for (const expected of first.inputs) if (JSON.stringify(await input(expected.path)) !== JSON.stringify(expected)) fail("build_inputs_changed");
  if ((await readGstackClosureFileRecord(manifestFile)).checksum !== source.checksum ||
    (await readGstackClosureFileRecord(compilerPath)).checksum !== compiler.checksum ||
    JSON.stringify(await tools()) !== JSON.stringify(toolInputs)) fail("build_inputs_changed");
  const artifacts = artifactsPaths.map(path => ({ path, sizeBytes: second.outputs.get(path).length, checksum: checksum(second.outputs.get(path)) }));
  const report = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
    compiledArtifactBinding: "repeated-upstream-assembly-and-emitted-byte-identity", upstreamRevision: manifest.upstream.revision,
    sourceManifestChecksum: source.checksum, compiler: { ...compiler, version: Bun.version }, toolInputs, recipe,
    inputGraphChecksum: checksum(inputBytes), inputs: first.inputs, artifacts,
    pendingGates: ["other-compiled-artifact-lineage", "dynamic-runtime-resources", "licenses-browser-platform-client-acceptance"] };
  const owned = [];
  try {
    await outputDirectory(output, true);
    for (const [path, bytes] of [...second.outputs, [reportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`)]]) {
      const handle = await open(join(output, path), "wx", 0o600);
      owned.push(join(output, path));
      try { await handle.writeFile(bytes); }
      finally { await handle.close(); }
    }
    for (const artifact of artifacts) if ((await readGstackClosureFileRecord(join(output, artifact.path))).checksum !== artifact.checksum) fail("emitted_output_changed");
    return report;
  } catch (error) { for (const path of owned) await rm(path); throw error; }
}
