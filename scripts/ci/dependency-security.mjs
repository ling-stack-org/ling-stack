import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensions = [".mjs", ".ts"];
const daemon = {
  directory: "packages/daemon",
  packageName: "@ling-stack/daemon",
  entries: ["test/dependency-security.test"],
};
const groups = [
  {
    directory: "apps/mobile",
    packageName: "@ling-stack/mobile",
    entries: ["test/dependency-security-patches.test", "test/dependency-security-tooling.test"],
  },
  daemon,
  {
    directory: "",
    entries: ["scripts/dependency-security-regressions.test", "scripts/dependency-security-minimatch.test",
      "scripts/dependency-security-glob.test"],
  },
];

export const DEPENDENCY_CHECK_FILES = new Set(groups.flatMap(({ directory, entries }) =>
  entries.flatMap(entry => extensions.map(extension => [directory, entry + extension].filter(Boolean).join("/")))));
export const DAEMON_DEPENDENCY_TEST_FILENAMES = daemon.entries.flatMap(entry =>
  extensions.map(extension => basename(entry) + extension));

/** @param {string} root */
function runDependencyChecks(root) {
  const plan = groups.map(({ directory, entries, packageName }) => ({
    packageName,
    files: entries.map(entry => {
      const candidates = extensions.map(extension => entry + extension);
      const matches = candidates.filter(file => lstatSync(resolve(root, directory, file), { throwIfNoEntry: false })?.isFile());
      if (matches.length !== 1) {
        const path = [directory, entry].filter(Boolean).join("/");
        throw new Error("Expected exactly one .mjs or .ts dependency security test for " + path + ", found " + matches.length);
      }
      return matches[0];
    }),
  }));
  for (const { packageName, files } of plan) {
    const command = packageName ? "corepack" : process.execPath;
    const args = packageName ? ["pnpm", "--filter", packageName, "exec", "node", "--test", ...files] : ["--test", ...files];
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = runDependencyChecks(fileURLToPath(new URL("../../", import.meta.url)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
