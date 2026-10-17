import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBundledSkillSource } from "../../packages/core/dist/bundled-skill-source.js";
import { applyGstackRuntimeSecurityPatches } from "./apply-runtime-security-patches.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";
import { verifyGstackSecuritySidecarRuntime } from "./verify-security-sidecar-runtime.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(scriptRoot, "upstream-lock.json"), "utf8"));
const reviewedSource = JSON.parse(await readFile(join(scriptRoot, "reviewed-source-bundle.json"), "utf8"));
const adaptationFiles = ["upstream-lock.json", "reviewed-source-bundle.json", "render-upstream.ts", "build-source-bundle.mjs", "build-native-runtime.mjs", "build-bun-native-resource.mjs", "build-cso-resource.mjs", "cso-build-compiler.mjs", "build-portable-resources.ts", "build-node-server-resource.mjs", "build-diagram-resource.mjs", "verify-shared-command-closure.mjs", "resource-workspace.mjs", "verify-security-sidecar-runtime.mjs", "security-sidecar-runtime-probe.mjs", "apply-runtime-security-patches.mjs", "patch-image-parsers.mjs", "patch-legacy-url-fallback.mjs", "../../patches/sprintf-js@1.1.3.patch", "../../package.json", "../../pnpm-lock.yaml"];
adaptationFiles.push("build-managed-node-server.mjs", "build-testsavant-component.mjs", "packaged-browse-build.mjs",
  "packaged-browse-launch.mjs", "testsavant-gs-client.mjs", "testsavant-packaged-client.mjs", "testsavant-client.mjs",
  "testsavant-worker.mjs", "testsavant-runtime.mjs", "testsavant-model-pin.json", "testsavant-offline-guard.mjs");
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const nativeEntries = [
  ["find-browse", "browse/dist/find-browse"],
  ["design", "design/dist/design"],
  ["pdf", "make-pdf/dist/pdf"],
  ["global-discover", "bin/gstack-global-discover"],
];

// This builds prerequisites, not a certified Ling host. T4 owns execution adaptation.
export async function buildGstackNativeRuntime({
  sourceBundlePath, outputPath, bunCommand = "bun", nodeCommand = process.execPath,
  target = { platform: process.platform, arch: process.arch }, onProgress = () => {},
}) {
  if (!["darwin", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch) ||
    target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error("gstack_native_build_requires_matching_host");
  }
  const output = resolve(outputPath);
  if (await exists(output)) throw new Error("gstack_native_output_already_exists");
  const source = resolve(sourceBundlePath);
  if (inside(source, output) || inside(output, source)) throw new Error("gstack_native_source_output_overlap");
  if (reviewedSource.upstreamRevision !== lock.revision) throw new Error("gstack_native_source_lock_revision_mismatch");
  const adaptation = Buffer.concat(await Promise.all(adaptationFiles.map((path) => readFile(join(scriptRoot, path)))));
  const verified = await verifyBundledSkillSource({
    rootPath: source, expectedUpstreamRevision: lock.revision, expectedSkillIds: lock.skillIds,
    expectedManifestChecksum: reviewedSource.manifestChecksum, expectedAdaptationRevision: reviewedSource.adaptationRevision,
  });
  if (verified.manifest.deliveryStage !== "source") throw new Error("gstack_native_requires_source_bundle");
  const lease = await managedResourceWrite(output, { kind: "native", additionalBytes: 6 * 1024 ** 3 });
  const bunPath = await commandPath(bunCommand);
  const nodePath = await commandPath(nodeCommand);
  const bunVersion = execFileSync(bunPath, ["--version"], { encoding: "utf8" }).trim();
  if (!versionAtLeast(bunVersion, lock.minimumBunVersion)) throw new Error(`gstack_build_requires_bun_${lock.minimumBunVersion}`);
  const nodeVersion = execFileSync(nodePath, ["--version"], { encoding: "utf8" }).trim();
  if (!versionAtLeast(nodeVersion.replace(/^v/, ""), "22.22.1")) throw new Error("gstack_native_requires_node_22_22_1");
  assertNativeTarget(await readFile(bunPath), target);
  assertNativeTarget(await readFile(nodePath), target);
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), ".gstack-native-stage-"));
  let reserved = false;
  try {
    const candidate = join(stage, "candidate");
    await cp(source, candidate, { recursive: true, errorOnExist: true, force: false });
    await verifyBundledSkillSource({
      rootPath: candidate, expectedUpstreamRevision: lock.revision, expectedSkillIds: lock.skillIds,
      expectedManifestChecksum: verified.manifestChecksum,
    });
    const runtime = join(candidate, "runtime");
    const home = join(stage, "home");
    const temporary = join(lease.scratchPath, "tmp");
    await mkdir(home);
    const env = buildEnvironment({ bunPath, nodePath, home, temporary, cachePath: join(lease.root, "cache/bun") });
    env.LING_GSTACK_RESOURCE_ROOT = lease.root;
    env.LING_GSTACK_RESOURCE_TOKEN = lease.token;
    const run = async (name, command, args, cwd = runtime) => {
      await resourceCheckpoint(lease.root);
      onProgress(name);
      const result = execFileSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 });
      await resourceCheckpoint(lease.root);
      return result;
    };
    const rootLock = await readFile(join(runtime, "bun.lock"));
    await run("install pinned upstream dependencies (lifecycle scripts disabled)", bunPath,
      ["install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile", "--network-concurrency=8"]);
    if (!rootLock.equals(await readFile(join(runtime, "bun.lock")))) throw new Error("gstack_native_lockfile_changed");
    onProgress("apply Ling dependency security backports to isolated installed packages");
    const securityPatches = await applyGstackRuntimeSecurityPatches({ runtimeRoot: runtime, env });
    for (const [from, to] of [
      ["xterm/lib/xterm.js", "extension/lib/xterm.js"],
      ["xterm/css/xterm.css", "extension/lib/xterm.css"],
      ["xterm-addon-fit/lib/xterm-addon-fit.js", "extension/lib/xterm-addon-fit.js"],
    ]) {
      await mkdir(dirname(join(runtime, to)), { recursive: true });
      await copyFile(join(runtime, "node_modules", from), join(runtime, to));
    }
    const suffix = target.platform === "win32" ? ".exe" : "";
    const outputs = [], provenanceOutputs = [];
    for (const [command, path] of [[bunPath, `tools/bun${suffix}`], [nodePath, `tools/node${suffix}`]]) {
      await mkdir(dirname(join(runtime, path)), { recursive: true });
      await copyFile(command, join(runtime, path));
      await verifyNativeFile(join(runtime, path), target);
      outputs.push(path);
    }
    await run("build admitted Node browser server and production TestSavant worker", bunPath,
      ["--no-env-file", "--no-install", join(scriptRoot, "build-portable-resources.ts"), "node-server", runtime]);
    await run("compile browser CLI with pinned packaged Node/server launch", bunPath,
      ["--no-env-file", "--no-install", join(scriptRoot, "build-bun-native-resource.mjs"), "packaged-browse", runtime]);
    await verifyNativeFile(join(runtime, `browse/dist/browse${suffix}`), target);
    outputs.push(`browse/dist/browse${suffix}`);
    provenanceOutputs.push(`browse/dist/browse${suffix}.build-provenance.json`);
    for (const [kind, output] of nativeEntries) {
      const path = `${output}${suffix}`;
      await run(`compile and bind ${output}`, bunPath, ["--no-env-file", "--no-install", join(scriptRoot, "build-bun-native-resource.mjs"), kind, runtime]);
      await verifyNativeFile(join(runtime, path), target);
      outputs.push(path);
      provenanceOutputs.push(`${path}.build-provenance.json`);
    }
    if (target.platform === "darwin") {
      await run("bind unmodified upstream CSO compilation, signing and native publication", bunPath,
        ["--no-env-file", "--no-install", join(scriptRoot, "build-cso-resource.mjs"), runtime]);
      provenanceOutputs.push("bin/cso-build-provenance.json");
    } else await run("build upstream trusted Windows CSO launcher and core (lineage still pending)", "bash", ["scripts/build-cso.sh"]);
    for (const path of ["bin/gstack-cso-core", "bin/gstack-cso-launcher", ...(target.platform === "darwin" ? ["bin/gstack-cso-watchdog"] : [])]) {
      const name = `${path}${suffix}`;
      await verifyNativeFile(join(runtime, name), target);
      outputs.push(name);
    }
    const coreDigest = (await readFile(join(runtime, "bin/.gstack-cso-generation"), "utf8")).trim();
    if (`sha256:${coreDigest}` !== digest(await readFile(join(runtime, `bin/gstack-cso-core${suffix}`)))) {
      throw new Error("gstack_native_cso_generation_mismatch");
    }
    await run("build Node security classifier sidecar without loading its model", bunPath,
      ["--no-env-file", "--no-install", join(scriptRoot, "build-portable-resources.ts"), "security-sidecar", runtime]);
    const diagramRoot = join(runtime, "lib/diagram-render");
    const diagramLock = await readFile(join(diagramRoot, "bun.lock"));
    await run("install pinned offline diagram dependencies", bunPath,
      ["install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile", "--network-concurrency=8"], diagramRoot);
    if (!diagramLock.equals(await readFile(join(diagramRoot, "bun.lock")))) throw new Error("gstack_native_diagram_lockfile_changed");
    // Only retire authenticated upstream dist files in the unpublished candidate.
    // The producer refuses overwrites and this parent owns failure cleanup.
    for (const path of ["lib/diagram-render/dist/diagram-render.html", "lib/diagram-render/dist/BUILD_INFO.json"]) {
      const expected = verified.manifest.files.find(file => file.path === `runtime/${path}`);
      const bytes = await readFile(join(runtime, path));
      if (!expected || bytes.length !== expected.sizeBytes || digest(bytes) !== expected.checksum ||
        await realpath(join(runtime, path)) !== join(runtime, path)) throw new Error("gstack_native_source_diagram_changed");
    }
    for (const name of ["diagram-render.html", "BUILD_INFO.json"]) await rm(join(diagramRoot, "dist", name));
    await run("build portable offline diagram renderer", bunPath, ["--no-env-file", "--no-install", join(scriptRoot, "build-portable-resources.ts"), "diagram", runtime], diagramRoot);
    for (const path of ["browse/dist/.version", "design/dist/.version", "make-pdf/dist/.version"]) {
      await writeFile(join(runtime, path), `${lock.revision}\n`);
    }
    onProgress("verify the packaged Node security dependencies with local native kernels, without model downloads");
    await verifyGstackSecuritySidecarRuntime({ runtimeRoot: runtime, sourceManifestPath: join(candidate, "manifest.json"),
      expectedSourceManifestChecksum: verified.manifestChecksum });
    const components = [];
    for (const path of [...outputs, ...provenanceOutputs, "browse/dist/server-node.mjs", "browse/dist/bun-polyfill.cjs", "browse/dist/node-server-build-provenance.json",
      "browse/dist/testsavant-component.json", "browse/dist/testsavant-sidecar.mjs",
      "browse/dist/security-sidecar.js", "browse/dist/security-sidecar-build-provenance.json",
      "browse/dist/security-sidecar-runtime-verification.json",
      "lib/diagram-render/dist/diagram-render.html", "lib/diagram-render/dist/BUILD_INFO.json", "lib/diagram-render/dist/diagram-build-provenance.json", "bin/.gstack-cso-generation"]) {
      const bytes = await readFile(join(runtime, path));
      if (!bytes.length) throw new Error(`gstack_native_empty_component:${path}`);
      components.push({ path: `runtime/${path}`, checksum: digest(bytes), sizeBytes: bytes.length, native: outputs.includes(path) });
    }
    if (!adaptation.equals(Buffer.concat(await Promise.all(adaptationFiles.map((path) => readFile(join(scriptRoot, path))))))) {
      throw new Error("gstack_native_build_inputs_changed");
    }
    const record = {
      schemaVersion: 1, deliveryStage: "native-dependencies", hostAcceptance: "pending", packageAcceptance: "pending",
      upstreamRevision: lock.revision, upstreamVersion: lock.version, sourceManifestChecksum: verified.manifestChecksum,
      adaptationRevision: `ling-${createHash("sha256").update(adaptation).digest("hex")}`, target, bunVersion, nodeVersion,
      dependencyLockChecksum: digest(rootLock), diagramLockChecksum: digest(diagramLock), securityPatches, components,
    };
    // Retain the source manifest as input evidence; it must not validate the mutated candidate.
    await rename(join(candidate, "manifest.json"), join(candidate, "source-manifest.json"));
    await writeFile(join(candidate, "native-build.json"), `${JSON.stringify(record, null, 2)}\n`);
    await resourceCheckpoint(lease.root);
    await mkdir(output);
    reserved = true;
    await rename(candidate, output);
    reserved = false;
    return record;
  } finally {
    try { if (reserved) await rmdir(output); }
    finally { await rm(stage, { recursive: true, force: true }); }
  }
}

export function assertNativeTarget(bytes, target) {
  if (target.platform === "darwin") {
    const cpu = target.arch === "arm64" ? 0x0100000c : 0x01000007;
    if (bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === cpu) return;
  } else if (target.platform === "win32" && bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(0x3c);
    const cpu = target.arch === "arm64" ? 0xaa64 : 0x8664;
    if (offset >= 64 && offset + 24 <= bytes.length && bytes.readUInt32LE(offset) === 0x00004550 && bytes.readUInt16LE(offset + 4) === cpu) return;
  }
  throw new Error("gstack_native_binary_target_mismatch");
}

async function verifyNativeFile(path, target) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("gstack_native_binary_invalid");
  assertNativeTarget(await readFile(path), target);
  if (target.platform !== "win32") await chmod(path, stat.mode | 0o111);
}

export function buildEnvironment({ bunPath, nodePath, home, temporary, cachePath, inherited = process.env }) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SDKROOT", "DEVELOPER_DIR", "LANG", "LC_ALL"]) {
    if (inherited[key]) env[key] = inherited[key];
  }
  const separator = process.platform === "win32" ? ";" : ":";
  env.PATH = [dirname(bunPath), dirname(nodePath), env.PATH ?? ""].join(separator);
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    BUN_CMD: bunPath, BUN_INSTALL_CACHE_DIR: cachePath ?? join(home, "bun-cache"), GSTACK_HOME: join(home, ".gstack"), CI: "1" };
}

async function commandPath(command) {
  const path = isAbsolute(command) ? command : execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  return realpath(path);
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function inside(root, path) { const value = relative(root, path); return !value || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)); }
function versionAtLeast(actual, minimum) {
  if (!/^\d+\.\d+\.\d+$/.test(actual)) return false;
  const parts = actual.split(".").map(Number);
  const expected = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) { if (parts[index] !== expected[index]) return parts[index] > expected[index]; }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceBundlePath, outputPath, bunCommand] = process.argv.slice(2);
  if (!sourceBundlePath || !outputPath) throw new Error("Usage: build-native-runtime.mjs <verified-source-bundle> <new-output> [bun]");
  const record = await buildGstackNativeRuntime({ sourceBundlePath, outputPath, bunCommand, onProgress: (step) => process.stderr.write(`${step}\n`) });
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}
