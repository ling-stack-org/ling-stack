import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGstackNativeRuntime } from "./build-native-runtime.mjs";
import { prepareGstackPlatformResourceStage } from "./prepare-platform-resource-stage.mjs";
import { managedResourceWrite, resourceCheckpoint } from "./resource-workspace.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const reviewUrl = new URL("./reviewed-upstream-self-test-packages.json", import.meta.url);
const compilerUrl = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip";
const maximumArchiveBytes = 64 * 1024 ** 2;
const exists = path => lstat(path).then(() => true, error => { if (error.code !== "ENOENT") throw error; return false; });

// Restore the reviewed compiler in lease scratch, not the user's global Bun.
// The archive is transport only: no downloaded binary runs before the existing
// detached compiler SHA is verified. Redirects cannot introduce arbitrary hosts.
export async function downloadReviewedCompiler(destination, request = fetch) {
  let endpoint = new URL(compilerUrl), response;
  const signal = AbortSignal.timeout(180000);
  for (let count = 0; count < 5; count++) {
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.hash
      || !(endpoint.href === compilerUrl || endpoint.hostname === "release-assets.githubusercontent.com"
        && endpoint.pathname.startsWith("/github-production-release-asset/"))) {
      throw new Error("gstack_reviewed_compiler_endpoint_invalid");
    }
    response = await request(endpoint.href, { redirect: "manual", signal, credentials: "omit", headers: { "accept-encoding": "identity" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || count === 4) throw new Error("gstack_reviewed_compiler_redirect_invalid");
    endpoint = new URL(location, endpoint);
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`gstack_reviewed_compiler_http_${response.status}`); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > maximumArchiveBytes)
    || response.headers.get("content-encoding") !== null) {
    await response.body.cancel(); throw new Error("gstack_reviewed_compiler_size_invalid");
  }
  let handle;
  try {
    handle = await open(destination, "wx", 0o600);
    let total = 0;
    for await (const bytes of response.body) {
      total += bytes.length;
      if (total > maximumArchiveBytes) throw new Error("gstack_reviewed_compiler_size_invalid");
      await handle.writeFile(bytes);
    }
    if (!total || length !== null && total !== Number(length)) throw new Error("gstack_reviewed_compiler_size_invalid");
    return total;
  } finally { await handle?.close(); await response.body.cancel().catch(() => {}); }
}

export async function verifyReviewedCompiler(path) {
  const review = JSON.parse(await readFile(reviewUrl));
  const record = await readGstackClosureFileRecord(path, { maximumBytes: 128 * 1024 ** 2 });
  if (record.checksum !== review.compilerChecksum) throw new Error("gstack_reviewed_compiler_checksum_mismatch");
  return record;
}

const toolNames = ["rebuild-reviewed-resource-stage.mjs", "reviewed-upstream-self-test-packages.json", "build-native-runtime.mjs",
  "prepare-platform-resource-stage.mjs", "verify-shared-command-closure.mjs"];
const toolInputs = () => Promise.all(toolNames.map(async path => ({ path,
  ...(await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url)))) })));

export async function rebuildReviewedResourceStage({ sourceBundlePath, outputPath, parserPath, expectedParserChecksum,
  onProgress = () => {} }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("gstack_reviewed_compiler_target_unsupported");
  const output = resolve(outputPath);
  if (await exists(output)) throw new Error("gstack_reviewed_resource_output_exists");
  const lease = await managedResourceWrite(output, { kind: "resource", additionalBytes: 6 * 1024 ** 3 });
  const work = await mkdtemp(join(lease.scratchPath, "reviewed-resource-"));
  try {
    const inputs = await toolInputs(), archive = join(work, "bun.zip"), bun = join(work, "bun");
    onProgress("retrieve fixed Bun 1.4.2 transport; preserve global compiler and existing artifacts");
    await downloadReviewedCompiler(archive);
    const env = { PATH: "/usr/bin:/bin", HOME: join(lease.scratchPath, "home"), TMPDIR: join(lease.scratchPath, "tmp") };
    const members = execFileSync("/usr/bin/unzip", ["-Z1", archive], { env, encoding: "utf8", timeout: 10000, maxBuffer: 4096 }).trim().split("\n");
    if (members.length < 1 || members.length > 2 || new Set(members).size !== members.length
      || !members.includes("bun-darwin-aarch64/bun") || members.some(path => !["bun-darwin-aarch64/", "bun-darwin-aarch64/bun"].includes(path))) {
      throw new Error("gstack_reviewed_compiler_archive_invalid");
    }
    const bytes = execFileSync("/usr/bin/unzip", ["-p", archive, "bun-darwin-aarch64/bun"], { env, timeout: 10000, maxBuffer: 128 * 1024 ** 2 });
    await writeFile(bun, bytes, { flag: "wx", mode: 0o600 });
    const compiler = await verifyReviewedCompiler(bun);
    await chmod(bun, 0o700);
    const version = execFileSync(bun, ["--version"], { env, encoding: "utf8", timeout: 10000 }).trim();
    if (version !== "1.4.2") throw new Error("gstack_reviewed_compiler_version_mismatch");
    const nativeRoot = join(work, "native"), stageRoot = join(work, "resource");
    await buildGstackNativeRuntime({ sourceBundlePath, outputPath: nativeRoot, bunCommand: bun, onProgress });
    const native = await readGstackClosureFileRecord(join(nativeRoot, "native-build.json"));
    await prepareGstackPlatformResourceStage({ nativeCandidatePath: nativeRoot, outputPath: stageRoot,
      expectedNativeBuildChecksum: native.checksum, parserPath, expectedParserChecksum, onProgress });
    if (JSON.stringify(inputs) !== JSON.stringify(await toolInputs())) throw new Error("gstack_reviewed_resource_inputs_changed");
    await verifyReviewedCompiler(bun);
    await resourceCheckpoint(lease.root);
    const stage = await readGstackClosureFileRecord(join(stageRoot, "resource-stage.json"));
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output, { mode: 0o700 });
    try { await rename(stageRoot, output); }
    catch (error) { await rmdir(output).catch(() => {}); throw error; }
    return { schemaVersion: 1, scope: "reviewed-tool-resource-rebuild-not-approval", releaseEligible: false,
      compilerVersion: version, compilerChecksum: compiler.checksum, nativeBuildChecksum: native.checksum,
      resourceStageChecksum: stage.checksum, toolInputs: inputs };
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceBundlePath, outputPath, parserPath, expectedParserChecksum, ...extra] = process.argv.slice(2);
  if (!expectedParserChecksum || extra.length) throw new Error("gstack_reviewed_resource_arguments_invalid");
  console.log(JSON.stringify(await rebuildReviewedResourceStage({ sourceBundlePath, outputPath, parserPath,
    expectedParserChecksum, onProgress: console.error })));
}
