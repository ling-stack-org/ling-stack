import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compilerInputPath, readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";
import { testsavantGsClientPlugin, testsavantHealthSource, testsavantRequiredModelSource } from "./build-testsavant-component.mjs";
import { admitTestsavantComponent } from "./testsavant-gs-client.mjs";
import { packagedBrowserSource } from "./packaged-browser-source.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const tooling = ["build-node-server-resource.mjs", "build-portable-resources.ts", "build-diagram-resource.mjs", "verify-shared-command-closure.mjs", "resource-workspace.mjs",
  "build-managed-node-server.mjs", "build-testsavant-component.mjs", "testsavant-gs-client.mjs", "testsavant-packaged-client.mjs", "testsavant-client.mjs", "testsavant-model-cache.mjs", "testsavant-model-pin.json", "packaged-browser-source.mjs"];
const scripts = dirname(fileURLToPath(import.meta.url));
const external = ["playwright", "playwright-core", "diff", "bun:sqlite", "@ngrok/ngrok", "socks", "sharp"];
const define = { __dirname: "__browseNodeSrcDir", "import.meta.dir": "__browseNodeSrcDir" };
const banner = [
  'import { fileURLToPath as __gstackFileURLToPath } from "node:url";',
  'import { dirname as __gstackDirname, resolve as __gstackResolve } from "node:path";',
  'import { createRequire as __gstackCreateRequire } from "node:module";',
  'const __browseNodeSrcDir = __gstackResolve(__gstackDirname(__gstackFileURLToPath(import.meta.url)), "../src");',
  '__gstackCreateRequire(import.meta.url)("./bun-polyfill.cjs");',
].join("\n");
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

async function outputDirectory(root, create, fail) {
  let path = root;
  for (const segment of ["browse", "dist"]) {
    path = join(path, segment);
    if (!await exists(path)) {
      if (!create) return;
      await mkdir(path);
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail("output_root_invalid");
  }
}

// Repeat the real build before publication: a separate import-only graph cannot
// retroactively establish which bytes a previously compiled artifact contains.
export function buildGstackNodeServerResource(options) {
  return buildNodeResource(options, false);
}

export function buildGstackSecuritySidecarResource(options) {
  return buildNodeResource(options, true);
}

async function buildNodeResource({ runtimeRoot, outputRoot = runtimeRoot,
  sourceManifestPath, expectedSourceManifestChecksum, expectedCompilerChecksum, testsavantComponent }, sidecar) {
  const fail = code => { throw new Error(`gstack_${sidecar ? "security_sidecar" : "node_server"}_${code}`); };
  const entry = sidecar ? "browse/src/security-sidecar-entry.ts" : "browse/src/server.ts";
  const polyfill = sidecar ? null : "browse/src/bun-polyfill.cjs";
  const paths = sidecar ? ["browse/dist/security-sidecar.js", "browse/dist/security-sidecar-build-provenance.json"]
    : ["browse/dist/server-node.mjs", "browse/dist/bun-polyfill.cjs", "browse/dist/node-server-build-provenance.json"];
  const recipe = sidecar ? { target: "node", format: "esm", external: ["@huggingface/transformers"], write: false, metafile: true }
    : { target: "node", external, define, banner, write: false, metafile: true };
  if (!globalThis.Bun || !validChecksum(expectedSourceManifestChecksum) ||
    expectedCompilerChecksum !== undefined && !validChecksum(expectedCompilerChecksum)) fail("detached_inputs_required");
  const lease = await requireResourceLease();
  const root = resolve(runtimeRoot), output = resolve(outputRoot);
  if (testsavantComponent && sidecar) fail("component_target_invalid");
  const componentAdmission = testsavantComponent && { runtimeRoot: root,
    modelRoot: join(output, "models/testsavant-small"), componentRoot: resolve(testsavantComponent.root),
    componentChecksum: testsavantComponent.checksum };
  if (componentAdmission) componentAdmission.modelMode = (await admitTestsavantComponent(componentAdmission)).modelMode;
  for (const [path, label] of [[root, "input"], [output, "output"]]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) fail(`${label}_root_invalid`);
  }
  if (await realpath(process.cwd()) !== root) fail("build_cwd_required");
  if (output === root) {
    const candidate = dirname(root), staging = dirname(candidate);
    if (basename(root) !== "runtime" || basename(candidate) !== "candidate" ||
      !basename(staging).startsWith(".gstack-native-stage-")) fail("private_staging_required");
    if (!within(lease.scratchPath, staging) && dirname(staging) !== join(lease.root, "artifacts/native")) fail("output_outside_scratch");
  } else {
    if (!within(lease.scratchPath, output) || within(root, output) || within(output, root)) fail("output_outside_scratch");
  }
  await resourceCheckpoint(lease.root, 32 * 1024 ** 2);
  await outputDirectory(output, false, fail);
  for (const path of paths) if (await exists(join(output, path))) fail("output_already_exists");
  const manifestFile = resolve(sourceManifestPath);
  const source = await readGstackClosureFileRecord(manifestFile, { retain: true, maximumBytes: 16 * 1024 ** 2 });
  if (source.checksum !== expectedSourceManifestChecksum) fail("source_manifest_mismatch");
  const manifest = JSON.parse(source.bytes);
  if (manifest.schemaVersion !== 1 || manifest.deliveryStage !== "source" || !Array.isArray(manifest.files) ||
    manifest.files.length > 100_000 || !/^[a-f0-9]{40}$/.test(manifest.upstream?.revision ?? "")) fail("source_manifest_invalid");
  const sources = new Map();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !validChecksum(file.checksum) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) fail("source_manifest_invalid");
    const path = compilerInputPath({ rootPath: root, inputPath: file.path, platform: "darwin" });
    if (path !== file.path) fail("source_manifest_invalid");
    if (!path.startsWith("runtime/")) continue;
    const key = path.slice(8);
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
    if (!expected && !path.startsWith("node_modules/")) fail(`input_unlisted:${path}`);
    return { path, ...actual };
  }
  await input(entry, true);
  const copiedInput = polyfill && await input(polyfill, true);
  const externalInputs = [];
  if (sidecar) {
    const metadata = await input("package.json", true);
    if (JSON.parse(await readFile(join(root, metadata.path))).type !== "module") fail("module_package_required");
    const pkg = "node_modules/@huggingface/transformers";
    const externalMetadata = await input(`${pkg}/package.json`);
    const packageData = JSON.parse(await readFile(join(root, externalMetadata.path)));
    if (packageData.name !== "@huggingface/transformers" || packageData.type !== "module" ||
      packageData.exports?.node?.import?.default !== "./dist/transformers.node.mjs") fail("external_entry_invalid");
    // Keep native ONNX loading on disk under Node, not inside a Bun executable.
    // These bindings are not a claim of complete transitive native/model closure.
    externalInputs.push(externalMetadata, await input(`${pkg}/dist/transformers.node.mjs`));
  }
  async function compile() {
    let result;
      try { result = await Bun.build({ ...recipe, entrypoints: [join(root, entry)],
        ...(componentAdmission ? { plugins: [testsavantGsClientPlugin({ componentChecksum: componentAdmission.componentChecksum,
          modelMode: componentAdmission.modelMode ?? "bundled" })] } : {}) }); }
    catch (error) { fail(`compile_failed:${String(error).slice(0, 1000)}`); }
    if (!result.success || result.outputs.length !== 1 || !result.metafile?.inputs) fail(`compile_failed:${result.logs.map(String).join("\n").slice(0, 1000)}`);
    const bytes = Buffer.from(await result.outputs[0].arrayBuffer());
    if (!bytes.length || bytes.length > 16 * 1024 ** 2 || bytes.includes(Buffer.from(root)) || bytes.includes(Buffer.from(output))) fail("compiled_output_invalid");
    const entries = Object.entries(result.metafile.inputs);
    if (!entries.length || entries.length > 100_000) fail("compiler_graph_invalid");
    const inputs = [], seen = new Set();
    for (const [name, info] of entries) {
      if (!isAbsolute(name) && /^[a-z]:/i.test(name)) fail("compiler_graph_invalid");
      const absolute = resolve(name);
      if (componentAdmission && within(scripts, absolute)) {
        const path = `scripts/gstack/${absolute.slice(scripts.length + 1)}`;
        if (seen.has(path)) fail("compiler_graph_invalid");
        seen.add(path);
        inputs.push({ path, ...await readGstackClosureFileRecord(absolute) });
        continue;
      }
      const path = compilerInputPath({ rootPath: root, inputPath: absolute });
      if (seen.has(path)) fail("compiler_graph_invalid");
      seen.add(path);
      const actual = await input(path);
      const size = componentAdmission && path === "browse/src/routes/core.ts"
        ? Buffer.byteLength(testsavantHealthSource(await readFile(join(root, path), "utf8"), componentAdmission.componentChecksum))
        : componentAdmission?.modelMode === "download-required" && path === "browse/src/routes/pty.ts"
          ? Buffer.byteLength(testsavantRequiredModelSource(await readFile(join(root, path), "utf8")))
        : componentAdmission && path === "browse/src/browser-manager.ts"
          ? Buffer.byteLength(packagedBrowserSource(await readFile(join(root, path), "utf8"))) : actual.sizeBytes;
      if (size !== info.bytes) fail("build_inputs_changed");
      inputs.push(actual);
    }
    if (!seen.has(entry)) fail("entry_not_compiled");
    // Package/config metadata participates in resolution but is absent from a
    // Bun metafile. Bind it as well, including nested package boundaries.
    const metadata = new Set(["package.json", "tsconfig.json", "bunfig.toml"]);
    for (const path of seen) {
      if (path.startsWith("scripts/gstack/")) continue;
      let directory = posix.dirname(path);
      while (directory !== ".") { metadata.add(posix.join(directory, "package.json")); directory = posix.dirname(directory); }
    }
    for (const path of metadata) if (!seen.has(path) && await exists(join(root, path))) inputs.push(await input(path));
    if (polyfill) inputs.push(await input(polyfill, true));
    inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
    return { bytes, inputs };
  }
  const first = await compile(), second = await compile();
  const inputBytes = Buffer.from(JSON.stringify(first.inputs));
  if (!first.bytes.equals(second.bytes) || !inputBytes.equals(Buffer.from(JSON.stringify(second.inputs)))) fail("build_inputs_changed");
  for (const expected of first.inputs) {
    const actual = expected.path.startsWith("scripts/gstack/")
      ? { path: expected.path, ...await readGstackClosureFileRecord(join(scripts, expected.path.slice(15))) }
      : await input(expected.path);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("build_inputs_changed");
  }
  if (componentAdmission) await admitTestsavantComponent(componentAdmission);
  for (const expected of externalInputs) if (JSON.stringify(await input(expected.path)) !== JSON.stringify(expected)) fail("build_inputs_changed");
  if ((await readGstackClosureFileRecord(manifestFile)).checksum !== source.checksum ||
    (await readGstackClosureFileRecord(compilerPath)).checksum !== compiler.checksum ||
    JSON.stringify(await tools()) !== JSON.stringify(toolInputs)) fail("build_inputs_changed");
  const polyfillBytes = polyfill && await readFile(join(root, polyfill));
  if (polyfill && checksum(polyfillBytes) !== copiedInput.checksum) fail("build_inputs_changed");
  const artifacts = [{ path: paths[0], sizeBytes: second.bytes.length, checksum: checksum(second.bytes) }];
  if (polyfill) artifacts.push({ path: paths[1], sizeBytes: polyfillBytes.length, checksum: checksum(polyfillBytes) });
  const report = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
    compiledArtifactBinding: "repeated-compilation-and-emitted-byte-identity", upstreamRevision: manifest.upstream.revision,
    sourceManifestChecksum: source.checksum, compiler: { ...compiler, version: Bun.version }, toolInputs,
    recipe: { entrypoint: entry, ...recipe }, inputGraphChecksum: checksum(inputBytes), inputs: first.inputs, artifacts,
    ...(componentAdmission ? { securityComponentChecksum: componentAdmission.componentChecksum,
      securityActivation: "package-relative-admission-before-server-start" } : {}),
    ...(sidecar ? { externalInputs, runtimeResourceSelection: "pending", modelDownloadAcceptance: "pending" } : {}),
    pendingGates: ["other-compiled-artifact-lineage", "dynamic-runtime-resources", "licenses-browser-platform-client-acceptance"] };
  const owned = [];
  try {
    await outputDirectory(output, true, fail);
    for (const [path, bytes] of [[paths[0], second.bytes], ...(polyfill ? [[paths[1], polyfillBytes]] : []),
      [paths.at(-1), Buffer.from(`${JSON.stringify(report, null, 2)}\n`)]]) {
      const handle = await open(join(output, path), "wx", 0o600);
      owned.push(join(output, path));
      try { await handle.writeFile(bytes); }
      finally { await handle.close(); }
    }
    for (const artifact of artifacts) if ((await readGstackClosureFileRecord(join(output, artifact.path))).checksum !== artifact.checksum) fail("emitted_output_changed");
    return report;
  } catch (error) { for (const path of owned) await rm(path); throw error; }
}
