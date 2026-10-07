import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const inputs = ["src/runtime.h", "src/runtime-internal.h", "src/runtime.cc", "src/publication.cc", "src/addon.cc", "scripts/build.mjs", "tests/primitive.test.mjs",
  "tests/readback.test.mjs", "tests/publication.test.mjs", "tests/test-helpers.mjs", "tests/runtime-lifetime.test.cc", "tests/runtime-budget-injected.test.cc", "tests/runtime-publication.test.cc", "tests/run-isolated.mjs", "README.md"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Explicit build-time only; never downloads headers, installs tools, or edits packaging. */
export function parseBuildArguments(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--out", "--headers", "--compiler"].includes(args[i]) || values.has(args[i])
      || !args[i + 1] || !isAbsolute(args[i + 1]) || args[i + 1].includes("\0")) throw new Error("invalid_build_arguments");
    values.set(args[i], resolve(args[i + 1]));
  }
  if (!values.has("--out") || !values.has("--headers")) throw new Error("invalid_build_arguments");
  return { output: values.get("--out"), headers: values.get("--headers"), compiler: values.get("--compiler") };
}

export function sourceDigests() {
  return Object.fromEntries(inputs.map(path => [path, hash(readFileSync(join(moduleRoot, path)))]));
}

function writeNew(path, bytes) { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }

/** Fresh output directory only: a failed build is preserved, never removed or overwritten. */
export function buildNativeEvidence({ output, headers, compiler }) {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("unsupported_build_host");
  if (!isAbsolute(output) || !isAbsolute(headers)) throw new Error("invalid_build_arguments");
  const local = relative(moduleRoot, output);
  if (!local || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)))
    throw new Error("output_must_be_outside_native_source");
  const headerRoot = realpathSync(headers);
  for (const name of ["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"])
    if (!lstatSync(join(headerRoot, name)).isFile()) throw new Error("local_node_headers_required");
  if (!compiler) {
    const found = spawnSync("/usr/bin/xcrun", ["--find", "clang++"], { encoding: "utf8" });
    if (found.error || found.signal || found.status !== 0 || !isAbsolute(found.stdout.trim())) throw new Error("local_clang_required");
    compiler = found.stdout.trim();
  }
  if (!isAbsolute(compiler)) throw new Error("local_clang_required");
  compiler = realpathSync(compiler);
  if (!lstatSync(compiler).isFile()) throw new Error("local_clang_required");
  const selectedSdk = spawnSync("/usr/bin/xcrun", ["--show-sdk-path"], { encoding: "utf8" });
  if (selectedSdk.error || selectedSdk.status !== 0 || !isAbsolute(selectedSdk.stdout.trim())) throw new Error("local_macos_sdk_required");
  const sdk = realpathSync(selectedSdk.stdout.trim());
  mkdirSync(output, { mode: 0o700 });
  const before = sourceDigests();
  writeNew(join(output, "source.before.sha256.json"), JSON.stringify(before, null, 2) + "\n");
  const binary = join(output, "office-local.node");
  const argv = ["--driver-mode=g++", "-isysroot", sdk, "-std=c++17", "-DNAPI_VERSION=8", "-O2", "-Wall", "-Wextra", "-Werror", "-dynamiclib",
    "-undefined", "dynamic_lookup", "-mmacosx-version-min=13.0", "-arch", process.arch === "x64" ? "x86_64" : "arm64",
    "-I", headerRoot, join(moduleRoot, "src/runtime.cc"), join(moduleRoot, "src/publication.cc"), join(moduleRoot, "src/addon.cc"), "-o", binary];
  // Ambient build flags/loaders must not silently change the identity of this build.
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const build = spawnSync(compiler, argv, { cwd: moduleRoot, env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeNew(join(output, "build.log"), (build.stdout ?? "") + (build.stderr ?? ""));
  writeNew(join(output, "build.command.json"), JSON.stringify({ compiler, argv, environment, status: build.status,
    signal: build.signal ?? null, error: build.error?.message ?? null }, null, 2) + "\n");
  const after = sourceDigests();
  writeNew(join(output, "source.after.sha256.json"), JSON.stringify(after, null, 2) + "\n");
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("source_changed_during_build");
  if (build.error || build.signal || build.status !== 0) throw new Error("native_build_failed");
  const lifetimeBinary = join(output, "office-local-lifetime-test");
  const lifetimeArgv = ["--driver-mode=g++", "-isysroot", sdk, "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
    "-arch", process.arch === "x64" ? "x86_64" : "arm64", join(moduleRoot, "src/runtime.cc"), join(moduleRoot, "src/publication.cc"),
    join(moduleRoot, "tests/runtime-lifetime.test.cc"), "-o", lifetimeBinary];
  const lifetime = spawnSync(compiler, lifetimeArgv, { cwd: moduleRoot, env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeNew(join(output, "lifetime-build.log"), (lifetime.stdout ?? "") + (lifetime.stderr ?? ""));
  writeNew(join(output, "lifetime-build.command.json"), JSON.stringify({ compiler, argv: lifetimeArgv, status: lifetime.status,
    signal: lifetime.signal ?? null, error: lifetime.error?.message ?? null }, null, 2) + "\n");
  if (lifetime.error || lifetime.signal || lifetime.status !== 0) throw new Error("lifetime_test_build_failed");
  const budgetBinary = join(output, "office-local-budget-injected-test");
  const budgetArgv = lifetimeArgv.map(argument => argument === lifetimeBinary ? budgetBinary
    : argument === join(moduleRoot, "tests/runtime-lifetime.test.cc") ? join(moduleRoot, "tests/runtime-budget-injected.test.cc") : argument);
  const budget = spawnSync(compiler, budgetArgv, { cwd: moduleRoot, env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeNew(join(output, "budget-injected-build.log"), (budget.stdout ?? "") + (budget.stderr ?? ""));
  writeNew(join(output, "budget-injected-build.command.json"), JSON.stringify({ compiler, argv: budgetArgv, status: budget.status,
    signal: budget.signal ?? null, error: budget.error?.message ?? null }, null, 2) + "\n");
  if (budget.error || budget.signal || budget.status !== 0) throw new Error("budget_injected_test_build_failed");
  const publicationBinary = join(output, "office-local-publication-test");
  const publicationArgv = lifetimeArgv.filter(argument => argument !== join(moduleRoot, "src/runtime.cc"))
    .map(argument => argument === lifetimeBinary ? publicationBinary
      : argument === join(moduleRoot, "tests/runtime-lifetime.test.cc") ? join(moduleRoot, "tests/runtime-publication.test.cc") : argument);
  const publication = spawnSync(compiler, publicationArgv, { cwd: moduleRoot, env: environment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  writeNew(join(output, "publication-build.log"), (publication.stdout ?? "") + (publication.stderr ?? ""));
  writeNew(join(output, "publication-build.command.json"), JSON.stringify({ compiler, argv: publicationArgv, status: publication.status,
    signal: publication.signal ?? null, error: publication.error?.message ?? null }, null, 2) + "\n");
  if (publication.error || publication.signal || publication.status !== 0) throw new Error("publication_test_build_failed");
  if (JSON.stringify(before) !== JSON.stringify(sourceDigests())) throw new Error("source_changed_during_build");
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8", env: environment });
  if (version.error || version.status !== 0) throw new Error("compiler_identity_unavailable");
  const evidence = { schemaVersion: 2, addon: "office-local", protocolVersion: 2, napiVersion: 8,
    platform: process.platform, architecture: process.arch, nodeVersion: process.version, deploymentTarget: "13.0",
    compiler: { path: compiler, version: version.stdout.trim(), sha256: hash(readFileSync(compiler)) },
    sdk: { root: sdk, settingsSha256: hash(readFileSync(join(sdk, "SDKSettings.json"))) },
    headers: { root: headerRoot, sha256: Object.fromEntries(["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"]
      .map(name => [name, hash(readFileSync(join(headerRoot, name)))])) },
    binary: { path: binary, sha256: hash(readFileSync(binary)), bytes: lstatSync(binary).size }, sourceSha256: before,
    nativeLifetimeTest: { path: lifetimeBinary, sha256: hash(readFileSync(lifetimeBinary)) },
    nativeBudgetInjectedTest: { path: budgetBinary, sha256: hash(readFileSync(budgetBinary)),
      classification: "Test-only injected short-I/O libc wrappers; not actual spontaneous kernel short I/O." },
    nativePublicationTest: { path: publicationBinary, sha256: hash(readFileSync(publicationBinary)),
      classification: "Real kernel FD reuse and deterministic namespace interleaving; explicitly test-only short-I/O/exception injection." },
    verification: { compilation: "passed", isolatedTests: "not_run", electronNapi: "not_run", distributionSignature: "not_verified" },
    scopeBinding: "unbound", protectedStageVerified: false, coreSafe: false, packaged: false,
    trust: "Local build evidence only, not a sandbox manifest, authorization receipt, or publisher identity." };
  writeNew(join(output, "build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(buildNativeEvidence(parseBuildArguments(process.argv.slice(2)))) + "\n"); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
