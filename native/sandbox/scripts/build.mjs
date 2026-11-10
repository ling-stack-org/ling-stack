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
const sourceFiles = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/main.rs", "src/protocol.rs", "src/input_read.rs", "src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "scripts/build.mjs", "tests/protocol-smoke.mjs", "tests/input-read-smoke.mjs", "tests/codesign-leaf-smoke.mjs", "tests/build-evidence.test.mjs", "src/codesign_faults.rs", "src/codesign_darwin_tests.rs", "src/codesign_capability_tests.rs", "tests/support/codesign-capability-wire.rs", "tests/support/codesign-capability-observer.rs"];

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
  if (target === host && target.endsWith("apple-darwin")) run("codesign-leaf-protocol-smoke", process.execPath, [join(moduleRoot, "tests/codesign-leaf-smoke.mjs"), binary]);
  const after = sourceDigests();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source_changed_during_build");
  const bundled = join(output, filename);
  copyFileSync(binary, bundled, constants.COPYFILE_EXCL);
  const manifest = {
    schemaVersion: 1, helperName, helperVersion: metadata.packages.find(item => item.source == null).version,
    protocolVersion: 1, target, host, toolchain, binary: { filename, sha256: hash(readFileSync(bundled)), sizeBytes: lstatSync(bundled).size },
    sourceSha256: before, dependencies: notices,
    fixedCodesignLeaf: { role: "packaged_codesign_v1", invocation: "--verify-packaged-codesign", protocolVersion: 1,
      supportedTarget: target.endsWith("apple-darwin"),
      parserProtocol: target === host && target.endsWith("apple-darwin") ? "passed" : "not_run_on_target",
      capabilityClosure: "not_verified", hostSourceAuthority: "not_certified",
      sourcePaths: ["src/codesign.rs", "src/codesign_darwin.rs", "src/codesign_mach.rs", "tests/codesign-leaf-smoke.mjs"] },
    verification: { format: "passed", targetCheck: "passed", releaseBuild: "passed", rustTests: target === host ? "passed" : "not_run_cross_target", processHandshake: target === host ? "passed" : "not_run_cross_target", inputCapture: target === host && target.endsWith("apple-darwin") ? "passed" : "not_run_on_target", vulnerabilityAudit: "not_run", distributionSignature: "not_verified" },
    executionSupported: false, enforcementReady: false, capabilities: [],
    trust: "Unauthenticated local build evidence only; linker ad-hoc signatures are not publisher identity. Distribution must authenticate this manifest and binary together.",
  };
  writeNew(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Root-only fixture compilation from a fresh pinned native build; never executes or certifies the observer. */
export function buildCodesignCapabilityObserver({ nativeBuild, output }) {
  if (process.platform !== "darwin" || !isAbsolute(nativeBuild) || !isAbsolute(output)
    || !output.startsWith("/private/tmp/") || resolve(output) !== output
    || realpathSync(dirname(output)) !== dirname(output) || realpathSync(nativeBuild) !== nativeBuild) {
    throw new Error("invalid_capability_observer_build");
  }
  const bytes = readFileSync(join(nativeBuild, "manifest.json"));
  if (bytes.length > 2 * 1024 * 1024) throw new Error("invalid_native_build_manifest");
  const manifest = JSON.parse(bytes.toString("utf8")), before = sourceDigests();
  const target = process.arch === "arm64" ? "aarch64-apple-darwin" : process.arch === "x64" ? "x86_64-apple-darwin" : "";
  if (!target || manifest.target !== target || manifest.host !== target || manifest.toolchain !== toolchain
    || manifest.helperName !== helperName || manifest.verification?.releaseBuild !== "passed"
    || manifest.fixedCodesignLeaf?.parserProtocol !== "passed"
    || JSON.stringify(manifest.sourceSha256) !== JSON.stringify(before)
    || manifest.binary?.filename !== helperName || !/^[a-f0-9]{64}$/.test(manifest.binary.sha256)
    || hash(readFileSync(join(nativeBuild, helperName))) !== manifest.binary.sha256) {
    throw new Error("capability_observer_native_build_changed");
  }
  const deps = join(nativeBuild, "build", target, "debug", "deps");
  const dependencies = Object.fromEntries(["libc", "serde_json"].map(name => {
    const matches = readdirSync(deps).filter(path => new RegExp("^lib" + name + "-[a-f0-9]+\\.rlib$").test(path));
    if (matches.length !== 1) throw new Error("capability_observer_dependency_ambiguous");
    const path = join(deps, matches[0]), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024 * 1024
      || realpathSync(path) !== path) throw new Error("capability_observer_dependency_invalid");
    return [name, { path, sha256: hash(readFileSync(path)) }];
  }));
  mkdirSync(output, { mode: 0o700 }); // Exclusive, nonrecursive, no overwrite or cleanup of an existing directory.
  const observer = join(output, "ling-codesign-capability-observer");
  const env = { ...process.env, CARGO_NET_OFFLINE: "true" };
  for (const key of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTC", "RUSTDOCFLAGS"]) delete env[key];
  const result = spawnSync("rustup", ["run", toolchain, "rustc", "--cfg", "test", "--edition", "2024",
    "--crate-name", "ling_codesign_capability_observer", "--crate-type", "bin", "--target", target,
    join(moduleRoot, "tests/support/codesign-capability-observer.rs"), "-L", "dependency=" + deps,
    "--extern", "libc=" + dependencies.libc.path, "--extern", "serde_json=" + dependencies.serde_json.path,
    "-o", observer], { cwd: moduleRoot, env, encoding: "utf8", timeout: 120000,
    killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  writeNew(join(output, "rustc.log"), String(result.stdout ?? "") + String(result.stderr ?? ""));
  if (result.error || result.signal || result.status !== 0) throw new Error("capability_observer_compile_failed");
  const stat = lstatSync(observer);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(observer) !== observer || stat.size <= 0
    || (stat.mode & 0o111) === 0) throw new Error("capability_observer_binary_invalid");
  if (JSON.stringify(sourceDigests()) !== JSON.stringify(before)
    || !readFileSync(join(nativeBuild, "manifest.json")).equals(bytes)
    || hash(readFileSync(join(nativeBuild, helperName))) !== manifest.binary.sha256
    || Object.values(dependencies).some(value => hash(readFileSync(value.path)) !== value.sha256)) {
    throw new Error("capability_observer_build_inputs_changed");
  }
  const evidence = { schemaVersion: 1, role: "test_only_capability_observer", target, toolchain,
    nativeManifestSha256: hash(bytes), nativeSourceSha256: before, dependencies,
    binary: { path: observer, sha256: hash(readFileSync(observer)), sizeBytes: stat.size },
    actualControls: "not_run", hostCertification: false, descendantDrain: "not_verified" };
  writeNew(join(output, "manifest.json"), JSON.stringify(evidence, null, 2) + "\n");
  return Object.freeze({ observerPath: observer, evidence });
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
