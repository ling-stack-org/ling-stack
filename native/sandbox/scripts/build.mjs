import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
const helperName = "ling-sandbox-runner";
const toolchain = "1.97.1";
const targets = new Set(["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]);
const reviewedLicenses = new Set(["MIT", "MIT OR Apache-2.0", "Unlicense OR MIT", "(MIT OR Apache-2.0) AND Unicode-3.0"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ordered = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const sourceFiles = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "src/protocol.rs", "src/input_read.rs", "scripts/build.mjs", "tests/protocol-smoke.mjs", "tests/input-read-smoke.mjs"];

/** Closed CLI: output must be a fresh directory, never a cleanup/overwrite target. */
export function parseBuildArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--target", "--out"].includes(flag) || values.has(flag) || !value || value.startsWith("--")) {
      throw new Error("invalid_build_arguments");
    }
    values.set(flag, value);
  }
  const target = values.get("--target");
  const output = values.get("--out");
  if (!targets.has(target) || !output || !isAbsolute(output) || output.includes("\0")) {
    throw new Error("invalid_build_arguments");
  }
  return { target, output: resolve(output) };
}

/** Inventory is review evidence, not a vulnerability audit or a binary trust root. */
export function dependencyInventory(metadata) {
  if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.workspace_members) || metadata.workspace_members.length !== 1) {
    throw new Error("unexpected_dependency_closure");
  }
  const local = metadata.packages.filter(item => item.source == null);
  if (local.length !== 1 || local[0].name !== helperName || metadata.workspace_members[0] !== local[0].id) {
    throw new Error("unexpected_dependency_closure");
  }
  const seen = new Set();
  return metadata.packages.filter(item => item.source != null).map(item => {
    if (!/^[a-zA-Z0-9_-]+$/.test(item.name) || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(item.version)
        || item.source !== "registry+https://github.com/rust-lang/crates.io-index" || !reviewedLicenses.has(item.license)) {
      throw new Error("unreviewed_dependency");
    }
    const key = `${item.name}-${item.version}`;
    if (seen.has(key)) throw new Error("duplicate_dependency");
    seen.add(key);
    return { name: item.name, version: item.version, license: item.license, source: item.source };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
}

function writeNew(path, content) {
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
}

function sourceDigests() {
  return Object.fromEntries(sourceFiles.map(path => [path, hash(readFileSync(join(moduleRoot, path)))]));
}

function collectNotices(metadata, output) {
  const entries = dependencyInventory(metadata);
  const noticeRoot = join(output, "licenses");
  mkdirSync(noticeRoot, { mode: 0o700 });
  for (const entry of entries) {
    const pkg = metadata.packages.find(item => item.name === entry.name && item.version === entry.version);
    const root = realpathSync(dirname(pkg.manifest_path));
    const names = ordered(readdirSync(root).filter(name => /^(license|copying|notice|copyright)([.-]|$)/i.test(name)));
    if (names.length === 0 || pkg.license_file) throw new Error("license_text_requires_review");
    const outputRoot = join(noticeRoot, `${entry.name}-${entry.version}`);
    mkdirSync(outputRoot, { mode: 0o700 });
    entry.notices = names.map(name => {
      const source = join(root, name);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("invalid_license_file");
      const bytes = readFileSync(source);
      const path = `licenses/${entry.name}-${entry.version}/${name}`;
      writeNew(join(outputRoot, name), bytes);
      return { path, sha256: hash(bytes) };
    });
  }
  const ownLicense = readFileSync(join(moduleRoot, "../../LICENSE"));
  writeNew(join(noticeRoot, "Ling-LICENSE"), ownLicense);
  return { packages: entries, ling: { path: "licenses/Ling-LICENSE", sha256: hash(ownLicense) } };
}

/** Build only. No setup, signing, application installation, execution grants, or readiness mutation. */
export function buildNativeEvidence({ target, output }) {
  if (!targets.has(target) || !isAbsolute(output)) throw new Error("invalid_build_arguments");
  const localPath = relative(moduleRoot, output);
  if (!localPath || (!localPath.startsWith(`..${sep}`) && localPath !== ".." && !isAbsolute(localPath))) {
    throw new Error("output_must_be_outside_native_source");
  }
  // mkdir is deliberately exclusive and nonrecursive; even an existing empty directory is refused.
  mkdirSync(output, { mode: 0o700 });
  const logs = join(output, "logs");
  mkdirSync(logs, { mode: 0o700 });
  const env = { ...process.env, CARGO_TARGET_DIR: join(output, "build"), CARGO_NET_OFFLINE: "true" };
  // Local environment wrappers/flags must not silently change this package's build identity.
  for (const key of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTC", "RUSTDOCFLAGS"]) delete env[key];
  function run(name, executable, args) {
    const result = spawnSync(executable, args, { cwd: moduleRoot, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    writeNew(join(logs, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
    if (result.error || result.signal || result.status !== 0) throw new Error(`build_step_failed:${name}`);
    return result.stdout;
  }
  // rustup run WITHOUT --install fails if the pinned toolchain is missing. Never bootstrap globally.
  const cargo = (name, args) => run(name, "rustup", ["run", toolchain, "cargo", ...args]);
  const before = sourceDigests();
  const rustc = run("rustc", "rustup", ["run", toolchain, "rustc", "-vV"]);
  const host = /^host: (.+)$/m.exec(rustc)?.[1];
  if (!host || !rustc.startsWith(`rustc ${toolchain} `)) throw new Error("unexpected_toolchain");
  cargo("format", ["fmt", "--", "--check"]);
  const metadata = JSON.parse(cargo("metadata", ["metadata", "--offline", "--locked", "--format-version", "1"]));
  const notices = collectNotices(metadata, output);
  cargo("check", ["check", "--offline", "--locked", "--target", target]);
  if (target === host) cargo("rust-tests", ["test", "--offline", "--locked", "--target", target]);
  cargo("release-build", ["build", "--offline", "--locked", "--release", "--target", target]);
  const filename = target.endsWith("windows-msvc") ? `${helperName}.exe` : helperName;
  const binary = join(env.CARGO_TARGET_DIR, target, "release", filename);
  const binaryStat = lstatSync(binary);
  if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new Error("invalid_built_binary");
  if (target === host) run("process-smoke", process.execPath, [join(moduleRoot, "tests/protocol-smoke.mjs"), binary]);
  if (target === host && target.endsWith("apple-darwin")) run("input-read-smoke", process.execPath, [join(moduleRoot, "tests/input-read-smoke.mjs"), binary]);
  const after = sourceDigests();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source_changed_during_build");
  const bundled = join(output, filename);
  copyFileSync(binary, bundled, constants.COPYFILE_EXCL);
  const manifest = {
    schemaVersion: 1, helperName, helperVersion: metadata.packages.find(item => item.source == null).version,
    protocolVersion: 1, target, host, toolchain, binary: { filename, sha256: hash(readFileSync(bundled)), sizeBytes: lstatSync(bundled).size },
    sourceSha256: before, dependencies: notices,
    verification: { format: "passed", targetCheck: "passed", releaseBuild: "passed", rustTests: target === host ? "passed" : "not_run_cross_target", processHandshake: target === host ? "passed" : "not_run_cross_target", inputCapture: target === host && target.endsWith("apple-darwin") ? "passed" : "not_run_on_target", vulnerabilityAudit: "not_run", distributionSignature: "not_verified" },
    executionSupported: false, enforcementReady: false, capabilities: [],
    trust: "Unauthenticated local build evidence only; linker ad-hoc signatures are not publisher identity. Distribution must authenticate this manifest and binary together.",
  };
  writeNew(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseBuildArguments(process.argv.slice(2));
    const manifest = buildNativeEvidence(options);
    process.stdout.write(`${JSON.stringify({ manifest: join(options.output, "manifest.json"), target: manifest.target, executionSupported: false, enforcementReady: false })}\n`);
  } catch (error) {
    // Native build inputs contain no credentials. Keep unexpected filesystem diagnostics out of UI.
    const code = error instanceof Error && /^[a-z_]+(?::[a-z-]+)?$/.test(error.message) ? error.message : "native_build_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
