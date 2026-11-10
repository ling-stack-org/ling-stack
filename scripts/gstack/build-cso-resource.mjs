import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget, buildEnvironment } from "./build-native-runtime.mjs";
import { compilerInputPath, readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { requireResourceLease, resourceCheckpoint, resourceTreeBytes, within } from "./resource-workspace.mjs";

const validHash = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const fail = reason => { throw new Error(`gstack_cso_${reason}`); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const tooling = ["build-cso-resource.mjs", "cso-build-compiler.mjs", "build-native-runtime.mjs",
  "verify-shared-command-closure.mjs", "resource-workspace.mjs"];
const artifactPaths = ["bin/gstack-cso-core", "bin/gstack-cso-watchdog", "bin/.gstack-cso-generation", "bin/gstack-cso-launcher"];
const reportPath = "bin/cso-build-provenance.json";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Clang's fixed target is "ling"; dependency words use Make's backslash escaping.
export function parseCsoCompilerDependencies(text) {
  if (!text.startsWith("ling:")) fail("dependency_record_invalid");
  const words = [];
  let word = "";
  for (let index = 5; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") {
      if (++index >= text.length) fail("dependency_record_invalid");
      if (text[index] === "\n") continue;
      word += text[index];
    } else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
    } else if (character === "$" || character === "#" || character === ":") fail("dependency_record_invalid");
    else word += character;
  }
  if (word) words.push(word);
  if (!words.length || new Set(words).size !== words.length) fail("dependency_record_invalid");
  return words;
}

export async function buildGstackCsoResource({ runtimeRoot, outputRoot = runtimeRoot, sourceManifestPath,
  expectedSourceManifestChecksum, bunPath, expectedCompilerChecksum }) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) fail("darwin_host_required");
  if (!validHash(expectedSourceManifestChecksum) || !validHash(expectedCompilerChecksum)) fail("detached_inputs_required");
  const lease = await requireResourceLease(), root = resolve(runtimeRoot), output = resolve(outputRoot);
  for (const [path, label] of [[root, "input"], [output, "output"]]) {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) fail(`${label}_root_invalid`);
  }
  if (await realpath(process.cwd()) !== root) fail("build_cwd_required");
  if (root === output) {
    const staging = dirname(dirname(root));
    if (basename(root) !== "runtime" || basename(dirname(root)) !== "candidate" ||
      !basename(staging).startsWith(".gstack-native-stage-")) fail("private_staging_required");
    if (!within(lease.scratchPath, staging) && dirname(staging) !== join(lease.root, "artifacts/native")) fail("output_outside_scratch");
  } else if (!within(lease.scratchPath, output) || within(root, output) || within(output, root)) fail("output_outside_scratch");
  if (await exists(join(output, "bin")) && (!(await lstat(join(output, "bin"))).isDirectory() ||
    await realpath(join(output, "bin")) !== join(output, "bin"))) fail("output_root_invalid");
  for (const path of [...artifactPaths, reportPath]) if (await exists(join(output, path))) fail("output_already_exists");
  await resourceCheckpoint(lease.root, 256 * 1024 ** 2);
  const manifestFile = resolve(sourceManifestPath), source = await readGstackClosureFileRecord(manifestFile, { retain: true, maximumBytes: 16 * 1024 ** 2 });
  if (source.checksum !== expectedSourceManifestChecksum) fail("source_manifest_mismatch");
  const manifest = JSON.parse(source.bytes), sources = new Map();
  if (manifest.schemaVersion !== 1 || manifest.deliveryStage !== "source" || !Array.isArray(manifest.files) ||
    manifest.files.length > 100_000 || !/^[a-f0-9]{40}$/.test(manifest.upstream?.revision ?? "")) fail("source_manifest_invalid");
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || compilerInputPath({ rootPath: root, inputPath: file.path, platform: "darwin" }) !== file.path ||
      !validHash(file.checksum) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || sources.has(file.path.slice(8))) fail("source_manifest_invalid");
    if (file.path.startsWith("runtime/")) sources.set(file.path.slice(8), file);
  }
  const compiler = await realpath(bunPath), compilerRecord = await readGstackClosureFileRecord(compiler);
  if (compilerRecord.checksum !== expectedCompilerChecksum) fail("compiler_mismatch");
  assertNativeTarget(await readFile(compiler), { platform: process.platform, arch: process.arch });
  const toolInputs = await Promise.all(tooling.map(async path => ({ path: `scripts/gstack/${path}`,
    ...await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url))) })));
  const selected = [...sources.keys()].filter(path => path === "VERSION" || path === "scripts/build-cso.sh" ||
    ["package.json", "tsconfig.json", "bunfig.toml"].includes(path) ||
    path.startsWith("lib/") && !path.startsWith("lib/diagram-render/") && /\.(?:ts|js|json|c|h)$/.test(path)).sort();
  if (!["scripts/build-cso.sh", "lib/cso/cli.ts", "lib/cso/watchdog.c", "lib/cso/launcher.c", "lib/cso/publish-lock.c", "VERSION"].every(path => selected.includes(path))) fail("required_source_missing");
  async function sourceInput(path) {
    const actual = await readGstackClosureFileRecord(join(root, path)), expected = sources.get(path);
    if (!expected || expected.checksum !== actual.checksum || expected.sizeBytes !== actual.sizeBytes) fail(`source_input_mismatch:${path}`);
    return { path, ...actual };
  }
  const sourceInputs = await Promise.all(selected.map(sourceInput));
  const sourceBytes = sourceInputs.reduce((total, input) => total + input.sizeBytes, 0);
  if (sourceBytes > 8 * 1024 ** 2) fail("source_mirror_budget_exceeded");
  const work = await mkdtemp(join(lease.scratchPath, "tmp", ".ling-cso-build-")), owned = [];
  try {
    const env = buildEnvironment({ bunPath: compiler, nodePath: process.execPath, home: join(lease.scratchPath, "home"),
      temporary: join(lease.scratchPath, "tmp"), cachePath: join(lease.root, "cache/bun") });
    env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    // Explicit developer tools and SDK selection avoid ambient compiler wrappers.
    const run = (command, args, cwd = work) => execFileSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000,
      maxBuffer: 2 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] });
    const clang = await realpath(run("/usr/bin/xcrun", ["--find", "clang"]).trim());
    const linker = await realpath(run("/usr/bin/xcrun", ["--find", "ld"]).trim());
    const sdk = await realpath(run("/usr/bin/xcrun", ["--show-sdk-path"]).trim());
    env.SDKROOT = sdk;
    const resource = await realpath(run(clang, ["-print-resource-dir"]).trim());
    const nativePaths = new Map([["clang", clang], ["ld", linker], ["bash", "/bin/bash"], ["codesign", "/usr/bin/codesign"],
      ["otool", "/usr/bin/otool"], ["xcrun", "/usr/bin/xcrun"], ["host-runtime", await realpath(process.execPath)],
      ["sdk/SDKSettings.json", join(sdk, "SDKSettings.json")], ["sdk/usr/lib/libSystem.tbd", join(sdk, "usr/lib/libSystem.tbd")]]);
    const nativeTools = await Promise.all([...nativePaths].map(async ([path, actual]) => ({ path,
      ...await readGstackClosureFileRecord(await realpath(actual), { maximumBytes: 512 * 1024 ** 2 }) })));
    const headerPaths = new Map();
    let peakScratchBytes = 0;
    async function pass(name) {
      const directory = join(work, name), records = join(directory, "records"), runtime = join(directory, "runtime");
      await mkdir(records, { recursive: true });
      await mkdir(join(runtime, "bin"), { recursive: true });
      for (const file of sourceInputs) {
        const path = join(runtime, file.path);
        await mkdir(dirname(path), { recursive: true });
        await copyFile(join(root, file.path), path, constants.COPYFILE_EXCL);
        if ((await readGstackClosureFileRecord(path)).checksum !== file.checksum) fail("source_mirror_changed");
      }
      for (const [kind, command] of [["bun", compiler], ["cc", clang]]) {
        const wrapper = join(directory, kind);
        await writeFile(wrapper, `#!/bin/sh\nexec ${[process.execPath, fileURLToPath(new URL("./cso-build-compiler.mjs", import.meta.url)), kind, command, records].map(quote).join(" ")} "$@"\n`, { mode: 0o700, flag: "wx" });
      }
      const passEnv = { ...env, BUN_CMD: join(directory, "bun"), CSO_CC: join(directory, "cc") };
      try { execFileSync("/bin/bash", ["scripts/build-cso.sh"], { cwd: runtime, env: passEnv, encoding: "utf8", timeout: 120_000,
        maxBuffer: 2 * 1024 ** 2, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { fail(`upstream_build_failed:${String(error.stderr ?? error).slice(0, 1600)}`); }
      const invocations = [];
      for (const kind of ["core", "watchdog", "launcher", "publish-lock"]) invocations.push(JSON.parse(await readFile(join(records, `${kind}.json`))));
      const graph = JSON.parse(await readFile(join(records, "core-metafile.json"))), inputs = [];
      if (!graph.inputs || !Object.keys(graph.inputs).length || Object.keys(graph.inputs).length > 100_000) fail("compiler_graph_invalid");
      for (const [path, info] of Object.entries(graph.inputs)) {
        const key = compilerInputPath({ rootPath: runtime, inputPath: resolve(runtime, path) });
        const record = await sourceInput(key);
        if (record.sizeBytes !== info.bytes || (await readGstackClosureFileRecord(join(runtime, key))).checksum !== record.checksum) fail("compiler_graph_invalid");
        inputs.push(record);
      }
      if (!inputs.some(file => file.path === "lib/cso/cli.ts")) fail("entry_not_compiled");
      inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
      const dependencies = new Map();
      for (const kind of ["watchdog", "launcher", "publish-lock"]) {
        const paths = parseCsoCompilerDependencies(await readFile(join(records, `${kind}.d`), "utf8"));
        if (!paths.includes(`lib/cso/${kind}.c`)) fail("c_source_not_compiled");
        for (const path of paths) {
          const actual = await realpath(resolve(runtime, path));
          let key;
          if (within(runtime, actual)) {
            key = relative(runtime, actual);
            const record = await sourceInput(key);
            if ((await readGstackClosureFileRecord(actual)).checksum !== record.checksum) fail("c_source_changed");
          } else if (within(sdk, actual)) key = `sdk/${relative(sdk, actual)}`;
          else if (within(resource, actual)) key = `clang-resource/${relative(resource, actual)}`;
          else fail("unreviewed_c_dependency");
          dependencies.set(key, { path: key, ...await readGstackClosureFileRecord(actual) });
          if (!within(runtime, actual)) headerPaths.set(key, actual);
        }
      }
      const artifacts = [];
      for (const path of artifactPaths) {
        const actual = join(runtime, path), record = await readGstackClosureFileRecord(actual);
        if ((await lstat(actual)).nlink !== 1) fail("artifact_hardlinked");
        const bytes = await readFile(actual);
        if (path !== "bin/.gstack-cso-generation") {
          assertNativeTarget(bytes, { platform: process.platform, arch: process.arch });
          run("/usr/bin/codesign", ["--verify", "--strict", actual]);
          const signature = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", actual], { env, encoding: "utf8", timeout: 10_000 });
          if (signature.status !== 0 || !/Signature=adhoc/.test(signature.stderr) ||
            path.endsWith("launcher") && !/flags=.*runtime/.test(signature.stderr)) fail("signature_policy_invalid");
          if ([root, work].some(value => bytes.includes(Buffer.from(value)))) fail("embedded_build_path");
        }
        artifacts.push({ path, ...record });
      }
      const core = artifacts.find(file => file.path === "bin/gstack-cso-core").checksum.slice(7);
      if (await readFile(join(runtime, "bin/.gstack-cso-generation"), "utf8") !== `${core}\n` ||
        !invocations[2].args.includes(`-DGSTACK_CSO_CORE_SHA256="${core}"`)) fail("generation_binding_invalid");
      const result = await readFile(join(runtime, "bin/.gstack-cso-build-result"), "utf8");
      if (!result.includes("result=ok\nstage=publish\nreason=committed\n")) fail("upstream_publication_incomplete");
      peakScratchBytes = Math.max(peakScratchBytes, await resourceTreeBytes(work));
      await resourceCheckpoint(lease.root);
      return { directory, runtime, inputs, dependencies: [...dependencies.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
        invocations, artifacts, coreChecksum: `sha256:${core}` };
    }
    const first = await pass("first");
    await rm(first.directory, { recursive: true });
    const second = await pass("second");
    for (const field of ["inputs", "dependencies", "invocations", "artifacts"]) if (JSON.stringify(first[field]) !== JSON.stringify(second[field])) fail(`repeated_${field}_changed`);
    for (const expected of sourceInputs) if (JSON.stringify(await sourceInput(expected.path)) !== JSON.stringify(expected)) fail("source_inputs_changed");
    for (const file of second.dependencies) if (headerPaths.has(file.path) &&
      (await readGstackClosureFileRecord(headerPaths.get(file.path))).checksum !== file.checksum) fail("system_headers_changed");
    for (const tool of nativeTools) if ((await readGstackClosureFileRecord(await realpath(nativePaths.get(tool.path)),
      { maximumBytes: 512 * 1024 ** 2 })).checksum !== tool.checksum) fail("native_tools_changed");
    for (const tool of toolInputs) if ((await readGstackClosureFileRecord(resolve(fileURLToPath(new URL("../..", import.meta.url)), tool.path))).checksum !== tool.checksum) fail("tool_inputs_changed");
    if ((await readGstackClosureFileRecord(manifestFile)).checksum !== source.checksum ||
      (await readGstackClosureFileRecord(compiler)).checksum !== compilerRecord.checksum) fail("detached_inputs_changed");
    const report = { schemaVersion: 1, releaseEligible: false, deliveryStage: "compiled-resource-prerequisites",
      compiledArtifactBinding: "repeated-unmodified-upstream-cso-build-and-signed-byte-identity", upstreamRevision: manifest.upstream.revision,
      sourceManifestChecksum: source.checksum, compiler: compilerRecord, target: { platform: process.platform, arch: process.arch },
      toolInputs, nativeTools, sourceInputs, inputs: second.inputs, cDependencies: second.dependencies, invocations: second.invocations,
      artifacts: second.artifacts, coreChecksum: second.coreChecksum, sourceMirrorBytes: sourceBytes,
      upstreamPublication: "native-publisher-lock-and-launcher-last-commit", commandExecution: "upstream-launcher-version-check-only",
      pendingGates: ["windows-cso-lineage", "dynamic-runtime-resources", "licenses-browser-platform-client-acceptance"] };
    await mkdir(join(output, "bin"), { recursive: true });
    let publishedBytes = 0;
    for (const path of artifactPaths) {
      if (await realpath(join(output, "bin")) !== join(output, "bin")) fail("output_root_changed");
      // CSO rejects multiply-linked support files. Exclusive copying preserves nlink=1.
      await copyFile(join(second.runtime, path), join(output, path), constants.COPYFILE_EXCL);
      owned.push(join(output, path));
      if ((await readGstackClosureFileRecord(join(output, path))).checksum !== second.artifacts.find(file => file.path === path).checksum) fail("published_output_changed");
      publishedBytes += second.artifacts.find(file => file.path === path).sizeBytes;
      peakScratchBytes = Math.max(peakScratchBytes, await resourceTreeBytes(work) + publishedBytes);
    }
    peakScratchBytes = Math.max(peakScratchBytes, await resourceTreeBytes(work));
    if (peakScratchBytes > 256 * 1024 ** 2) fail("scratch_budget_exceeded");
    report.compileScratchPeakBytes = peakScratchBytes;
    report.peakAccounting = "owned-compiler-scratch-plus-simultaneously-published-copies";
    const handle = await open(join(output, reportPath), "wx", 0o600);
    owned.push(join(output, reportPath));
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await handle.close(); }
    return report;
  } catch (error) { for (const path of owned.reverse()) await rm(path); throw error; }
  finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, outputRoot, ...extra] = process.argv.slice(2);
  if (!runtimeRoot || extra.length) throw new Error("Usage: build-cso-resource.mjs <runtime-root> [output-root]");
  const root = resolve(runtimeRoot), manifests = [];
  for (const name of ["manifest.json", "source-manifest.json"]) if (await exists(join(dirname(root), name))) manifests.push(join(dirname(root), name));
  if (manifests.length !== 1) fail("source_manifest_ambiguous");
  const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url)));
  const bunPath = await realpath(process.execPath);
  const report = await buildGstackCsoResource({ runtimeRoot: root, outputRoot: outputRoot ? resolve(outputRoot) : root,
    sourceManifestPath: manifests[0], expectedSourceManifestChecksum: reviewed.manifestChecksum, bunPath,
    expectedCompilerChecksum: (await readGstackClosureFileRecord(bunPath)).checksum });
  console.log(`built CSO with ${report.inputs.length} Bun inputs, ${report.cDependencies.length} C dependencies and upstream signing/publication`);
}
