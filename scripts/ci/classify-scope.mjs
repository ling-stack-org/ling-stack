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

const DEPENDENCY_CHECK_FILES = new Set([
  "packages/daemon/test/dependency-security.test.mjs",
  "apps/mobile/test/dependency-security-patches.test.mjs",
  "apps/mobile/test/dependency-security-tooling.test.mjs",
]);

const FORCE_FULL_PATTERNS = [
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/u,
  /^(?:\.github|scripts|patches)(?:\/|$)/u,
  /^(?:tsconfig(?:\.[^/]+)?\.json|vite\.config\.[^/]+|webpack\.config\.[^/]+|eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?|\.prettierrc(?:\.[^/]+)?)$/u,
  /(?:^|\/)(?:Dockerfile|docker-compose[^/]*|Makefile)$/u,
];

const TEST_PATH_PATTERN = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|(?:^|\/)[^/]+\.test\.[^/]+$/u;
const TEST_SUPPORT_PATTERN = /(?:fixture|fixtures|helper|helpers|support|setup|util|utils)/iu;
const SUPPORTED_TEST_PACKAGE_PREFIXES = ["packages/"];
const SUPPORTED_TEST_PACKAGE_DIRECTORIES = new Set(["apps/web", "apps/chrome-extension", "apps/mobile"]);
// The standalone macOS helper smoke validates the reviewed Seatbelt/native
// helper itself. Keep it for changes that can alter that contract; ordinary
// Daemon changes retain the complete Darwin test suite without consuming an
// additional hosted macOS runner.
const MACOS_NATIVE_PATH_PATTERNS = [
  /^native\/sandbox(?:\/|$)/u,
  /^packages\/daemon\/src\/runtime\/sandbox(?:\/|$)/u,
  /^packages\/daemon\/src\/runtime\/adapters\/native-command-policy\.[^/]+$/u,
  /^packages\/daemon\/src\/features\/runs\/restricted-command-dispatch\.[^/]+$/u,
  /^packages\/daemon\/test\/(?:platform-native-sandbox|macos-native-command|restricted-command-dispatch)\.test\.[^/]+$/u,
  /^packages\/daemon\/test\/restricted-command-launch-unknown\.contract\.mjs$/u,
];
const DAEMON_TEST_ENTRY_PATTERN = /^packages\/daemon\/(test\/[^/]+\.test\.(?:mjs|ts))$/u;
const DAEMON_PLATFORMS = ["linux", "darwin"];
let daemonPlatformManifest;
// The catalog importer reads Web's AST helper, locale sources and tsconfig
// without a manifest dependency. Keep that validation consumer in the graph.
const VALIDATION_CONSUMERS = new Map([["@ling-stack/web", ["@ling-stack/localization"]]]);
// Offline calibration loads the Core grader; the external consumer builds these SDK producers.
const ASSURANCE_PACKAGES = new Set(["@ling-stack/core", "@ling-stack/localization",
  "@ling-stack/contracts", "@ling-stack/plugin-sdk", "@ling-stack/api-client"]);

function isAssurancePath(file) {
  return file.startsWith("scripts/framework-assurance/") || file.startsWith("fixtures/framework-assurance/");
}

/**
 * Classify a pull request by the narrowest safe CI scope.
 *
 * The classifier is intentionally conservative: a path that is not recognized
 * as documentation, allowlisted maintenance, or a workspace package escalates
 * to the full CI lane.
 * @param {{files: string[], eventName?: string, forceFull?: boolean, packageEntries?: PackageEntry[], basePackageEntries?: PackageEntry[]}} input
 * @returns {CiScope}
 */
export function classifyChangedFiles(input) {
  const files = normalizeFiles(input.files);
  const eventName = input.eventName ?? "pull_request";
  const packages = input.packageEntries ?? discoverPackages(repositoryRoot);
  const nativeSurfaceChanged = files.some(isMacosNativePath);

  if (eventName !== "pull_request" || input.forceFull || files.length === 0) {
    return buildScope("full", files, packages, "non-PR event or explicit full CI");
  }

  if (files.some((file) => !isDocumentationPath(file) && !isMaintenancePath(file) && !isAssurancePath(file)
    && FORCE_FULL_PATTERNS.some((pattern) => pattern.test(file)))) {
    return buildScope("full", files, packages, "root, workflow, dependency, or build configuration change");
  }

  if (files.every((file) => isDocumentationPath(file) || isMaintenancePath(file))) {
    const reason = files.some(isMaintenancePath)
      ? "documentation and allowlisted maintenance checks only"
      : "documentation and documentation assets only";
    return buildScope("docs", files, packages, reason);
  }

  for (const file of files.filter((file) => file.endsWith("/package.json"))) {
    const directory = dirname(file);
    const current = packages.find((entry) => entry.directory === directory);
    const previous = input.basePackageEntries?.find((entry) => entry.directory === directory);
    if (!current || !previous || current.name !== previous.name
      || current.hasTestScript !== previous.hasTestScript || current.hasTypecheckScript !== previous.hasTypecheckScript
      || !current.scriptsFingerprint || current.scriptsFingerprint !== previous.scriptsFingerprint) {
      return buildScope("full", files, packages, "unverified or changed workspace package identity or validation scripts");
    }
  }

  const changedEntries = new Set();
  const changedTestEntries = new Set();
  const changedSourceEntries = new Set();
  const unresolvedFiles = [];

  for (const file of files) {
    if (isDocumentationPath(file) || isMaintenancePath(file) || isAssurancePath(file)) continue;
    if (isMacosNativePath(file)) continue;
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

  // The native helper lives outside a workspace package, but its build and
  // contract are consumed by Daemon. Treat it as a Daemon source input so the
  // normal build and platform test graph remain selected.
  if (nativeSurfaceChanged && packages.some((entry) => entry.name === "@ling-stack/daemon")) {
    changedEntries.add("@ling-stack/daemon");
    changedSourceEntries.add("@ling-stack/daemon");
  }

  if (unresolvedFiles.length > 0) {
    return buildScope("full", files, packages, `unrecognized paths: ${unresolvedFiles.join(", ")}`);
  }

  const sourceEntries = [...changedSourceEntries];
  const affectedNames = new Set(changedEntries);
  const dependencyGraph = packages.map((entry) => ({ ...entry, dependencies: [...new Set([
    ...entry.dependencies,
    ...(input.basePackageEntries?.find((previous) => previous.name === entry.name)?.dependencies ?? []),
  ])] }));
  for (const name of sourceEntries) collectDependents(name, dependencyGraph, affectedNames);
  // These are test inputs, not production edges. Rechecking an importer does
  // not change its shipped output or select all of its production consumers.
  for (const name of sourceEntries) {
    for (const consumer of VALIDATION_CONSUMERS.get(name) ?? []) {
      if (packages.some((entry) => entry.name === consumer)) affectedNames.add(consumer);
    }
  }

  const testSupportImporters = findChangedValidationImporters({
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
  const daemonPlatforms = affectedNames.has("@ling-stack/daemon")
    ? selectDaemonPlatforms({ files, changedSourceEntries, testSupportImporters })
    : [];

  return {
    mode: "affected",
    files,
    packages: affectedEntries.map((entry) => entry.name).sort(),
    testPackages,
    typecheckPackages,
    dependencyPolicy: files.some((file) => file.endsWith("/package.json") || DEPENDENCY_CHECK_FILES.has(file)),
    assurance: files.some(isAssurancePath) || sourceEntries.some(name => ASSURANCE_PACKAGES.has(name)),
    daemon: affectedNames.has("@ling-stack/daemon"),
    daemonPlatforms,
    macosNative: nativeSurfaceChanged,
    web: affectedNames.has("@ling-stack/web"),
    reason: changedEntries.size === 0 ? "offline assurance inputs and validation consumers" : changedSourceEntries.size === 0
      ? "test or test-support changes in affected workspace packages"
      : "workspace source change with transitive consumers",
  };
}

/** @typedef {{name: string, directory: string, dependencies: string[], hasTestScript: boolean, hasTypecheckScript: boolean, scriptsFingerprint?: string}} PackageEntry */
/** @typedef {{mode: "docs"|"affected"|"full", files: string[], packages: string[], testPackages: string[], typecheckPackages: string[], dependencyPolicy: boolean, assurance: boolean, daemon: boolean, daemonPlatforms: string[], macosNative: boolean, web: boolean, reason: string}} CiScope */

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
    || /(?:^|\/)README\.md$/iu.test(file)
    || /^\.github\/(?:PULL_REQUEST_TEMPLATE\.md|PULL_REQUEST_TEMPLATE\/[^/]+\.md|CODEOWNERS|FUNDING\.yml)$/u.test(file);
}

/** @param {string} file */
function isMaintenancePath(file) {
  return file.startsWith(".github/ISSUE_TEMPLATE/") || MAINTENANCE_CHECK_FILES.has(file);
}

/** @param {string} file */
function isTestPath(file) {
  return TEST_PATH_PATTERN.test(file);
}

/** @param {string} file */
function isMacosNativePath(file) {
  return MACOS_NATIVE_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

/** @param {string} file */
function daemonTestEntry(file) {
  return DAEMON_TEST_ENTRY_PATTERN.exec(file)?.[1];
}

/**
 * Only a change set made entirely of directly assigned Daemon test entrypoints
 * can narrow the platform matrix. Source, shared fixtures, validation imports,
 * unknown files and full-scope events retain both platforms.
 * @param {{files: string[], changedSourceEntries: Set<string>, testSupportImporters: Set<string>}} input
 */
function selectDaemonPlatforms({ files, changedSourceEntries, testSupportImporters }) {
  const actionable = files.filter(file => !isDocumentationPath(file) && !isMaintenancePath(file) && !isAssurancePath(file));
  const entries = actionable.map(daemonTestEntry);
  const nativeTestOnly = changedSourceEntries.size === 1
    && changedSourceEntries.has("@ling-stack/daemon")
    && actionable.length > 0
    && actionable.every(file => isMacosNativePath(file));
  if ((changedSourceEntries.size > 0 && !nativeTestOnly) || testSupportImporters.has("@ling-stack/daemon")) return [...DAEMON_PLATFORMS];
  if (entries.length === 0 || entries.some(entry => !entry)) return [...DAEMON_PLATFORMS];
  const manifest = loadDaemonPlatformManifest();
  if (!manifest) return [...DAEMON_PLATFORMS];
  const selected = new Set();
  for (const entry of entries) {
    const platform = manifest.get(entry);
    if (!platform) return [...DAEMON_PLATFORMS];
    selected.add(platform);
  }
  return DAEMON_PLATFORMS.filter(platform => selected.has(platform));
}

/** @returns {Map<string, string>|undefined} */
function loadDaemonPlatformManifest() {
  if (daemonPlatformManifest !== undefined) return daemonPlatformManifest;
  try {
    const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "scripts/ci/daemon-test-platforms.json"), "utf8"));
    if (manifest?.version !== 1 || !Array.isArray(manifest.linux) || !Array.isArray(manifest.darwin)) {
      daemonPlatformManifest = undefined;
      return undefined;
    }
    const all = [...manifest.linux, ...manifest.darwin];
    if (new Set(all).size !== all.length || all.some(file => typeof file !== "string")) {
      daemonPlatformManifest = undefined;
      return undefined;
    }
    daemonPlatformManifest = new Map([
      ...manifest.linux.map(file => [file, "linux"]),
      ...manifest.darwin.map(file => [file, "darwin"]),
    ]);
    return daemonPlatformManifest;
  } catch {
    daemonPlatformManifest = undefined;
    return undefined;
  }
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
function collectDependents(name, packages, affected, visited = new Set()) {
  if (visited.has(name)) return;
  visited.add(name);
  for (const entry of packages) {
    if (!entry.dependencies.includes(name)) continue;
    affected.add(entry.name);
    collectDependents(entry.name, packages, affected, visited);
  }
}

/**
 * Validation imports and module-relative URLs cross package boundaries through
 * shared fixtures and assurance modules. Follow their transitive consumers without treating
 * validation-only dependencies as production dependencies.
 */
function findChangedValidationImporters({ files, packages }) {
  const affected = new Set(files.filter(file => isAssurancePath(file)
    || (isTestPath(file) && TEST_SUPPORT_PATTERN.test(file))));
  if (affected.size === 0) return new Set();

  const importers = new Set();
  const imports = new Map();
  for (const candidate of listRepositoryFiles(repositoryRoot)) {
    if (!isTestPath(candidate) && !isAssurancePath(candidate)) continue;
    const source = readFileIfText(resolve(repositoryRoot, candidate));
    if (source === undefined) continue;
    imports.set(candidate, [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/gu),
      ...source.matchAll(/new\s+URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu)]
      .map(specifier => normalizePath(relative(repositoryRoot, resolve(dirname(resolve(repositoryRoot, candidate)), specifier[1])))));
  }
  let expanded;
  do {
    expanded = false;
    for (const [candidate, targets] of imports) {
      if (!affected.has(candidate) && targets.some(target => [...affected].some(file => sameImportTarget(file, target)))) {
        affected.add(candidate);
        expanded = true;
      }
    }
  } while (expanded);
  for (const file of affected) {
    const owner = findOwningPackage(file, packages);
    if (owner && isTestPath(file)) importers.add(owner.name);
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
function discoverPackages(root, ref) {
  if (ref) {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", ref, "--", "packages", "apps"], {
      cwd: root, encoding: "utf8",
    }).split("\0").filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(file))
      .map((file) => packageEntry(dirname(file), JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], {
        cwd: root, encoding: "utf8",
      }))));
  }
  const entries = [];
  for (const workspaceRoot of ["packages", "apps"]) {
    const absoluteRoot = resolve(root, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const directoryName of readdirSync(absoluteRoot)) {
      const directory = `${workspaceRoot}/${directoryName}`;
      const packagePath = resolve(root, directory, "package.json");
      if (!existsSync(packagePath)) continue;
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      entries.push(packageEntry(directory, manifest));
    }
  }
  return entries;
}

function packageEntry(directory, manifest) {
  return {
    name: manifest.name,
    directory,
    dependencies: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies,
      ...manifest.optionalDependencies, ...manifest.peerDependencies }),
    hasTestScript: typeof manifest.scripts?.test === "string",
    hasTypecheckScript: typeof manifest.scripts?.typecheck === "string",
    scriptsFingerprint: JSON.stringify(Object.entries(manifest.scripts ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
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
    dependencyPolicy: mode === "full",
    assurance: mode === "full",
    daemon: mode === "full" || names.includes("@ling-stack/daemon"),
    daemonPlatforms: mode === "full" ? [...DAEMON_PLATFORMS] : [],
    macosNative: mode === "full" || files.some(isMacosNativePath),
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
  let basePackageEntries;
  if (args.files) {
    files = JSON.parse(args.files);
  } else if (eventName === "pull_request" && args.base && args.head) {
    files = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${args.base}...${args.head}`], { cwd: repositoryRoot, encoding: "utf8" }).split("\0").filter(Boolean);
    if (files.some((file) => file.endsWith("/package.json"))) basePackageEntries = discoverPackages(repositoryRoot, args.base);
  } else {
    files = [];
  }
  console.log(JSON.stringify(classifyChangedFiles({ files, eventName, forceFull: args["force-full"] === "true", basePackageEntries })));
}
