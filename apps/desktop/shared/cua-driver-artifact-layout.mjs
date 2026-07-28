/**
 * Stable separation between upstream build identities and Ling package names.
 *
 * Cargo and upstream release archives keep the upstream executable names. The
 * first Ling-owned distribution copy is renamed before hashing, sealing,
 * signing, packaging, or runtime resolution.
 */
export const CUA_DRIVER_ARTIFACT_LAYOUT = Object.freeze({
  darwin: Object.freeze({
    architecture: "arm64",
    packagedExecutableName: "ling-cua-driver",
    packagedExecutableRelativePath: "darwin/ling-cua-driver",
    platformDirectory: "darwin",
    providerSealRelativePath: "darwin/provider-seal.json",
    upstreamExecutableName: "cua-driver",
  }),
  "win32-x64": Object.freeze({
    architecture: "x86_64",
    packagedExecutableName: "ling-cua-driver.exe",
    packagedExecutableRelativePath: "win32-x64/payload/ling-cua-driver.exe",
    platformDirectory: "win32-x64",
    providerSealRelativePath: "win32-x64/payload/provider-seal.json",
    upstreamExecutableName: "cua-driver.exe",
  }),
});

/** @typedef {keyof typeof CUA_DRIVER_ARTIFACT_LAYOUT} CuaDriverArtifactPlatform */

/**
 * @param {unknown} platform
 * @returns {CuaDriverArtifactPlatform}
 */
export function normalizeCuaDriverArtifactPlatform(platform) {
  if (platform !== "darwin" && platform !== "win32-x64") {
    throw new Error(`unsupported_cua_driver_artifact_platform:${String(platform)}`);
  }
  return platform;
}

/**
 * @param {unknown} platform
 * @returns {(typeof CUA_DRIVER_ARTIFACT_LAYOUT)[CuaDriverArtifactPlatform]}
 */
export function cuaDriverArtifactLayoutFor(platform) {
  return CUA_DRIVER_ARTIFACT_LAYOUT[normalizeCuaDriverArtifactPlatform(platform)];
}

/** Runtime Node platform names differ from package platform names. */
export function cuaDriverArtifactPlatformForRuntime(platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32-x64";
  throw new Error(`unsupported_cua_driver_runtime_platform:${String(platform)}`);
}
