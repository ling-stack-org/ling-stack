import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget, buildEnvironment } from "./build-native-runtime.mjs";
import { compilerInputPath, readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { requireResourceLease, resourceCheckpoint, resourceTreeBytes, within } from "./resource-workspace.mjs";
import { packagedBrowseBuildPlugin, readPackagedBrowseBuildPins } from "./packaged-browse-build.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const recipes = {
  browse: ["browse/src/cli.ts", "browse/dist/browse"],
  "packaged-browse": ["browse/src/cli.ts", "browse/dist/browse"],
  "find-browse": ["browse/src/find-browse.ts", "browse/dist/find-browse"],
  design: ["design/src/cli.ts", "design/dist/design"],
  pdf: ["make-pdf/src/cli.ts", "make-pdf/dist/pdf"],
  "global-discover": ["bin/gstack-global-discover.ts", "bin/gstack-global-discover"],
};
const compileFlags = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json"];
const tooling = ["build-bun-native-resource.mjs", "build-native-runtime.mjs", "verify-shared-command-closure.mjs", "resource-workspace.mjs",
  "packaged-browse-build.mjs", "packaged-browse-launch.mjs", "browser-acquisition.mjs", "inspect-browser-zip.mjs"];
const ownedCompilerInputs = ["scripts/gstack/packaged-browse-launch.mjs", "scripts/gstack/browser-acquisition.mjs",
  "scripts/gstack/inspect-browser-zip.mjs", "packages/core/src/bundled-skill-browser.ts"];
const scripts = dirname(fileURLToPath(import.meta.url));
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const fail = code => { throw new Error(`gstack_bun_native_${code}`); };

async function outputDirectory(root, path, create = false) {
  for (const segment of posix.dirname(path).split("/")) {
    root = join(root, segment);
    if (!await exists(root)) {
      if (!create) return;
      await mkdir(root);
    }
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) fail("output_root_invalid");
  }
}

export async function buildGstackBunNativeResource({ kind, runtimeRoot, outputRoot = runtimeRoot,
  sourceManifestPath, expectedSourceManifestChecksum, bunPath, expectedCompilerChecksum, packagedServer }) {
  if (!Object.hasOwn(recipes, kind)) fail("recipe_invalid");
  if (!validChecksum(expectedSourceManifestChecksum) || !validChecksum(expectedCompilerChecksum)) fail("detached_inputs_required");
  const target = { platform: process.platform, arch: process.arch };
  if (!["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) fail("target_invalid");
  const lease = await requireResourceLease();
  const root = resolve(runtimeRoot), output = resolve(outputRoot);
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
  } else if (!within(lease.scratchPath, output) || within(root, output) || within(output, root)) fail("output_outside_scratch");
  await resourceCheckpoint(lease.root, 256 * 1024 ** 2);
  const [entry, outputBase] = recipes[kind];
  const path = `${outputBase}${target.platform === "win32" ? ".exe" : ""}`, reportPath = `${path}.build-provenance.json`;
  await outputDirectory(output, path);
  for (const file of [path, reportPath]) if (await exists(join(output, file))) fail("output_already_exists");
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
  const compilerPath = resolve(bunPath), compiler = await readGstackClosureFileRecord(compilerPath);
  if (compiler.checksum !== expectedCompilerChecksum) fail("compiler_mismatch");
  assertNativeTarget(await readFile(compilerPath), target);
  const packaged = kind === "packaged-browse";
  if (packaged && (!globalThis.Bun || !packagedServer) || !packaged && packagedServer) fail("packaged_server_required");
  if (packaged && (await realpath(process.execPath)) !== compilerPath) fail("compiler_mismatch");
  const launchSelection = packaged && { ...packagedServer, runtimeRoot: root };
  const launchPins = packaged && await readPackagedBrowseBuildPins(launchSelection, source.checksum);
  const tools = async () => Promise.all(tooling.map(async name => ({ path: `scripts/gstack/${name}`,
    ...await readGstackClosureFileRecord(fileURLToPath(new URL(name, import.meta.url))) })));
  const toolInputs = await tools();
  async function input(name, requireSource = false) {
    const actual = await readGstackClosureFileRecord(join(root, name)), expected = sources.get(name);
    if (expected && (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) || requireSource && !expected) fail(`source_input_mismatch:${name}`);
    if (!expected && !/(?:^|\/)node_modules\//.test(name)) fail(`input_unlisted:${name}`);
    return { path: name, ...actual };
  }
  await input(entry, true);
  if (launchPins?.browser?.parser) {
    const parser = await input(launchPins.browser.parser.path);
    if (parser.checksum !== launchPins.browser.parser.checksum || parser.sizeBytes !== launchPins.browser.parser.sizeBytes) fail("build_inputs_changed");
  }
  const sourceDirectory = posix.relative(posix.dirname(outputBase), posix.dirname(entry)) || ".";
  const dirnameExpression = `__dirname=require("node:path").resolve(require("node:path").dirname(process.execPath),${JSON.stringify(sourceDirectory)})`;
  const recipe = { kind, entrypoint: entry, outputPath: path, compileFlags, dirnameExpression };
  const work = await mkdtemp(join(lease.scratchPath, "tmp", ".ling-native-compile-"));
  const owned = [];
  try {
    const env = buildEnvironment({ bunPath: compilerPath, nodePath: process.execPath,
      home: join(lease.scratchPath, "home"), temporary: join(lease.scratchPath, "tmp"), cachePath: join(lease.root, "cache/bun") });
    async function compile(pass) {
      const directory = join(work, pass);
      await mkdir(directory);
      const binary = join(directory, basename(path)), metafile = join(directory, "metafile.json");
      const args = ["--no-env-file", "--no-install", "build", "--compile", ...compileFlags, "--define", dirnameExpression,
        entry, "--outfile", binary, `--metafile=${metafile}`];
      let graph;
      try {
        if (packaged) {
          const result = await Bun.build({ entrypoints: [join(root, entry)], target: "bun", metafile: true,
            define: { __dirname: dirnameExpression.slice("__dirname=".length) },
            compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false,
              autoloadTsconfig: false, autoloadPackageJson: false },
            plugins: [packagedBrowseBuildPlugin({ runtimeRoot: root, pins: launchPins })] });
          if (!result.success || !result.metafile?.inputs) throw new Error(result.logs.map(String).join("\n"));
          graph = result.metafile;
        } else execFileSync(compilerPath, args, { cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] });
      }
      catch (error) { fail(`compile_failed:${String(error.stderr ?? error).slice(0, 1000)}`); }
      const bytes = await readFile(binary);
      assertNativeTarget(bytes, target);
      if (!bytes.length || bytes.length > 128 * 1024 ** 2 || [root, output, work].some(value => bytes.includes(Buffer.from(value)))) fail("compiled_output_invalid");
      const artifact = { path, sizeBytes: bytes.length, checksum: checksum(bytes) };
      if (!packaged) graph = JSON.parse((await readGstackClosureFileRecord(metafile, { retain: true, maximumBytes: 16 * 1024 ** 2 })).bytes);
      const entries = Object.entries(graph.inputs ?? {});
      if (!entries.length || entries.length > 100_000) fail("compiler_graph_invalid");
      const inputs = [], seen = new Set();
      for (const [name, info] of entries) {
        if (!isAbsolute(name) && /^[a-z]:/i.test(name)) fail("compiler_graph_invalid");
        const absolute = resolve(root, name);
        const owned = packaged && ownedCompilerInputs.find(path => absolute === resolve(scripts, "../..", path));
        if (owned) {
          inputs.push({ path: owned, ...await readGstackClosureFileRecord(absolute) });
          continue;
        }
        const key = compilerInputPath({ rootPath: root, inputPath: resolve(root, name) });
        if (seen.has(key)) fail("compiler_graph_invalid");
        seen.add(key);
        const actual = await input(key);
        if (actual.sizeBytes !== info.bytes && !(packaged && key === entry)) fail("build_inputs_changed");
        inputs.push(actual);
      }
      if (!seen.has(entry)) fail("entry_not_compiled");
      if (launchPins?.browser?.parser && !seen.has(launchPins.browser.parser.path)) {
        const parser = await input(launchPins.browser.parser.path);
        inputs.push(parser);
        seen.add(parser.path);
      }
      const metadata = new Set();
      for (const key of seen) {
        let directory = posix.dirname(key);
        while (true) {
          for (const name of ["package.json", "tsconfig.json", "bunfig.toml"]) metadata.add(posix.join(directory, name));
          if (directory === ".") break;
          directory = posix.dirname(directory);
        }
      }
      for (const key of metadata) if (!seen.has(key) && await exists(join(root, key))) inputs.push(await input(key));
      inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
      await resourceCheckpoint(lease.root);
      return { artifact, inputs, binary, directory };
    }
    const first = await compile("first"), second = await compile("second"), inputBytes = Buffer.from(JSON.stringify(first.inputs));
    if (JSON.stringify(first.artifact) !== JSON.stringify(second.artifact) ||
      !inputBytes.equals(Buffer.from(JSON.stringify(second.inputs)))) fail("build_inputs_changed");
    for (const expected of first.inputs) {
      const actual = expected.path.startsWith("scripts/gstack/")
        ? { path: expected.path, ...await readGstackClosureFileRecord(join(scripts, expected.path.slice(15))) }
        : expected.path === "packages/core/src/bundled-skill-browser.ts"
          ? { path: expected.path, ...await readGstackClosureFileRecord(resolve(scripts, "../..", expected.path)) }
          : await input(expected.path);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("build_inputs_changed");
    }
    if (packaged && JSON.stringify(await readPackagedBrowseBuildPins(launchSelection, source.checksum)) !== JSON.stringify(launchPins)) fail("build_inputs_changed");
    if ((await readGstackClosureFileRecord(manifestFile)).checksum !== source.checksum ||
      (await readGstackClosureFileRecord(compilerPath)).checksum !== compiler.checksum ||
      JSON.stringify(await tools()) !== JSON.stringify(toolInputs)) fail("build_inputs_changed");
    const compileScratchPeakBytes = await resourceTreeBytes(work);
    if (compileScratchPeakBytes > 256 * 1024 ** 2) fail("compile_scratch_budget_exceeded");
    await rm(first.directory, { recursive: true });
    const report = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
      compiledArtifactBinding: "repeated-native-compilation-and-emitted-byte-identity", upstreamRevision: manifest.upstream.revision,
      sourceManifestChecksum: source.checksum, compiler, target, toolInputs, recipe,
      inputGraphChecksum: checksum(inputBytes), inputs: first.inputs, artifact: second.artifact, compileScratchPeakBytes,
      ...(packaged ? { launchPins, serverReceiptChecksum: packagedServer.expectedReceiptChecksum,
        launchPolicy: "packaged-node-and-admitted-node-server-only" } : {}),
      pendingGates: ["cso-native-lineage", "dynamic-runtime-resources", "licenses-browser-platform-client-acceptance"] };
    await outputDirectory(output, path, true);
    await link(second.binary, join(output, path));
    owned.push(join(output, path));
    const handle = await open(join(output, reportPath), "wx", 0o600);
    owned.push(join(output, reportPath));
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); }
    finally { await handle.close(); }
    if ((await readGstackClosureFileRecord(join(output, path))).checksum !== second.artifact.checksum) fail("emitted_output_changed");
    return report;
  } catch (error) { for (const file of owned) await rm(file); throw error; }
  finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, rootArgument, outputArgument, ...extra] = process.argv.slice(2);
  if (!rootArgument || extra.length) throw new Error("Usage: build-bun-native-resource.mjs <kind> <runtime-root> [output-root]");
  const root = resolve(rootArgument), manifests = [];
  for (const name of ["manifest.json", "source-manifest.json"]) if (await exists(join(dirname(root), name))) manifests.push(join(dirname(root), name));
  if (manifests.length !== 1) fail("source_manifest_ambiguous");
  const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url)));
  const bunPath = await realpath(process.execPath);
  const report = await buildGstackBunNativeResource({ kind, runtimeRoot: root, outputRoot: outputArgument ? resolve(outputArgument) : root,
    sourceManifestPath: manifests[0], expectedSourceManifestChecksum: reviewed.manifestChecksum,
    bunPath, expectedCompilerChecksum: (await readGstackClosureFileRecord(bunPath)).checksum,
    ...(kind === "packaged-browse" ? { packagedServer: { root: outputArgument ? resolve(outputArgument) : root,
      expectedReceiptChecksum: (await readGstackClosureFileRecord(join(outputArgument ? resolve(outputArgument) : root,
        "browse/dist/node-server-build-provenance.json"))).checksum } } : {}) });
  console.log(`built ${kind} with ${report.inputs.length} bound inputs and repeated byte-identical native compilation`);
}
