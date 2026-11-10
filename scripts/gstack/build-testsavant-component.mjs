import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";
import { packagedBrowserSource } from "./packaged-browser-source.mjs";
import { compilerInputPath, readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { testsavantModelAcquisition } from "./testsavant-model-cache.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function testsavantHealthSource(source, componentChecksum) {
  const marker = "        status: healthy ? 'healthy' : 'unhealthy',";
  if (source.split(marker).length !== 2) throw new Error("testsavant_health_marker_invalid");
  return source.replace(marker, `${marker}\n        lingComponent: ${JSON.stringify(componentChecksum)},`);
}
export function testsavantRequiredModelSource(source) {
  const marker = "          // L4 failure during scan: degrade to WARN per D7.\n          if (verdict === 'PASS') {\n            verdict = 'WARN';";
  if (source.split(marker).length !== 2) throw new Error("testsavant_required_model_route_marker_invalid");
  const unavailable = "      } else if (!sidecarAvail.available && verdict === 'PASS') {\n        verdict = 'WARN';";
  if (source.split(unavailable).length !== 2) throw new Error("testsavant_required_model_unavailable_marker_invalid");
  return source.replace(marker, "          // A required local classifier must complete before content can pass.\n          if (verdict !== 'BLOCK') {\n            verdict = 'BLOCK';")
    .replace(unavailable, "      } else if (!sidecarAvail.available && verdict !== 'BLOCK') {\n        verdict = 'BLOCK';");
}

export function testsavantGsClientPlugin({ componentChecksum, modelMode = "bundled" } = {}) {
  if (componentChecksum !== undefined && !/^sha256:[a-f0-9]{64}$/.test(componentChecksum)) {
    throw new Error("testsavant_component_pin_invalid");
  }
  const client = join(scripts, componentChecksum ? "testsavant-packaged-client.mjs" : "testsavant-gs-client.mjs");
  return { name: "ling-managed-testsavant-client", setup(build) {
    build.onResolve({ filter: /(?:^|[\\/])security-sidecar-client$/ }, () => ({ path: client }));
    if (modelMode === "download-required") build.onLoad({ filter: /browse[\\/]src[\\/]routes[\\/]pty\.ts$/ }, async args => ({
      contents: testsavantRequiredModelSource(await readFile(args.path, "utf8")), loader: "ts", resolveDir: dirname(args.path),
    }));
    if (componentChecksum) build.onLoad({ filter: /browse[\\/]src[\\/]browser-manager\.ts$/ }, async args => ({
      contents: packagedBrowserSource(await readFile(args.path, "utf8")), loader: "ts", resolveDir: dirname(args.path),
    }));
    if (componentChecksum) build.onLoad({ filter: /browse[\\/]src[\\/]routes[\\/]core\.ts$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      return { contents: testsavantHealthSource(source, componentChecksum),
        loader: "ts", resolveDir: dirname(args.path) };
    });
    if (componentChecksum) build.onLoad({ filter: /testsavant-packaged-client\.mjs$/ }, async args => {
      if (args.path !== client) throw new Error("testsavant_client_input_invalid");
      const source = await readFile(client, "utf8");
      const marker = 'const componentChecksum = "NO_PACKAGED_TESTSAVANT_COMPONENT";';
      if (source.split(marker).length !== 2) throw new Error("testsavant_client_marker_invalid");
      return { contents: source.replace(marker, `const componentChecksum = ${JSON.stringify(componentChecksum)};`), loader: "js" };
    });
  } };
}

// Only small component outputs are built here. Frozen retained inputs are
// authenticated and read-only; no dependency tree or model is copied.
export async function buildTestsavantComponent({ runtimeRoot, outputRoot, sourceManifestPath, sourceManifestChecksum,
  productionOnly = false, modelMode = "bundled" }) {
  if (!["bundled", "download-required"].includes(modelMode)) throw new Error("testsavant_model_mode_invalid");
  if (typeof productionOnly !== "boolean") throw new Error("testsavant_component_mode_invalid");
  if (!globalThis.Bun) throw new Error("testsavant_bun_build_required");
  const lease = await requireResourceLease();
  runtimeRoot = resolve(runtimeRoot); outputRoot = resolve(outputRoot);
  if (!within(lease.scratchPath, outputRoot) || within(runtimeRoot, outputRoot)) throw new Error("testsavant_private_output_required");
  if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error("testsavant_runtime_alias");
  await resourceCheckpoint(lease.root, 32 * 1024 ** 2);
  const source = await readGstackClosureFileRecord(sourceManifestPath, { retain: true, maximumBytes: 16 * 1024 ** 2 });
  if (source.checksum !== sourceManifestChecksum) throw new Error("testsavant_source_manifest_mismatch");
  const manifest = JSON.parse(source.bytes), sources = new Map(manifest.files.map(f => [f.path.replace(/^runtime\//, ""), f]));
  if (manifest.upstream?.revision !== "47d639abffa882b8cbb641d7d1dedf08ecada9ec") throw new Error("testsavant_source_revision_mismatch");
  const compiler = await readGstackClosureFileRecord(await realpath(process.execPath));
  const producer = await readGstackClosureFileRecord(fileURLToPath(import.meta.url));
  const sourceReferences = [];
  for (const path of ["browse/src/security-sidecar-entry.ts", "browse/src/security-classifier.ts", "browse/src/security-sidecar-client.ts", "browse/src/find-security-sidecar.ts"]) {
    const actual = await readGstackClosureFileRecord(join(runtimeRoot, path)), expected = sources.get(path);
    if (!expected || actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) throw new Error("testsavant_reference_mismatch");
    sourceReferences.push({ path, ...actual });
  }
  await mkdir(outputRoot, { recursive: true });
  if (await realpath(outputRoot) !== outputRoot) throw new Error("testsavant_output_alias");
  const builds = [
    { name: "testsavant-sidecar.mjs", entry: `import ${JSON.stringify(join(scripts, "testsavant-offline-guard.mjs"))};
      import {runTestsavantWorker} from ${JSON.stringify(join(scripts, "testsavant-worker.mjs"))};
      import {combineVerdict} from ${JSON.stringify(join(runtimeRoot, "browse/src/security.ts"))}; runTestsavantWorker(combineVerdict);` },
    { name: "testsavant-pty-route.mjs", entry: `export {ptyRoutes} from ${JSON.stringify(join(runtimeRoot, "browse/src/routes/pty.ts"))};
      export {admitTestsavantComponent,configureTestsavantSidecar,closeTestsavantSidecar} from ${JSON.stringify(join(scripts, "testsavant-gs-client.mjs"))};` },
    { name: "testsavant-upstream-parity.mjs", entry: `export * from ${JSON.stringify(join(runtimeRoot, "browse/src/security-classifier.ts"))};
      export {combineVerdict,THRESHOLDS} from ${JSON.stringify(join(runtimeRoot, "browse/src/security.ts"))};` },
  ].filter((_, index) => !productionOnly || index === 0);
  const records = [], bound = new Map();
  for (const spec of builds) {
    const virtual = join(outputRoot, `${spec.name}.entry.ts`);
    await writeFile(virtual, spec.entry, { flag: "wx" });
    const compile = async () => {
      const result = await Bun.build({ entrypoints: [virtual], target: "node", format: "esm", minifyWhitespace: true, write: false, metafile: true,
        external: ["@huggingface/transformers"], plugins: [testsavantGsClientPlugin(), {
          name: "immutable-component-entry", setup(build) {
            build.onLoad({ filter: /\.entry\.ts$/ }, args => args.path === virtual ? { contents: spec.entry, loader: "ts", resolveDir: runtimeRoot } : undefined);
          },
        }] });
      if (!result.success || result.outputs.length !== 1) throw new Error(`testsavant_compile_failed:${result.logs.map(String).join("\n")}`);
      const inputs = [];
      for (const name of Object.keys(result.metafile.inputs)) {
        const path = resolve(name);
        if (path === virtual) continue;
        const actual = await readGstackClosureFileRecord(path);
        let relative;
        if (within(runtimeRoot, path)) {
          relative = compilerInputPath({ rootPath: runtimeRoot, inputPath: path });
          const expected = sources.get(relative);
          if (!expected || actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) throw new Error(`testsavant_build_source_mismatch:${relative}`);
          relative = `runtime/${relative}`;
        } else if (within(scripts, path)) relative = `scripts/gstack/${compilerInputPath({ rootPath: scripts, inputPath: path })}`;
        else throw new Error("testsavant_unlisted_build_input");
        inputs.push({ path: relative, ...actual });
        bound.set(relative, { actualPath: path, ...actual });
      }
      const metadata = new Set(["package.json", "tsconfig.json", "bunfig.toml"]);
      for (const item of inputs.filter(item => item.path.startsWith("runtime/"))) {
        let directory = posix.dirname(item.path.slice(8));
        while (directory !== ".") { metadata.add(posix.join(directory, "package.json")); directory = posix.dirname(directory); }
      }
      for (const relative of metadata) {
        const path = join(runtimeRoot, relative);
        const stat = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (!stat || inputs.some(item => item.path === `runtime/${relative}`)) continue;
        const actual = await readGstackClosureFileRecord(path), expected = sources.get(relative);
        if (!expected || actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) {
          throw new Error(`testsavant_build_metadata_mismatch:${relative}`);
        }
        inputs.push({ path: `runtime/${relative}`, ...actual });
        bound.set(`runtime/${relative}`, { actualPath: path, ...actual });
      }
      inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
      return { bytes: Buffer.from(await result.outputs[0].arrayBuffer()), inputs };
    };
    const first = await compile(), second = await compile();
    if (!first.bytes.equals(second.bytes) || JSON.stringify(first.inputs) !== JSON.stringify(second.inputs)) throw new Error("testsavant_build_changed");
    if (first.bytes.length > 2 * 1024 ** 2 || !first.bytes.length) throw new Error("testsavant_artifact_size_invalid");
    await writeFile(join(outputRoot, spec.name), first.bytes, { flag: "wx", mode: 0o600 });
    records.push({ path: spec.name, sizeBytes: first.bytes.length, checksum: hash(first.bytes), inputs: first.inputs });
  }
  for (const { actualPath, ...expected } of bound.values()) {
    if (JSON.stringify(await readGstackClosureFileRecord(actualPath)) !== JSON.stringify(expected)) throw new Error("testsavant_build_changed");
  }
  if ((await readGstackClosureFileRecord(sourceManifestPath)).checksum !== source.checksum ||
    JSON.stringify(await readGstackClosureFileRecord(await realpath(process.execPath))) !== JSON.stringify(compiler) ||
    (await readGstackClosureFileRecord(fileURLToPath(import.meta.url))).checksum !== producer.checksum) throw new Error("testsavant_build_changed");
  const transformers = join(runtimeRoot, "node_modules/@huggingface/transformers");
  // Parity module alone keeps the original package import. A tiny wrapper
  // resolves that import to the retained native runtime without copying it.
  if (!productionOnly) {
    await mkdir(join(outputRoot, "node_modules/@huggingface/transformers"), { recursive: true });
    await writeFile(join(outputRoot, "node_modules/@huggingface/transformers/package.json"),
      '{"type":"module","exports":"./index.mjs"}\n', { flag: "wx" });
    await writeFile(join(outputRoot, "node_modules/@huggingface/transformers/index.mjs"),
      `export * from ${JSON.stringify(join(transformers, "dist/transformers.node.mjs"))};\n`, { flag: "wx" });
  }
  const externalInputs = [];
  for (const path of ["package.json", "dist/transformers.node.mjs"]) externalInputs.push({ path: `node_modules/@huggingface/transformers/${path}`,
    ...await readGstackClosureFileRecord(join(transformers, path)) });
  const report = { schemaVersion: 1, scope: "managed-testsavant-component", releaseEligible: false,
    ...(modelMode === "download-required" ? { modelAcquisition: testsavantModelAcquisition() } : {}),
    runtimeMode: productionOnly ? "production-worker-only" : "comparison-harness",
    sourceManifestChecksum: source.checksum, compiler, producer, sourceReferences, artifacts: records, externalInputs,
    node: await readGstackClosureFileRecord(join(runtimeRoot, "tools", process.platform === "win32" ? "node.exe" : "node")),
    scopeBoundary: "authentic-gs-route-and-combiner-with-authored-bounded-client-worker; upstream-parity-is-comparison-only",
    pendingGates: ["outer-resource-admission-and-host-activation", "installed-mac-windows", "representative-quality", "redistribution-authorization"] };
  await writeFile(join(outputRoot, "testsavant-component.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, outputRoot, sourceManifestPath, checksum, ...extra] = process.argv.slice(2);
  if (!checksum || extra.length) throw new Error("testsavant_build_arguments_invalid");
  const report = await buildTestsavantComponent({ runtimeRoot, outputRoot, sourceManifestPath, sourceManifestChecksum: checksum });
  console.log(JSON.stringify({ artifacts: report.artifacts.map(({ inputs, ...artifact }) => artifact) }));
}
