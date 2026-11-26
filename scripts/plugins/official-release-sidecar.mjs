import { readFile, stat } from "node:fs/promises";

/** @param {string} path @param {VerifyOfficialReleaseSidecarInput} expected */
export async function verifyOfficialReleaseSidecar(path, expected) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 64 * 1024) {
    throw new Error(`Invalid release sidecar size for ${expected.artifactId}.`);
  }
  const record = JSON.parse(await readFile(path, "utf8"));
  if (record?.channel !== "stable") {
    throw new Error(`A stable release sidecar is required for ${expected.artifactId}.`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (record[field] !== value) {
      throw new Error(`Release sidecar field ${field} does not match ${expected.artifactId}.`);
    }
  }
}

/**
 * @typedef {object} VerifyOfficialReleaseSidecarInput
 * @property {string} artifactId
 * @property {string} pluginId
 * @property {string} version
 * @property {string} platform
 * @property {string} arch
 * @property {string} url
 * @property {number} sizeBytes
 * @property {string} sha256
 * @property {string} [minLingVersion]
 * @property {string} [maxLingVersion]
 * @property {boolean} [rollbackAllowed]
 */
