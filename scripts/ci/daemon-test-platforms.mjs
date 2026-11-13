import { readFile } from "node:fs/promises";

/** Every discovered file has one required platform; new files require an explicit assignment. */
export function validateDaemonTestPlatforms(manifest, discovered) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.linux) || !Array.isArray(manifest.darwin)) {
    throw new Error("Invalid daemon test platform manifest");
  }
  const assigned = [...manifest.linux, ...manifest.darwin];
  if (assigned.some(file => typeof file !== "string" || !/^test\/[^/]+\.test\.(?:mjs|ts)$/u.test(file))
    || new Set(assigned).size !== assigned.length
    || JSON.stringify([...assigned].sort()) !== JSON.stringify([...discovered].sort())) {
    throw new Error("daemon_platform_coverage_mismatch: assign every discovered file to exactly one platform");
  }
  return { linux: [...manifest.linux].sort(), darwin: [...manifest.darwin].sort() };
}

export async function loadDaemonTestPlatforms(discovered) {
  const manifest = JSON.parse(await readFile(new URL("./daemon-test-platforms.json", import.meta.url), "utf8"));
  return validateDaemonTestPlatforms(manifest, discovered);
}
