import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, posix, resolve, win32 } from "node:path";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const checksumValid = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const canonicalPath = path => typeof path === "string" && path.length > 0 && !posix.isAbsolute(path) && !win32.isAbsolute(path) &&
  !/[\\:\0]/.test(path) && !path.split("/").some(part => !part || part === "." || part === "..");
const dynamicChildEntrypoints = ["scripts/test-paid-shards.ts"];
const roots = ["bin/gstack-model-benchmark", "scripts/ship-measure.ts", ...dynamicChildEntrypoints];
const clientRoots = ["bin/gstack-model-benchmark", "scripts/ship-measure.ts", "bin/gstack-claude-code"];
const buildScopes = [
  { scope: "native-build-imports", target: "bun", roots: ["browse/src/cli.ts", "browse/src/find-browse.ts",
    "design/src/cli.ts", "make-pdf/src/cli.ts", "bin/gstack-global-discover.ts", "lib/cso/cli.ts"] },
  { scope: "node-browser-build-imports", target: "node", roots: ["browse/src/server.ts"],
    external: ["playwright", "playwright-core", "diff", "bun:sqlite", "@ngrok/ngrok", "socks", "sharp"],
    define: { __dirname: "__browseNodeSrcDir", "import.meta.dir": "__browseNodeSrcDir" } },
  { scope: "diagram-build-imports", target: "browser", roots: ["lib/diagram-render/src/entry.ts"],
    define: { __dirname: '"."', "process.env.NODE_ENV": '"production"' } },
  { scope: "security-sidecar-build-imports", target: "node", roots: ["browse/src/security-sidecar-entry.ts"],
    external: ["@huggingface/transformers"] },
];
// Reviewed non-import branches of the pinned ship diagnostic. These edges do
// not claim complete shell closure or authorize a cloud bootstrap to execute.
const dynamicResourceEdges = [
  ["scripts/ship-measure.ts", "bin/gstack-config"],
  ["scripts/lib/paid-plan.ts", "scripts/paid-test-durations.json"],
  ["scripts/test-free-shards.ts", "scripts/free-test-durations.json"],
  ["scripts/ship-measure.ts", "scripts/ubicloud/test-free.sh"],
  ["scripts/ubicloud/test-free.sh", "scripts/ubicloud/ubi-runner.sh"],
  ["scripts/ubicloud/test-free.sh", "scripts/ubicloud/setup-free-suite.sh"],
  ["scripts/ubicloud/setup-free-suite.sh", "browse/scripts/build-node-server.sh"],
];
export const SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER = /[\\/]bin[\\/]gstack-[^\\/.]+$/;

export function compilerInputPath({ rootPath, inputPath, platform = process.platform }) {
  if (typeof inputPath !== "string") throw new Error("gstack_shared_command_graph_path_invalid");
  const paths = platform === "win32" ? win32 : posix;
  let path = paths.isAbsolute(inputPath) ? paths.relative(rootPath, inputPath) : inputPath;
  if (platform === "win32") path = path.replaceAll("\\", "/");
  if (!canonicalPath(path)) throw new Error("gstack_shared_command_graph_path_invalid");
  return path;
}
// The validation lane retains the paid census; it is not a client import root.
const paidGlobs = ["test/skill-llm-eval*.test.ts", "test/skill-e2e-*.test.ts",
  "test/skill-routing-e2e.test.ts", "test/codex-e2e*.test.ts",
  "test/llm-judge-recommendation.test.ts", "test/carve-section-loading*.test.ts"];

async function fileRecord(path, { retain = false, maximumBytes = 256 * 1024 * 1024, errorPrefix = "gstack_shared_command" } = {}) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path || before.size > maximumBytes) {
    throw new Error(`${errorPrefix}_file_invalid`);
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error(`${errorPrefix}_file_changed`);
    const hash = createHash("sha256"), chunks = [], buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error(`${errorPrefix}_file_too_large`);
      hash.update(buffer.subarray(0, bytesRead));
      if (retain) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await file.stat(), current = await lstat(path);
    if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev) {
      throw new Error(`${errorPrefix}_file_changed`);
    }
    return { sizeBytes: total, checksum: `sha256:${hash.digest("hex")}`, ...(retain ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { await file.close(); }
}

export { fileRecord as readGstackClosureFileRecord };

// Compilation resolves imports; it never runs the benchmark, judge or paid tests.
export function verifyGstackSharedCommandClosure(options) {
  return verifyCommandImports(options, "upstream-validation");
}

export function verifyGstackClientCommandImports(options) {
  return verifyCommandImports(options, "client-command-imports");
}

// These are prospective compiler inputs, not proof of existing binary provenance.
export async function verifyGstackBundledBuildImports(options) {
  const reports = [];
  for (const { scope } of buildScopes) reports.push(await verifyCommandImports(options, scope));
  return reports;
}

async function verifyCommandImports({ runtimeRoot, bunPath,
  expectedBunChecksum, expectedSourceManifestChecksum }, dependencyScope) {
  if (!checksumValid(expectedBunChecksum) || !checksumValid(expectedSourceManifestChecksum)) throw new Error("gstack_shared_command_detached_checksums_required");
  const requested = resolve(runtimeRoot), rootStat = await lstat(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("gstack_shared_command_root_invalid");
  const root = await realpath(requested), compiler = await realpath(bunPath);
  const compilerRecord = await fileRecord(compiler);
  if (compilerRecord.checksum !== expectedBunChecksum) throw new Error("gstack_shared_command_bun_mismatch");
  const source = await fileRecord(join(dirname(root), "source-manifest.json"), { retain: true, maximumBytes: 16 * 1024 * 1024 });
  if (source.checksum !== expectedSourceManifestChecksum) throw new Error("gstack_shared_command_source_manifest_mismatch");
  const manifest = JSON.parse(source.bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.deliveryStage !== "source" || !Array.isArray(manifest.files) || manifest.files.length > 100_000) {
    throw new Error("gstack_shared_command_source_manifest_invalid");
  }
  const sourceFiles = new Map();
  for (const file of manifest.files) {
    if (!canonicalPath(file.path) || !checksumValid(file.checksum) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new Error("gstack_shared_command_source_path_invalid");
    }
    if (!file.path.startsWith("runtime/")) continue;
    const path = file.path.slice("runtime/".length);
    if (!canonicalPath(path) || sourceFiles.has(path)) throw new Error("gstack_shared_command_source_path_invalid");
    sourceFiles.set(path, file);
  }
  const paid = [...sourceFiles.keys()].filter(path => paidGlobs.some(glob => posix.matchesGlob(path, glob))).sort();
  const upstreamValidation = dependencyScope === "upstream-validation";
  const buildScope = buildScopes.find(build => build.scope === dependencyScope);
  const verifiedSources = new Map();
  async function verifiedSource(path, missingCode = "gstack_shared_command_dynamic_resource_missing", retain = false) {
    if (!sourceFiles.has(path)) throw new Error(`${missingCode}:${path}`);
    const actual = await fileRecord(join(root, path), { retain }).catch(error => {
      if (error.code === "ENOENT") throw new Error(`${missingCode}:${path}`);
      throw error;
    });
    const expected = sourceFiles.get(path);
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) throw new Error(`gstack_shared_command_source_input_mismatch:${path}`);
    verifiedSources.set(path, actual);
    return actual;
  }
  const bunCommands = [];
  if (dependencyScope === "client-command-imports") {
    // Verify before inspecting the interpreter: changing a shebang must not hide a root.
    for (const path of [...sourceFiles.keys()].filter(path => path.startsWith("bin/")).sort()) {
      const { bytes } = await verifiedSource(path, "gstack_shared_command_entry_missing", true);
      if (/^#![ \t]*(?:\/usr\/bin\/env[ \t]+(?:-S[ \t]+)?bun|\/(?:[^\/ \t\r\n]+\/)*bun)(?:[ \t\r\n]|$)/.test(bytes.toString("utf8"))) bunCommands.push(path);
    }
  }
  const selectedRoots = upstreamValidation ? roots : buildScope?.roots ?? [...new Set([...clientRoots, ...bunCommands])];
  const entrypoints = [...selectedRoots, ...(upstreamValidation ? paid : [])];
  for (const path of entrypoints) {
    if (!sourceFiles.has(path) || !await lstat(join(root, path)).then(stat => stat.isFile() && !stat.isSymbolicLink(), error => {
      if (error.code === "ENOENT") return false; throw error;
    })) throw new Error(`gstack_shared_command_entry_missing:${path}`);
  }
  for (const path of selectedRoots) await verifiedSource(path, "gstack_shared_command_entry_missing");
  const dynamicResources = [];
  for (const [consumerPath, path] of buildScope ? [] : dynamicResourceEdges) {
    const consumer = await verifiedSource(consumerPath), resource = await verifiedSource(path);
    dynamicResources.push({ consumerPath, consumerChecksum: consumer.checksum,
      path, checksum: resource.checksum, sizeBytes: resource.sizeBytes });
  }
  dynamicResources.sort((a, b) => a.path.localeCompare(b.path, "en") || a.consumerPath.localeCompare(b.consumerPath, "en"));
  const home = await realpath(await mkdtemp(join(tmpdir(), "ling shared compiler ")));
  try {
    const extensionlessEntries = entrypoints.filter(path => path.startsWith("bin/") && !posix.extname(path));
    const program = `let report;try{const paths=await import("node:path"),entries=new Set(${JSON.stringify(extensionlessEntries)});
      const r=await Bun.build({entrypoints:${JSON.stringify(entrypoints)},target:${JSON.stringify(buildScope?.target ?? "bun")},write:false,metafile:true,
      external:${JSON.stringify(buildScope?.external ?? [])},define:${JSON.stringify(buildScope?.define ?? {})},
      plugins:[{name:"reviewed-extensionless-typescript",setup(b){b.onLoad({filter:${SHARED_COMMAND_TYPESCRIPT_ENTRY_FILTER}},async a=>{
        if(!entries.has(paths.relative(process.cwd(),a.path).replaceAll("\\\\","/")))return;
        return {contents:await Bun.file(a.path).text(),loader:"ts"};});}}]});
      report={success:r.success,version:Bun.version,logs:r.logs.map(String),
        inputs:r.metafile?Object.entries(r.metafile.inputs).map(([path,info])=>({path,sizeBytes:info.bytes})):[]};
      }catch(error){report={success:false,logs:Array.from(error.errors??[error],String)};}console.log(JSON.stringify(report));`;
    const systemPaths = process.platform === "win32" && process.env.SystemRoot ? [join(process.env.SystemRoot, "System32")] : ["/usr/bin", "/bin"];
    const env = { PATH: [dirname(compiler), ...systemPaths].join(delimiter), HOME: home, USERPROFILE: home,
      TMPDIR: home, TMP: home, TEMP: home, GSTACK_HOME: home, GSTACK_STATE_ROOT: home,
      BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"), CI: "1" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const result = spawnSync(compiler, ["--no-env-file", "--no-install", "-e", program], {
      cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL",
    });
    if (result.error || result.signal || result.status !== 0) throw new Error(`gstack_shared_command_compiler_failed:${result.error?.code ?? result.signal ?? result.status}`);
    const build = JSON.parse(result.stdout);
    if (!build.success) throw new Error(`gstack_shared_command_build_failed:${build.logs.join("\n").slice(0, 2000)}`);
    if (!Array.isArray(build.inputs) || !build.inputs.length || build.inputs.length > 100_000) throw new Error("gstack_shared_command_graph_invalid");
    const inputs = [], paths = new Set();
    for (const input of build.inputs) {
      const path = compilerInputPath({ rootPath: root, inputPath: input.path });
      if (!canonicalPath(path) || paths.has(path)) throw new Error("gstack_shared_command_graph_path_invalid");
      paths.add(path);
      const actual = await fileRecord(join(root, path));
      if (actual.sizeBytes !== input.sizeBytes) throw new Error(`gstack_shared_command_graph_input_changed:${path}`);
      const expected = sourceFiles.get(path);
      if (expected && (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes)) throw new Error(`gstack_shared_command_source_input_mismatch:${path}`);
      if (!expected && !path.startsWith("node_modules/") && !(buildScope?.target === "browser" && path.startsWith("lib/diagram-render/node_modules/"))) {
        throw new Error(`gstack_shared_command_graph_input_unlisted:${path}`);
      }
      inputs.push({ path, sizeBytes: actual.sizeBytes, checksum: actual.checksum });
    }
    for (const path of entrypoints) if (!paths.has(path)) throw new Error(`gstack_shared_command_entry_not_compiled:${path}`);
    inputs.sort((a, b) => a.path.localeCompare(b.path, "en"));
    for (const [path, expected] of verifiedSources) {
      const actual = await fileRecord(join(root, path));
      if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) throw new Error(`gstack_shared_command_verified_resource_changed:${path}`);
    }
    if ((await fileRecord(compiler)).checksum !== compilerRecord.checksum ||
      (await fileRecord(join(dirname(root), "source-manifest.json"))).checksum !== source.checksum) throw new Error("gstack_shared_command_verified_inputs_changed");
    return { schemaVersion: 1, deliveryStage: "resource-prerequisites", hostAcceptance: "pending", packageAcceptance: "pending",
      releaseEligible: false, dependencyScope, runtimeResourceSelection: "pending", upstreamRevision: manifest.upstream?.revision,
      compilationTarget: buildScope?.target ?? "bun", externalSpecifiers: buildScope?.external ?? [],
      ...(buildScope ? { compiledArtifactBinding: "pending" } : {}),
      ...(dependencyScope === "client-command-imports" ? { bunCommandCount: bunCommands.length,
        entrypointSelection: "all-source-manifest-bin-bun-commands-plus-client-shared-roots" } : {}),
      sourceManifestChecksum: source.checksum, compilerChecksum: compilerRecord.checksum, compilerVersion: build.version,
      entrypoints, dynamicChildEntrypoints: upstreamValidation ? dynamicChildEntrypoints : [],
      dynamicPaidEntrypoints: upstreamValidation ? paid.length : 0,
      unselectedSelfTestEntrypoints: upstreamValidation ? [] : paid,
      inputs, inputGraphChecksum: checksum(JSON.stringify(inputs)),
      dynamicResources, dynamicResourceGraphChecksum: checksum(JSON.stringify(dynamicResources)),
      pendingGates: [...(buildScope ? ["compiled-output-input-binding"] : []), "complete-client-runtime-resource-selection", "shell-and-dynamic-resource-closure",
        "redistribution-review", "real-skill-execution", "installed-client-acceptance"] };
  } finally { await rm(home, { recursive: true, force: true }); }
}
