import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

export const PINNED_SHELL_INVENTORY_CHECKSUM = "sha256:658cb78be8d2a973b271390ccce872e4e4cc3d393319775461b998df8e86db77";
const inventoryFile = fileURLToPath(new URL("./pinned-shell-inventory.json", import.meta.url));
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const canonicalPath = path => typeof path === "string" && path.length > 0 && !posix.isAbsolute(path) && !win32.isAbsolute(path) &&
  !/[\\:\0]/.test(path) && !path.split("/").some(part => !part || part === "." || part === "..");
const readFileRecord = (path, options = {}) => readGstackClosureFileRecord(path, { ...options, errorPrefix: "gstack_shell_resource" });
const fail = reason => { throw new Error(`gstack_shell_resource_${reason}`); };
const alias = path => path.normalize("NFKC").toLowerCase();

// The frozen source census includes sourced helpers and migrations without
// shebangs. Parse bytes only; neither this census nor its reviewed edges grants
// runtime, account, deployment, cloud or global-install authority.
export async function verifyGstackShellResourcePrerequisites({ runtimeRoot,
  inventoryPath = inventoryFile, expectedInventoryChecksum,
  expectedSourceManifestChecksum, expectedUpstreamRevision, shellPath, expectedShellChecksum,
  syntaxTimeoutMs = 5_000 }) {
  const inventoryChecksum = expectedInventoryChecksum ?? (inventoryPath === inventoryFile ? PINNED_SHELL_INVENTORY_CHECKSUM : undefined);
  if (![inventoryChecksum, expectedSourceManifestChecksum, expectedShellChecksum].every(validChecksum)) fail("detached_checksums_required");
  if (!/^[a-f0-9]{40}$/.test(expectedUpstreamRevision ?? "")) fail("revision_required");
  if (!Number.isSafeInteger(syntaxTimeoutMs) || syntaxTimeoutMs < 1 || syntaxTimeoutMs > 30_000) fail("timeout_invalid");
  if (typeof shellPath !== "string" || !isAbsolute(shellPath)) fail("interpreter_required");
  const requested = resolve(runtimeRoot), rootStat = await lstat(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("root_invalid");
  const root = await realpath(requested), interpreter = await realpath(shellPath);
  const shell = await readFileRecord(interpreter);
  if (shell.checksum !== expectedShellChecksum) fail("interpreter_mismatch");
  const sourcePath = join(dirname(root), "source-manifest.json");
  const source = await readFileRecord(sourcePath, { retain: true, maximumBytes: 16 * 1024 * 1024 });
  if (source.checksum !== expectedSourceManifestChecksum) fail("source_manifest_mismatch");
  const inventory = await readFileRecord(resolve(inventoryPath), { retain: true, maximumBytes: 2 * 1024 * 1024 });
  if (inventory.checksum !== inventoryChecksum) fail("inventory_mismatch");
  const manifest = JSON.parse(source.bytes.toString("utf8")), census = JSON.parse(inventory.bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.deliveryStage !== "source" || manifest.upstream?.revision !== expectedUpstreamRevision ||
    !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100_000) fail("source_manifest_invalid");
  if (census.schemaVersion !== 1 || census.reviewStatus !== "pinned-source-census" || census.releaseEligible !== false ||
    census.upstreamRevision !== expectedUpstreamRevision || census.sourceManifestChecksum !== source.checksum ||
    !Array.isArray(census.shellPaths) || !census.shellPaths.length || census.shellPaths.length > 10_000 ||
    !Array.isArray(census.reviewedSourceEdges) || census.reviewedSourceEdges.length > 100_000) fail("inventory_identity_invalid");
  const sourceFiles = new Map(), sourceAliases = new Set();
  for (const file of manifest.files) {
    if (!canonicalPath(file.path) || !validChecksum(file.checksum) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
      sourceAliases.has(alias(file.path))) fail("source_manifest_invalid");
    sourceAliases.add(alias(file.path));
    if (file.path.startsWith("runtime/")) sourceFiles.set(file.path.slice(8), file);
  }
  const shellAliases = new Set();
  for (const path of census.shellPaths) {
    if (!canonicalPath(path) || shellAliases.has(alias(path)) || !sourceFiles.has(path)) fail("inventory_path_invalid");
    shellAliases.add(alias(path));
  }
  const edgeAliases = new Set(), shellPaths = new Set(census.shellPaths);
  for (const edge of census.reviewedSourceEdges) {
    if (!Array.isArray(edge) || edge.length !== 2 || edge.some(path => !canonicalPath(path) || !shellPaths.has(path)) ||
      edgeAliases.has(JSON.stringify(edge))) fail("inventory_edge_invalid");
    edgeAliases.add(JSON.stringify(edge));
  }
  const scripts = [], inputs = new Map();
  let retainedBytes = 0;
  for (const path of [...census.shellPaths].sort()) {
    const expected = sourceFiles.get(path);
    retainedBytes += expected.sizeBytes;
    if (retainedBytes > 64 * 1024 * 1024) fail("input_budget_exceeded");
    const actual = await readFileRecord(join(root, path), { retain: true, maximumBytes: 2 * 1024 * 1024 }).catch(error => {
      if (error.code === "ENOENT") fail(`script_missing:${path}`);
      throw error;
    });
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) fail(`source_mismatch:${path}`);
    scripts.push({ path, checksum: actual.checksum, sizeBytes: actual.sizeBytes });
    inputs.set(path, actual.bytes);
  }
  const home = await realpath(await mkdtemp(join(tmpdir(), "ling shell syntax ")));
  try {
    const systemPaths = process.platform === "win32" && process.env.SystemRoot ? [join(process.env.SystemRoot, "System32")] : ["/usr/bin", "/bin"];
    const env = { PATH: [dirname(interpreter), ...systemPaths].join(delimiter), HOME: home, USERPROFILE: home,
      TMPDIR: home, TMP: home, TEMP: home, GSTACK_HOME: home, GSTACK_STATE_ROOT: home, CI: "1" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    for (const script of scripts) {
      const result = spawnSync(interpreter, ["--noprofile", "--norc", "-n"], { cwd: home, env,
        input: inputs.get(script.path), timeout: syntaxTimeoutMs, maxBuffer: 128 * 1024, killSignal: "SIGKILL" });
      if (result.error || result.signal || result.status === null) fail(`parser_failed:${script.path}`);
      if (result.status !== 0) fail(`syntax_invalid:${script.path}`);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
  for (const script of scripts) {
    const actual = await readFileRecord(join(root, script.path));
    if (actual.checksum !== script.checksum || actual.sizeBytes !== script.sizeBytes) fail(`verified_script_changed:${script.path}`);
  }
  for (const [path, expected] of [[sourcePath, source], [resolve(inventoryPath), inventory], [interpreter, shell]]) {
    if ((await readFileRecord(path)).checksum !== expected.checksum) fail("verified_inputs_changed");
  }
  const byPath = new Map(scripts.map(script => [script.path, script]));
  const sourceEdges = census.reviewedSourceEdges.map(([consumerPath, path]) => ({ consumerPath,
    consumerChecksum: byPath.get(consumerPath).checksum, path, checksum: byPath.get(path).checksum,
    sizeBytes: byPath.get(path).sizeBytes })).sort((a, b) => a.consumerPath.localeCompare(b.consumerPath, "en") || a.path.localeCompare(b.path, "en"));
  return { schemaVersion: 1, deliveryStage: "resource-prerequisites", validationMode: "parse-only",
    hostAcceptance: "pending", packageAcceptance: "pending", releaseEligible: false,
    upstreamRevision: expectedUpstreamRevision, sourceManifestChecksum: source.checksum,
    inventoryChecksum: inventory.checksum, interpreterChecksum: shell.checksum,
    buildHost: { platform: process.platform, arch: process.arch }, scripts,
    scriptGraphChecksum: checksum(JSON.stringify(scripts)), sourceEdges, sourceEdgeGraphChecksum: checksum(JSON.stringify(sourceEdges)),
    pendingGates: ["complete-shell-and-dynamic-resource-closure", "runtime-shell-adaptation", "redistribution-review", "native-windows-validation", "real-skill-execution", "installed-client-acceptance"] };
}
