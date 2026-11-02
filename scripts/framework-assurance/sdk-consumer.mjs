import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { prepareOutputDir } from "./output.mjs";

export const SDK_PACKAGES = Object.freeze([
  "@ling-stack/localization",
  "@ling-stack/contracts",
  "@ling-stack/plugin-sdk",
  "@ling-stack/api-client",
]);
const fixtureRelative = "fixtures/framework-assurance/sdk-consumer";
const lockNames = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"];
const maxCommandOutput = 8 * 1024 * 1024;
const lifecycleHooks = ["prepack", "prepare", "postpack", "prepublish", "prepublishOnly"];
const profiles = ["nodenext", "bundler"];

class ConsumerError extends Error {
  constructor(code, message, status = "failed") {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slash = (value) => value.split(path.sep).join("/");

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function fail(code, message, status) {
  throw new ConsumerError(code, message, status);
}

function archivePath(value, prefix = "package/") {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.includes("\\") || value.includes("\0")) {
    fail("archive_path_invalid", `Unsafe archive path: ${String(value)}`);
  }
  const relative = value.slice(prefix.length).replace(/\/$/, "");
  if (relative.split("/").some((part) => part === "." || part === ".." || part === "" || part.includes(":"))) {
    fail("archive_path_invalid", `Unsafe archive path: ${value}`);
  }
  return relative;
}

function exportTargets(value, label = "exports") {
  if (value === null) return [];
  if (typeof value === "string") return [{ label, target: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => exportTargets(item, `${label}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => exportTargets(item, `${label}.${key}`));
  }
  fail("exports_invalid", `${label} must contain export targets or conditions.`);
}

function targetPattern(target) {
  if (typeof target !== "string" || !target.startsWith("./") || target.includes("**")) {
    fail("exports_invalid", `Unsupported or unsafe export target: ${String(target)}`);
  }
  const relative = archivePath(`package/${target.slice(2)}`);
  const pattern = relative.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${pattern}$`);
}

/** Pure archive audit, also used by the small unit tests without building packages. */
export function auditSdkArchiveEntries(entries, manifest, expected, closure) {
  if (!manifest || manifest.name !== expected.name || manifest.version !== expected.version || manifest.type !== "module") {
    fail("archive_identity_mismatch", `Archive identity does not match ${expected.name}@${expected.version} (ESM).`);
  }
  const files = new Map();
  const seen = new Set();
  for (const entry of entries) {
    if ((entry.path === "package/" || entry.path === "package") && entry.type === "Directory") continue;
    const relative = archivePath(entry.path);
    if (seen.has(relative)) fail("archive_duplicate", `Duplicate archive entry: ${relative}`);
    seen.add(relative);
    if (entry.type !== "File" && entry.type !== "Directory") {
      fail("archive_link_or_special", `Archive links and special entries are not allowed: ${relative}`);
    }
    if (entry.type === "File") files.set(relative, entry);
  }
  if (!files.has("package.json")) fail("archive_manifest_missing", "Archive package.json is missing.");
  const targets = [
    ...exportTargets(manifest.exports),
    ...["main", "types"].filter((key) => manifest[key] !== undefined).map((key) => ({ label: key, target: manifest[key] })),
  ];
  if (!targets.some(({ label }) => label.startsWith("exports"))) fail("exports_invalid", "Public exports are required.");
  const exports = targets.map(({ label, target }) => {
    const pattern = targetPattern(target);
    const matches = [...files.keys()].filter((file) => pattern.test(file)).sort();
    if (matches.length === 0) fail("export_file_missing", `${manifest.name}: ${label} target ${target} is absent from the real tarball.`);
    return { label, target, files: matches };
  });
  const dependencies = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
      if (typeof specifier !== "string" || /^(?:workspace:|link:|file:|https?:|git|\/|\.\.?[/\\])/.test(specifier)) {
        fail("dependency_not_portable", `${manifest.name}: non-portable ${field} entry for ${name}.`);
      }
      const dependency = closure.find((item) => item.name === name);
      if (!dependency) fail("dependency_closure_missing", `${manifest.name}: ${name} is not in the offline tarball closure.`);
      if (dependency.version !== specifier) {
        fail("dependency_version_unverified", `${manifest.name}: expected exact local ${name}@${dependency.version}, found ${specifier}.`);
      }
      dependencies.push({ field, name, version: dependency.version, specifier });
    }
  }
  return { exports, dependencies, files: [...files.keys()].sort() };
}

export async function inspectSdkTarball(archive, expected, closure, tar) {
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) fail("archive_size_invalid", "Archive must be a regular file of at most 64 MiB.");
  const bytes = await fs.readFile(archive);
  const entries = [];
  let totalSize = 0;
  let manifestBytes;
  let violation;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      totalSize += entry.size;
      if (entries.length >= 20_000 || totalSize > 256 * 1024 * 1024 || entry.size > 64 * 1024 * 1024) {
        violation ??= "Archive expanded-size or entry-count limit exceeded.";
      }
      const record = { path: entry.path, type: entry.type, size: entry.size };
      entries.push(record);
      const hash = createHash("sha256");
      const chunks = [];
      entry.on("data", (chunk) => {
        hash.update(chunk);
        if (entry.path === "package/package.json" && entry.size <= 1024 * 1024) chunks.push(chunk);
      });
      entry.on("end", () => {
        record.sha256 = hash.digest("hex");
        if (entry.path === "package/package.json") manifestBytes = Buffer.concat(chunks);
      });
    },
  });
  if (violation) fail("archive_limit_exceeded", violation);
  if (!manifestBytes?.length) fail("archive_manifest_missing", "Readable archive package.json is required (at most 1 MiB).");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const audit = auditSdkArchiveEntries(entries, manifest, expected, closure);
  if (sha256(await fs.readFile(archive)) !== sha256(bytes)) fail("archive_changed", "Tarball changed while being inspected.");
  return { manifest, ...audit, entries, sha256: sha256(bytes), size: stat.size };
}

/** Allowlist instead of inheriting tokens, Node preload hooks, or npm configuration. */
export function sdkConsumerEnvironment(tempRoot, inherited = process.env) {
  const env = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "WINDIR"]) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  return {
    ...env,
    HOME: path.join(tempRoot, "home"),
    USERPROFILE: path.join(tempRoot, "home"),
    APPDATA: path.join(tempRoot, "home", "appdata"),
    LOCALAPPDATA: path.join(tempRoot, "home", "localappdata"),
    XDG_CONFIG_HOME: path.join(tempRoot, "home", "config"),
    XDG_CACHE_HOME: path.join(tempRoot, "cache"),
    TMPDIR: path.join(tempRoot, "tmp"),
    TMP: path.join(tempRoot, "tmp"),
    TEMP: path.join(tempRoot, "tmp"),
    LING_STACK_HOME: path.join(tempRoot, "unused-ling-home"),
    npm_config_cache: path.join(tempRoot, "npm-cache"),
    npm_config_userconfig: path.join(tempRoot, "empty-user.npmrc"),
    npm_config_globalconfig: path.join(tempRoot, "empty-global.npmrc"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    CI: "1",
    LANG: "C",
    TZ: "UTC",
  };
}

async function fileEvidence(file) {
  const before = await fs.lstat(file);
  if (!before.isFile()) fail("input_not_regular", "Expected a regular file; symlinks are not accepted.");
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    fail("input_changed", "Input changed while being read.");
  }
  return { size: bytes.length, sha256: sha256(bytes) };
}

async function snapshotTree(root, skip = () => false) {
  const files = [];
  async function visit(directory, relative = "") {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("input_not_regular", "Source and toolchain roots must be real directories.");
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip(name, entry)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, name);
      else if (entry.isFile()) files.push({ path: name, ...await fileEvidence(file) });
      else fail("input_not_regular", `Source, installed package, and toolchain links are not allowed: ${name}`);
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: sha256(JSON.stringify(files)), fileCount: files.length, files };
}

async function lockEvidence(repoRoot) {
  const result = {};
  for (const name of lockNames) {
    try { result[name] = (await fileEvidence(path.join(repoRoot, name))).sha256; }
    catch (error) { if (error.code !== "ENOENT") throw error; result[name] = null; }
  }
  return result;
}

async function sourceEvidence(repoRoot, packages) {
  const files = [];
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"]) {
    try { files.push({ path: name, ...await fileEvidence(path.join(repoRoot, name)) }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const pkg of packages) {
    const tree = await snapshotTree(pkg.directory, (relative) => {
      const head = relative.split("/")[0];
      return ["dist", "node_modules", ".git"].includes(head)
        || (pkg.name === "@ling-stack/localization" && (relative === "src/generated" || relative.startsWith("src/generated/")));
    });
    files.push(...tree.files.map((file) => ({ ...file, path: `${pkg.relative}/${file.path}` })));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: sha256(JSON.stringify(files)), fileCount: files.length, files };
}

async function checkDist(pkg) {
  const source = await snapshotTree(path.join(pkg.directory, "src"));
  const dist = await snapshotTree(path.join(pkg.directory, "dist"));
  const expected = source.files.filter((file) => file.path.endsWith(".ts") && !file.path.endsWith(".d.ts"))
    .flatMap((file) => [file.path.slice(0, -3) + ".js", file.path.slice(0, -3) + ".d.ts"]).sort();
  const actual = dist.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("dist_file_set_mismatch", `${pkg.name}: dist is missing outputs or contains stale/unexpected files; rebuild a clean producer output.`);
  }
  return { source, dist };
}

async function copyToolchain(repoRoot, tempRoot) {
  const require = createRequire(path.join(repoRoot, "package.json"));
  let compilerManifest;
  try { compilerManifest = require.resolve("typescript/package.json"); }
  catch { fail("toolchain_missing", "Offline compiler dependency typescript is not prepared.", "blocked"); }
  const compiler = JSON.parse(await fs.readFile(compilerManifest, "utf8"));
  const names = ["typescript", "@types/node"];
  const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
  const queue = names.map((name) => ({ name, from: repoRoot }));
  if (compiler.optionalDependencies?.[platformPackage]) queue.push({ name: platformPackage, from: path.dirname(compilerManifest) });
  const copied = new Map();
  while (queue.length) {
    const { name, from } = queue.shift();
    if (name.startsWith("@ling-stack/")) fail("toolchain_ling_fallback", "Toolchain must not contain Ling packages.");
    const resolver = createRequire(path.join(from, "package.json"));
    let source;
    try { source = path.dirname(resolver.resolve(`${name}/package.json`)); }
    catch { fail("toolchain_missing", `Offline compiler dependency ${name} is not prepared.`, "blocked"); }
    const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
    if (copied.has(name)) {
      if (copied.get(name).version !== manifest.version) fail("toolchain_version_conflict", `Conflicting compiler dependency ${name}.`);
      continue;
    }
    source = await fs.realpath(source);
    const before = await snapshotTree(source, (relative) => relative.split("/")[0] === "node_modules");
    const destination = path.join(tempRoot, "toolchain", "node_modules", name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, filter: (file) => !isWithin(path.join(source, "node_modules"), file) });
    const after = await snapshotTree(destination);
    const sourceAfter = await snapshotTree(source, (relative) => relative.split("/")[0] === "node_modules");
    if (before.sha256 !== after.sha256 || before.sha256 !== sourceAfter.sha256) fail("toolchain_copy_changed", `${name}: isolated compiler copy differs from installed bytes.`);
    copied.set(name, { name, version: manifest.version, sha256: after.sha256, fileCount: after.fileCount });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, from: source });
  }
  return [...copied.values()];
}

async function auditInstalled(consumer, archives) {
  const packages = [];
  for (const archive of archives) {
    const directory = path.join(consumer, "node_modules", archive.manifest.name);
    const tree = await snapshotTree(directory);
    if (!isWithin(consumer, await fs.realpath(directory))) fail("consumer_resolution_escape", "Installed package escapes the external consumer.");
    const expected = archive.entries.filter((entry) => entry.type === "File").map((entry) => ({
      path: entry.path.slice("package/".length), size: entry.size, sha256: entry.sha256,
    })).sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(tree.files) !== JSON.stringify(expected)) fail("installed_bytes_differ", `${archive.manifest.name}: installed files differ from the inspected tarball.`);
    packages.push({ name: archive.manifest.name, realPath: `consumer/node_modules/${archive.manifest.name}`, sha256: tree.sha256, fileCount: tree.fileCount });
  }
  return packages;
}

export function validateTypeResolutionFiles(output, consumer, toolchain) {
  const files = output.trim().split(/\r?\n/).filter(Boolean);
  if (!files.length) fail("type_resolution_empty", "Compiler did not report its input files.");
  const mapped = files.map((file) => {
    const absolute = path.resolve(file);
    if (isWithin(consumer, absolute)) return `consumer/${slash(path.relative(consumer, absolute))}`;
    if (isWithin(toolchain, absolute)) return `toolchain/${slash(path.relative(toolchain, absolute))}`;
    fail("type_resolution_escape", "Compiler resolved a file outside the consumer and isolated toolchain.");
  });
  for (const name of SDK_PACKAGES) {
    if (!mapped.some((file) => file.startsWith(`consumer/node_modules/${name}/`) && file.endsWith(".d.ts"))) {
      fail("type_resolution_missing_package", `Compiler did not consume declarations from ${name}.`);
    }
  }
  if (mapped.some((file) => file.startsWith("consumer/node_modules/@ling-stack/") && file.includes("/src/"))) {
    fail("type_source_fallback", "Compiler consumed Ling source rather than public declarations.");
  }
  return mapped;
}

function redact(text, replacements) {
  let value = String(text);
  for (const [source, replacement] of replacements.filter(([source]) => source).sort((a, b) => b[0].length - a[0].length)) {
    value = value.split(source).join(replacement);
  }
  return value;
}

function commandResult(command, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConsumerError("command_cancelled", "SDK consumer invocation was cancelled."));
      return;
    }
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [] };
    let size = 0;
    let stopped;
    const stop = (reason) => {
      stopped ??= reason;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => stop("command_timeout"), timeoutMs);
    const onAbort = () => stop("command_cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
      size += chunk.length;
      if (size > maxCommandOutput) stop("command_output_limit");
      else chunks[name].push(chunk);
    });
    let launchError;
    child.once("error", (error) => { launchError = new ConsumerError("command_unavailable", `${command}: ${error.code ?? error.message}`, "blocked"); });
    child.once("close", (code, receivedSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (launchError) reject(launchError);
      else resolve({ code, signal: receivedSignal, stopped, stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") });
    });
  });
}

/** Explicit invocation builds and tests trusted packages; importing this module does nothing. */
export async function runSdkConsumer({ repoRoot, outputDir, commandTimeoutMs = 180_000, signal } = {}) {
  if (typeof repoRoot !== "string" || typeof outputDir !== "string") throw new TypeError("repoRoot and outputDir are required paths.");
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 100 || commandTimeoutMs > 900_000) {
    throw new TypeError("commandTimeoutMs must be between 100 and 900000 ms.");
  }
  repoRoot = await fs.realpath(repoRoot);
  const outputRoot = await prepareOutputDir(repoRoot, outputDir);
  const runRoot = await fs.mkdtemp(path.join(outputRoot, "sdk-consumer-"));
  const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ling-sdk-consumer-")));
  const ownership = randomUUID();
  const marker = path.join(tempRoot, ".sdk-consumer-owner");
  await fs.writeFile(marker, ownership, { flag: "wx" });
  const report = {
    schemaVersion: 1, kind: "sdk_consumer", passed: false, status: "blocked",
    evidenceKind: "local_tarball_consumer_mock_transport", startedAt: new Date().toISOString(),
    fixture: null, source: {}, toolchain: { node: process.version, platform: process.platform, arch: process.arch },
    packages: [], checks: [], commands: [],
    matrix: ["esm-runtime", ...profiles].map((id) => ({ id, status: "not_run", passed: false })),
    rootLock: {}, isolation: {},
    limits: { commandTimeoutMs, maxCommandOutputBytes: maxCommandOutput, buildConcurrency: 1, packageCount: SDK_PACKAGES.length },
    limitations: [
      "Client transports are deterministic mocks; no daemon, Runner, GUI, real network reconnect, or authority enforcement was accepted.",
      "Bundler is declaration consumption only, not browser runtime acceptance. CJS, other Node/TypeScript versions and other platforms are not assessed.",
      "npm offline/ignore-scripts and fixed argv constrain tool behavior; this is not an OS network or untrusted-code sandbox.",
      "Package version, plugin interface version, DTO schema and database migration are separate version axes; no public compatibility window is inferred.",
    ],
  };
  const replacements = [[tempRoot, "<temp>"], [runRoot, "<artifacts>"], [repoRoot, "<repo>"], [os.homedir(), "<home>"]];
  let stage = "prepare";
  let beforeLocks;
  const env = sdkConsumerEnvironment(tempRoot);
  const producerEnv = { ...env };
  // Corepack may read its pre-provisioned distribution cache, but must never download.
  producerEnv.COREPACK_HOME = process.env.COREPACK_HOME ?? path.join(os.homedir(), ".cache", "node", "corepack");
  const consumer = path.join(tempRoot, "consumer");
  const toolchain = path.join(tempRoot, "toolchain");
  const check = (id, passed, details = {}) => {
    report.checks.push({ id, passed, ...details });
    if (!passed) fail(id, details.reason ?? `${id} failed.`);
  };
  const checkCancelled = () => {
    if (signal?.aborted) fail("command_cancelled", "SDK consumer invocation was cancelled.");
  };
  async function run(label, command, args, cwd, commandEnv = env, allowFailure = false) {
    checkCancelled();
    const started = Date.now();
    const result = await commandResult(command, args, { cwd, env: commandEnv, timeoutMs: commandTimeoutMs, signal });
    const name = `${String(report.commands.length + 1).padStart(2, "0")}-${label}.log`;
    await fs.writeFile(path.join(runRoot, name), redact(`${result.stdout}\n${result.stderr}`, replacements), { flag: "wx" });
    report.commands.push({ label, command: redact(command, replacements), args: args.map((arg) => redact(arg, replacements)), cwd: redact(cwd, replacements), exitCode: result.code, signal: result.signal, stopped: result.stopped ?? null, durationMs: Date.now() - started, log: name });
    if (result.stopped || (result.code !== 0 && !allowFailure)) {
      fail(result.stopped ?? "command_failed", `${label} failed; see ${name}.`);
    }
    checkCancelled();
    return result;
  }
  try {
    beforeLocks = await lockEvidence(repoRoot);
    report.rootLock.before = beforeLocks;
    checkCancelled();
    if (!beforeLocks["pnpm-lock.yaml"]) fail("lock_missing", "Frozen pnpm-lock.yaml is required.", "blocked");
    check("consumer_outside_repository", !isWithin(repoRoot, tempRoot) && !isWithin(tempRoot, repoRoot));
    for (const directory of ["home", "tmp", "cache", "npm-cache"]) await fs.mkdir(path.join(tempRoot, directory));
    await fs.writeFile(env.npm_config_userconfig, "", { flag: "wx" });
    await fs.writeFile(env.npm_config_globalconfig, "", { flag: "wx" });
    const fixtureRoot = path.join(repoRoot, fixtureRelative);
    report.fixture = { version: 1, ...await snapshotTree(fixtureRoot) };
    await fs.cp(fixtureRoot, consumer, { recursive: true });
    const packages = [];
    for (const name of SDK_PACKAGES) {
      const relative = `packages/${name.slice("@ling-stack/".length)}`;
      const directory = path.join(repoRoot, relative);
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      if (manifest.name !== name || !manifest.version) fail("producer_identity_invalid", `Invalid producer package ${name}.`);
      if (lifecycleHooks.some((hook) => manifest.scripts?.[hook])) fail("pack_lifecycle_present", `${name}: pack lifecycle hooks require an explicitly reviewed producer profile.`, "blocked");
      packages.push({ name, version: manifest.version, relative, directory });
    }
    report.source.commit = (await run("source-commit", "git", ["rev-parse", "HEAD"], repoRoot)).stdout.trim();
    report.source.inputsBefore = await sourceEvidence(repoRoot, packages);
    report.toolchain.npm = (await run("npm-version", "npm", ["--version"], consumer)).stdout.trim();
    report.toolchain.pnpm = (await run("pnpm-version", "corepack", ["pnpm", "--version"], repoRoot, producerEnv)).stdout.trim();
    report.toolchain.packages = await copyToolchain(repoRoot, tempRoot);
    checkCancelled();
    report.toolchain.typescript = report.toolchain.packages.find((pkg) => pkg.name === "typescript").version;
    producerEnv.PATH = [path.join(toolchain, "node_modules", "typescript", "bin"), path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
    const rootManifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    check("pnpm_version_matches_pin", rootManifest.packageManager === `pnpm@${report.toolchain.pnpm}`);
    stage = "build";
    const outputs = [];
    for (const pkg of packages) {
      await run(`build-${pkg.name.split("/")[1]}`, "corepack", ["pnpm", "--filter", pkg.name, "run", "build:ci"], repoRoot, producerEnv);
      const built = await checkDist(pkg);
      outputs.push({ name: pkg.name, dist: built.dist, generatedAndSource: built.source });
    }
    report.source.builtOutputs = outputs;
    const afterBuild = await sourceEvidence(repoRoot, packages);
    check("source_stable_during_build", afterBuild.sha256 === report.source.inputsBefore.sha256);
    report.buildEvidence = { mode: "executed_serially", sourceInputsSha256: afterBuild.sha256, packageCount: outputs.length };
    stage = "pack";
    const require = createRequire(path.join(repoRoot, "package.json"));
    const tar = require("tar");
    const archives = [];
    for (const pkg of packages) {
      const destination = path.join(runRoot, "archives", pkg.name.split("/")[1]);
      await fs.mkdir(destination, { recursive: true });
      await run(`pack-${pkg.name.split("/")[1]}`, "corepack", ["pnpm", "pack", "--json", "--pack-destination", destination], pkg.directory, producerEnv);
      const packed = (await fs.readdir(destination)).filter((name) => name.endsWith(".tgz"));
      if (packed.length !== 1) fail("pack_output_invalid", `${pkg.name}: exactly one real tarball is required.`);
      const archivePath = path.join(destination, packed[0]);
      const archive = await inspectSdkTarball(archivePath, pkg, packages, tar);
      archive.archivePath = archivePath;
      archives.push(archive);
      report.packages.push({ name: pkg.name, version: pkg.version, archive: slash(path.relative(runRoot, archivePath)), sha256: archive.sha256, size: archive.size, exports: archive.exports, dependencies: archive.dependencies, fileCount: archive.files.length });
      const distEntries = archive.entries.filter((entry) => entry.path.startsWith("package/dist/") && entry.type === "File").map((entry) => ({ path: entry.path.slice("package/dist/".length), size: entry.size, sha256: entry.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
      check(`packed_dist_matches_build_${pkg.name.split("/")[1]}`, JSON.stringify(distEntries) === JSON.stringify(outputs.find((output) => output.name === pkg.name).dist.files));
    }
    stage = "install";
    await run("offline-install", "npm", ["install", "--offline", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", ...archives.map((archive) => archive.archivePath)], consumer);
    report.isolation.installedPackages = await auditInstalled(consumer, archives);
    report.isolation = { ...report.isolation, externalConsumer: true, installOffline: true, installLifecycleScripts: false, isolatedNpmCache: true, isolatedToolchain: true, nodePathPresent: false, nodeOptionsPresent: false, sourceFallback: false };
    stage = "runtime";
    const runtime = await run("public-runtime", process.execPath, ["runtime.mjs"], consumer, env, true);
    let runtimeResult;
    try { runtimeResult = JSON.parse(runtime.stdout); }
    catch { fail("runtime_report_invalid", "Consumer runtime did not produce its expected JSON report."); }
    const runtimePassed = runtime.code === 0 && runtimeResult.schemaVersion === 1 && runtimeResult.kind === "sdk_consumer_runtime" && runtimeResult.passed === true;
    Object.assign(report.matrix[0], { status: runtimePassed ? "passed" : "failed", passed: runtimePassed, node: process.version, module: "ESM", transport: "mock", tests: runtimeResult.tests, resolutions: runtimeResult.resolutions });
    const compiler = path.join(toolchain, "node_modules", "typescript", "bin", "tsc");
    const compilerVersion = (await run("compiler-version", process.execPath, [compiler, "--version"], consumer)).stdout.trim();
    check("isolated_compiler_version", compilerVersion === `Version ${report.toolchain.typescript}`);
    stage = "types";
    for (const profile of profiles) {
      const cell = report.matrix.find((item) => item.id === profile);
      const args = [compiler, "--project", `tsconfig.${profile}.json`, "--pretty", "false"];
      const positive = await run(`types-${profile}`, process.execPath, args, consumer, env, true);
      const resolution = await run(`resolution-${profile}`, process.execPath, [...args, "--listFilesOnly"], consumer, env, true);
      let resolvedFiles = [];
      if (resolution.code === 0) resolvedFiles = validateTypeResolutionFiles(resolution.stdout, consumer, toolchain);
      const negative = await run(`negative-${profile}`, process.execPath, [compiler, "--project", `tsconfig.${profile}.negative.json`, "--pretty", "false"], consumer, env, true);
      const diagnostics = `${negative.stdout}\n${negative.stderr}`;
      const codes = [...diagnostics.matchAll(/error TS(\d+):/g)].map((match) => match[1]);
      const negativePassed = negative.code !== 0 && codes.length === 1 && codes[0] === "2741" && diagnostics.includes("resumeCapabilities");
      const passed = positive.code === 0 && resolution.code === 0 && negativePassed;
      Object.assign(cell, { status: passed ? "passed" : "failed", passed, module: profile === "nodenext" ? "NodeNext" : "ESNext", moduleResolution: profile === "nodenext" ? "NodeNext" : "Bundler", typescript: report.toolchain.typescript, strict: true, noEmit: true, skipLibCheck: false, positivePassed: positive.code === 0, requiredFieldNegativePassed: negativePassed, resolutionPassed: resolution.code === 0, resolvedFiles });
    }
    stage = "final-audit";
    check("installed_bytes_unchanged", JSON.stringify(await auditInstalled(consumer, archives)) === JSON.stringify(report.isolation.installedPackages));
    report.source.inputsAfter = await sourceEvidence(repoRoot, packages);
    check("source_inputs_unchanged", report.source.inputsAfter.sha256 === report.source.inputsBefore.sha256);
    const commitAfter = (await run("source-commit-after", "git", ["rev-parse", "HEAD"], repoRoot)).stdout.trim();
    check("source_commit_unchanged", commitAfter === report.source.commit);
    const fixtureAfter = await snapshotTree(fixtureRoot);
    check("fixture_unchanged", fixtureAfter.sha256 === report.fixture.sha256);
    for (const archive of archives) check(`archive_unchanged_${archive.manifest.name.split("/")[1]}`, (await fileEvidence(archive.archivePath)).sha256 === archive.sha256);
    for (const cell of report.matrix) {
      cell.environment = { node: process.version, npm: report.toolchain.npm, pnpm: report.toolchain.pnpm, typescript: report.toolchain.typescript, platform: process.platform, arch: process.arch };
      cell.packages = report.packages.map(({ name, version, sha256 }) => ({ name, version, sha256 }));
      cell.fixtureSha256 = report.fixture.sha256;
    }
    report.passed = report.matrix.every((cell) => cell.passed);
    report.status = report.passed ? "passed" : "failed";
  } catch (error) {
    report.status = error.status ?? "failed";
    report.error = { stage, code: error.code ?? "sdk_consumer_failed", message: redact(error.message, replacements) };
  } finally {
    try {
      report.rootLock.after = await lockEvidence(repoRoot);
      report.rootLock.unchanged = !!beforeLocks && JSON.stringify(beforeLocks) === JSON.stringify(report.rootLock.after);
      report.checks.push({ id: "root_locks_unchanged", passed: report.rootLock.unchanged });
      if (!report.rootLock.unchanged) { report.passed = false; report.status = "failed"; }
    } catch (error) {
      report.passed = false; report.status = "failed";
      report.rootLock.error = redact(error.message, replacements);
    }
    try {
      const own = await fs.readFile(marker, "utf8");
      const real = await fs.realpath(tempRoot);
      if (own !== ownership || real !== tempRoot || !path.basename(tempRoot).startsWith("ling-sdk-consumer-")) fail("cleanup_ownership_lost", "Temporary directory ownership could not be verified.");
      await fs.rm(tempRoot, { recursive: true });
      report.isolation.ownedTemporaryDirectoryRemoved = true;
    } catch (error) {
      report.passed = false; report.status = "failed";
      report.isolation.cleanupError = redact(error.message, replacements);
    }
    if (signal?.aborted) {
      report.passed = false; report.status = "failed";
      report.error ??= { stage, code: "command_cancelled", message: "SDK consumer invocation was cancelled." };
      report.cancellation = { signal: ["SIGINT", "SIGTERM"].includes(signal.reason) ? signal.reason : null };
    }
    report.finishedAt = new Date().toISOString();
  }
  const reportPath = path.join(runRoot, "sdk-consumer-report.json");
  const clean = JSON.parse(redact(JSON.stringify(report), replacements));
  await fs.writeFile(reportPath, JSON.stringify(clean, null, 2) + "\n", { flag: "wx" });
  return { ...clean, reportPath };
}

