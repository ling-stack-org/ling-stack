import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const OFFICE_NATIVE_HEADER_NAMES = Object.freeze([
  "node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h",
]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function requireToolchain(value) {
  if (!value) throw new Error("packaged_office_native_toolchain_invalid");
}
function keys(value, names) {
  requireToolchain(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Reflect.ownKeys(value).sort()) === JSON.stringify([...names].sort()));
}
function bytes(path, maximum) {
  const before = lstatSync(path, { bigint: true });
  requireToolchain(before.isFile() && !before.isSymbolicLink() && realpathSync(path) === path
    && before.size > 0n && before.size <= BigInt(maximum));
  const result = readFileSync(path), after = lstatSync(path, { bigint: true });
  requireToolchain(BigInt(result.length) === before.size && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
  return result;
}
function command(executable, argv, environment) {
  const result = spawnSync(executable, argv, { env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  requireToolchain(!result.error && !result.signal && result.status === 0 && typeof result.stdout === "string");
  return result.stdout.trim();
}
function absolutePath(value) {
  requireToolchain(typeof value === "string" && isAbsolute(value) && !value.includes("\0") && resolve(value) === value);
  return realpathSync(value);
}

/**
 * Read build facts, never approve them. Paths are observations; a committed
 * source review must separately match the exact compiler/SDK/header identities.
 * Paths from xcrun/header environment are untrusted observations, not execution
 * authority. Without a reviewed profile this reads identities only; the version
 * fields stay null. A matching compiler/SDK/header identity is required before
 * the discovered compiler may execute even its --version probe.
 */
export function observeOfficeNativeToolchain({ profiles, headerDigests } = {}) {
  requireToolchain(process.platform === "darwin" && process.arch === "arm64");
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  if (Object.hasOwn(process.env, "DEVELOPER_DIR")) environment.DEVELOPER_DIR = absolutePath(process.env.DEVELOPER_DIR);
  const compilerPath = absolutePath(command("/usr/bin/xcrun", ["--find", "clang++"], environment));
  const sdkRoot = absolutePath(command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], environment));
  const headerRoot = absolutePath(process.env.LING_OFFICE_NODE_HEADERS);
  const sdkBytes = bytes(join(sdkRoot, "SDKSettings.json"), 8 * 1024 * 1024);
  let sdkSettings;
  try { sdkSettings = JSON.parse(sdkBytes.toString("utf8")); }
  catch (cause) { throw new Error("packaged_office_native_toolchain_invalid", { cause }); }
  requireToolchain(typeof sdkSettings.CanonicalName === "string" && /^macosx\d+\.\d+(?:\.\d+)?$/u.test(sdkSettings.CanonicalName)
    && typeof sdkSettings.Version === "string" && /^\d+\.\d+(?:\.\d+)?$/u.test(sdkSettings.Version));
  const compilerSha256 = hash(bytes(compilerPath, 512 * 1024 * 1024));
  const observedHeaders = Object.freeze({ root: headerRoot, sha256: Object.freeze(Object.fromEntries(OFFICE_NATIVE_HEADER_NAMES
    .map(name => [name, hash(bytes(join(headerRoot, name), 8 * 1024 * 1024))]))) });
  const identity = { compilerSha256, sdkCanonicalName: sdkSettings.CanonicalName,
    sdkVersion: sdkSettings.Version, sdkSettingsSha256: hash(sdkBytes) };
  let compilerVersion = null;
  if (profiles !== undefined || headerDigests !== undefined) {
    const candidate = Array.isArray(profiles) && profiles.find(profile => profile && typeof profile === "object"
      && Object.keys(identity).every(key => profile[key] === identity[key]));
    requireToolchain(candidate);
    // Validate the complete policy, all profiles and actual headers before any
    // compiler call. The reviewed first line is only a provisional comparison;
    // the real version is checked again after executing the admitted compiler.
    assertOfficeNativeToolchainProfile(profiles, headerDigests, { headers: observedHeaders,
      profile: { ...identity, compilerVersionFirstLine: candidate.compilerVersionFirstLine } });
    requireToolchain(hash(bytes(compilerPath, 512 * 1024 * 1024)) === compilerSha256);
    compilerVersion = command(compilerPath, ["--version"], environment);
    requireToolchain(compilerVersion.length > 0 && compilerVersion.length <= 4096);
    requireToolchain(hash(bytes(compilerPath, 512 * 1024 * 1024)) === compilerSha256
      && hash(bytes(join(sdkRoot, "SDKSettings.json"), 8 * 1024 * 1024)) === identity.sdkSettingsSha256
      && OFFICE_NATIVE_HEADER_NAMES.every(name => hash(bytes(join(headerRoot, name), 8 * 1024 * 1024)) === observedHeaders.sha256[name]));
  }
  const observation = Object.freeze({
    compiler: Object.freeze({ path: compilerPath, version: compilerVersion, sha256: compilerSha256 }),
    sdk: Object.freeze({ root: sdkRoot, settingsSha256: hash(sdkBytes) }),
    headers: observedHeaders,
    profile: Object.freeze({ compilerVersionFirstLine: compilerVersion?.split(/\r?\n/u)[0] ?? null, ...identity }),
  });
  if (profiles !== undefined || headerDigests !== undefined) assertOfficeNativeToolchainProfile(profiles, headerDigests, observation);
  return observation;
}

/** Exact reviewed tool pair; no first-seen approval, version ranges, or path trust. */
export function assertOfficeNativeToolchainProfile(profiles, headerDigests, observation) {
  requireToolchain(Array.isArray(profiles) && profiles.length > 0 && profiles.length <= 16);
  keys(observation.profile, ["compilerVersionFirstLine", "compilerSha256", "sdkCanonicalName", "sdkVersion", "sdkSettingsSha256"]);
  keys(observation.headers.sha256, OFFICE_NATIVE_HEADER_NAMES);
  const ids = new Set();
  for (const profile of profiles) {
    keys(profile, ["id", "compilerVersionFirstLine", "compilerSha256", "sdkCanonicalName", "sdkVersion", "sdkSettingsSha256"]);
    requireToolchain(typeof profile.id === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(profile.id) && !ids.has(profile.id)
      && typeof profile.compilerVersionFirstLine === "string"
      && /^Apple clang version \d+\.\d+\.\d+ \(clang-[a-zA-Z0-9.]+\)$/u.test(profile.compilerVersionFirstLine)
      && validHash(profile.compilerSha256) && validHash(profile.sdkSettingsSha256)
      && typeof profile.sdkCanonicalName === "string" && /^macosx\d+\.\d+(?:\.\d+)?$/u.test(profile.sdkCanonicalName)
      && typeof profile.sdkVersion === "string" && /^\d+\.\d+(?:\.\d+)?$/u.test(profile.sdkVersion));
    ids.add(profile.id);
  }
  keys(headerDigests, OFFICE_NATIVE_HEADER_NAMES);
  requireToolchain(Object.values(headerDigests).every(validHash)
    && OFFICE_NATIVE_HEADER_NAMES.every(name => observation.headers.sha256[name] === headerDigests[name]));
  const selected = profiles.find(profile => Object.keys(observation.profile).every(key => profile[key] === observation.profile[key]));
  requireToolchain(selected !== undefined);
  return selected.id;
}

// A probe prints observations only. It neither writes the reviewed source row
// nor supplies a receipt accepted by the same-process publication pipeline.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("packaged_office_native_toolchain_arguments_invalid");
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "office_native_toolchain_observation",
    host: { platform: process.platform, architecture: process.arch, node: process.versions.node },
    observation: observeOfficeNativeToolchain(), approval: "not_granted" }, null, 2) + "\n");
}
