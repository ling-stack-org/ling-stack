import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const DOCUMENTATION_ROOT_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
  "WORKFLOW.md",
  "WORKFLOW.example.md",
]);

const MAINTENANCE_CHECK_FILES = new Set([
  "scripts/check-markdown-links.mjs",
  "scripts/check-public-repo-safety.mjs",
  "scripts/check-public-repo-safety.test.mjs",
]);

const FORCE_FULL_PATTERNS = [
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u,
  /^(?:\.github|scripts|patches)(?:\/|$)/u,
  /(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|vite\.config\.[^/]+|webpack\.config\.[^/]+|eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?)$/u,
  /(?:^|\/)(?:Dockerfile|docker-compose[^/]*|Makefile)$/u,
];

const TEST_PATH_PATTERN = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|(?:^|\/)[^/]+\.test\.[^/]+$/u;
const TEST_SUPPORT_PATTERN = /(?:fixture|fixtures|helper|helpers|support|setup|util|utils)/iu;
const SUPPORTED_TEST_PACKAGE_PREFIXES = ["packages/"];
const SUPPORTED_TEST_PACKAGE_DIRECTORIES = new Set(["apps/web", "apps/chrome-extension", "apps/mobile"]);

/**
 * Classify a pull request by the narrowest safe CI scope.
 *
 * The classifier is intentionally conservative: a path that is not recognized
 * as documentation, allowlisted maintenance, or a workspace package escalates
 * to the full CI lane.
 * @param {{files: string[], eventName?: string, forceFull?: boolean, packageEntries?: PackageEntry[]}} input
 * @returns {CiScope}
 */
export function classifyChangedFiles(input) {
  const files = normalizeFiles(input.files);
  const eventName = input.eventName ?? "pull_request";
  const packages = input.packageEntries ?? discoverPackages(repositoryRoot);

  if (eventName !== "pull_request" || input.forceFull || files.length === 0) {
    return buildScope("full", files, packages, "non-PR event or explicit full CI");
  }

  if (files.some((file) => !isMaintenancePath(file) && FORCE_FULL_PATTERNS.some((pattern) => pattern.test(file)))) {
    return buildScope("full", files, packages, "root, workflow, dependency, or build configuration change");
  }

  if (files.every((file) => isDocumentationPath(file) || isMaintenancePath(file))) {
    const reason = files.some(isMaintenancePath)
      ? "documentation and allowlisted maintenance checks only"
      : "documentation and documentation assets only";
    return buildScope("docs", files, packages, reason);
  }

  const changedEntries = new Set();
  const changedTestEntries = new Set();
  const changedSourceEntries = new Set();
  const unresolvedFiles = [];

  for (const file of files) {
    if (isDocumentationPath(file) || isMaintenancePath(file)) continue;
    const entry = findOwningPackage(file, packages);
    if (!entry) {
      unresolvedFiles.push(file);
      continue;
    }
    changedEntries.add(entry.name);
    if (isTestPath(file)) {
      changedTestEntries.add(entry.name);
    } else {
      changedSourceEntries.add(entry.name);
    }
  }

  if (unresolvedFiles.length > 0) {
    return buildScope("full", files, packages, `unrecognized paths: ${unresolvedFiles.join(", ")}`);
  }

  const sourceEntries = [...changedSourceEntries];
  const affectedNames = new Set(changedEntries);
  for (const name of sourceEntries) collectDependents(name, packages, affectedNames);

  const testSupportImporters = findChangedTestSupportImporters({
    files,
    packages,
  });
  for (const name of testSupportImporters) affectedNames.add(name);

  const affectedEntries = packages.filter((entry) => affectedNames.has(entry.name));
  const unsupportedAffected = affectedEntries.filter((entry) => !isSupportedAffectedPackage(entry));
  if (unsupportedAffected.length > 0) {
    return buildScope("full", files, packages, `platform package requires the full supported CI lane: ${unsupportedAffected.map((entry) => entry.name).join(", ")}`);
  }

  const testPackages = affectedEntries
    .filter((entry) => entry.hasTestScript && isSupportedTestPackage(entry.directory))
    .map((entry) => entry.name)
    .sort();
  const typecheckPackages = affectedEntries
    .filter((entry) => entry.hasTypecheckScript && isSupportedTypecheckPackage(entry.directory))
    .map((entry) => entry.name)
    .sort();

  return {
    mode: "affected",
    files,
    packages: affectedEntries.map((entry) => entry.name).sort(),
    testPackages,
    typecheckPackages,
    daemon: affectedNames.has("@ling-stack/daemon"),
    web: affectedNames.has("@ling-stack/web"),
    reason: changedSourceEntries.size === 0
      ? "test or test-support changes in affected workspace packages"
      : "workspace source change with transitive consumers",
  };
}

/** @typedef {{name: string, directory: string, dependencies: string[], hasTestScript: boolean, hasTypecheckScript: boolean}} PackageEntry */
/** @typedef {{mode: "docs"|"affected"|"full", files: string[], packages: string[], testPackages: string[], typecheckPackages: string[], daemon: boolean, web: boolean, reason: string}} CiScope */

/** @param {string} value */
function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

/** @param {string[]} files */
function normalizeFiles(files) {
  return [...new Set(files.map(normalizePath).filter(Boolean))].sort();
}

/** @param {string} file */
function isDocumentationPath(file) {
  return file.startsWith("docs/")
    || DOCUMENTATION_ROOT_FILES.has(file)
    || /(?:^|\/)README\.md$/iu.test(file);
}

/** @param {string} file */
function isMaintenancePath(file) {
  return file.startsWith(".github/ISSUE_TEMPLATE/") || MAINTENANCE_CHECK_FILES.has(file);
}

/** @param {string} file */
function isTestPath(file) {
  return TEST_PATH_PATTERN.test(file);
}

/** @param {PackageEntry} entry */
function isSupportedAffectedPackage(entry) {
  return isSupportedTestPackage(entry.directory) || isSupportedTypecheckPackage(entry.directory);
}

/** @param {string} directory */
function isSupportedTestPackage(directory) {
  return SUPPORTED_TEST_PACKAGE_DIRECTORIES.has(directory)
    || SUPPORTED_TEST_PACKAGE_PREFIXES.some((prefix) => directory.startsWith(prefix));
}

/** @param {string} directory */
function isSupportedTypecheckPackage(directory) {
  return directory.startsWith("packages/")
    || SUPPORTED_TEST_PACKAGE_DIRECTORIES.has(directory)
    || directory === "apps/desktop";
}

/** @param {string} file @param {PackageEntry[]} packages */
function findOwningPackage(file, packages) {
  return packages
    .filter((entry) => file === entry.directory || file.startsWith(`${entry.directory}/`))
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}

/** @param {string} name @param {PackageEntry[]} packages @param {Set<string>} affected */
function collectDependents(name, packages, affected) {
  for (const entry of packages) {
    if (affected.has(entry.name) || !entry.dependencies.includes(name)) continue;
    affected.add(entry.name);
    collectDependents(entry.name, packages, affected);
  }
}

/**
 * Test support is a special case because some daemon tests import fixtures from
 * another package's test directory. Resolve relative imports and include the
 * importing package without treating test-only changes as production changes.
 */
function findChangedTestSupportImporters({ files, packages }) {
  const changedSupportFiles = files.filter((file) => isTestPath(file) && TEST_SUPPORT_PATTERN.test(file));
  if (changedSupportFiles.length === 0) return new Set();

  const importers = new Set();
  const trackedFiles = listRepositoryFiles(repositoryRoot);
  for (const candidate of trackedFiles) {
    if (!isTestPath(candidate)) continue;
    const source = readFileIfText(resolve(repositoryRoot, candidate));
    if (source === undefined) continue;
    const owner = findOwningPackage(candidate, packages);
    if (!owner) continue;
    for (const specifier of source.matchAll(/(?:from\s+|import\s*\(|require\s*\()["'](\.[^"']+)["']/gu)) {
      const resolved = normalizePath(relative(repositoryRoot, resolve(dirname(resolve(repositoryRoot, candidate)), specifier[1])));
      if (changedSupportFiles.some((changed) => sameImportTarget(changed, resolved))) {
        importers.add(owner.name);
      }
    }
  }
  return importers;
}

/** @param {string} changed @param {string} imported */
function sameImportTarget(changed, imported) {
  if (changed === imported) return true;
  const withoutExtension = imported.replace(/\.[cm]?[jt]sx?$/u, "");
  const supportedExtensions = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".tsx", ".jsx"];
  return supportedExtensions.some((extension) => changed === `${withoutExtension}${extension}`)
    || supportedExtensions.some((extension) => changed === `${withoutExtension}/index${extension}`);
}

/** @param {string} root @returns {PackageEntry[]} */
function discoverPackages(root) {
  const entries = [];
  for (const workspaceRoot of ["packages", "apps"]) {
    const absoluteRoot = resolve(root, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const directoryName of readdirSync(absoluteRoot)) {
      const directory = `${workspaceRoot}/${directoryName}`;
      const packagePath = resolve(root, directory, "package.json");
      if (!existsSync(packagePath)) continue;
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      const dependencyMap = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      entries.push({
        name: manifest.name,
        directory,
        dependencies: Object.keys(dependencyMap ?? {}),
        hasTestScript: typeof manifest.scripts?.test === "string",
        hasTypecheckScript: typeof manifest.scripts?.typecheck === "string",
      });
    }
  }
  return entries;
}

/** @param {string} root */
function listRepositoryFiles(root) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean).map(normalizePath);
}

/** @param {string} file */
function readFileIfText(file) {
  try {
    const source = readFileSync(file);
    if (source.includes(0)) return undefined;
    return source.toString("utf8");
  } catch {
    return undefined;
  }
}

/** @param {"docs"|"affected"|"full"} mode @param {string[]} files @param {PackageEntry[]} packages @param {string} reason */
function buildScope(mode, files, packages, reason) {
  const names = mode === "full" ? packages.map((entry) => entry.name).sort() : [];
  return {
    mode,
    files,
    packages: names,
    testPackages: mode === "full" ? packages.filter((entry) => entry.hasTestScript && isSupportedTestPackage(entry.directory)).map((entry) => entry.name).sort() : [],
    typecheckPackages: mode === "full" ? packages.filter((entry) => entry.hasTypecheckScript && isSupportedTypecheckPackage(entry.directory)).map((entry) => entry.name).sort() : [],
    daemon: mode === "full" || names.includes("@ling-stack/daemon"),
    web: mode === "full" || names.includes("@ling-stack/web"),
    reason,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    args[key] = inline ?? argv[++index];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = args.event ?? process.env.GITHUB_EVENT_NAME ?? "pull_request";
  let files;
  if (args.files) {
    files = JSON.parse(args.files);
  } else if (eventName === "pull_request" && args.base && args.head) {
    files = execFileSync("git", ["diff", "--name-only", "-z", `${args.base}...${args.head}`], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean);
  } else {
    files = [];
  }
  console.log(JSON.stringify(classifyChangedFiles({ files, eventName, forceFull: args["force-full"] === "true" })));
}
