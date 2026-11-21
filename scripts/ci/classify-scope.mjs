import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isGeneratedProviderModelCatalogRefresh, PROVIDER_MODEL_CATALOG_PATH, providerModelCatalogDigest } from "../provider-model-catalog-format.mjs";
import { packageValidationScope } from "./package-validation-scope.mjs";
import { inspectProductVersionChange } from "./product-version-scope.mjs";
import { planSecretScan } from "./secret-scan.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_OUTPUT_DIRECTORY = "output/";
const LOCKFILE = "pnpm-lock.yaml";
const WEB_PACKAGE = "@ling-stack/web";
const CORE_PACKAGE = "@ling-stack/core";

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

const TEST_PATH_PATTERN = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|(?:^|\/)[^/]+\.test\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TEST_SUPPORT_PATTERN = /(?:fixture|fixtures|helper|helpers|support|setup|util|utils)/iu;
const SUPPORTED_TEST_PACKAGE_PREFIXES = ["packages/"];
const SUPPORTED_TEST_PACKAGE_DIRECTORIES = new Set(["apps/web", "apps/chrome-extension", "apps/mobile"]);
const NATIVE_RELEASE_REVIEW_FILES = new Set([
  "native/office-local/reviewed-packaged-source-v1.json",
  "native/sandbox/reviewed-codesign-source-v1.json",
]);
// The standalone macOS helper smoke validates the reviewed Seatbelt/native
// helper itself. Keep it for changes that can alter that contract; ordinary
// Daemon changes retain the complete Darwin test suite without consuming an
// additional hosted macOS runner.
const MACOS_NATIVE_PATH_PATTERNS = [
  /^apps\/desktop\/(?:native\/locked-use(?:\/|$)|scripts\/build-locked-use\.ts$)/u,
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
const VALIDATION_CONSUMERS = new Map([[WEB_PACKAGE, ["@ling-stack/localization"]]]);
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
 * as documentation, allowlisted maintenance, verified local output cleanup, or
 * a workspace package escalates to the full CI lane.
 * @param {{files: string[], deletedOutputFiles?: string[], eventName?: string, forceFull?: boolean, packageEntries?: PackageEntry[], basePackageEntries?: PackageEntry[], versionChange?: ReturnType<typeof inspectProductVersionChange>, generatedProviderCatalog?: boolean, addedLockImporters?: string[]}} input
 * @returns {CiScope}
 */
export function classifyChangedFiles(input) {
  const files = normalizeFiles(input.files);
  const eventName = input.eventName ?? "pull_request";
  const packages = input.packageEntries ?? discoverPackages(repositoryRoot);
  const nativeSurfaceChanged = files.some(isMacosNativePath);
  const nativeRelease = files.some(file => NATIVE_RELEASE_REVIEW_FILES.has(file));
  const versionPaths = new Set(input.versionChange?.paths);
  const scopedLockfile = (input.addedLockImporters?.length ?? 0) > 0;

  if (eventName !== "pull_request" || input.forceFull || files.length === 0) {
    return buildScope("full", files, packages, "non-PR event or explicit full CI");
  }

  // Keep deleted local artifacts in the audit while narrowing product selection.
  const deletedOutputs = new Set(input.deletedOutputFiles?.filter(file => file.startsWith(LOCAL_OUTPUT_DIRECTORY)));
  const scopeFiles = deletedOutputs.size === 0 ? files : normalizeFiles(input.files.filter(file => !deletedOutputs.has(file)));

  if (scopeFiles.some((file) => !isDocumentationPath(file) && !isMaintenancePath(file) && !isAssurancePath(file)
    && !versionPaths.has(file)
    && !(scopedLockfile && file === LOCKFILE)
    && FORCE_FULL_PATTERNS.some((pattern) => pattern.test(file)))) {
    return buildScope("full", files, packages, "root, workflow, dependency, or build configuration change");
  }

  if (scopeFiles.every((file) => isDocumentationPath(file) || isMaintenancePath(file))) {
    const reason = deletedOutputs.size > 0 ? "verified local output cleanup and common checks only"
      : scopeFiles.some(isMaintenancePath) ? "documentation and allowlisted maintenance checks only"
        : "documentation and documentation assets only";
    return buildScope("docs", files, packages, reason);
  }

  if (input.generatedProviderCatalog && scopeFiles.includes(PROVIDER_MODEL_CATALOG_PATH)
    && scopeFiles.every(file => file === PROVIDER_MODEL_CATALOG_PATH || isDocumentationPath(file) || isMaintenancePath(file))) {
    if (!packages.some(entry => entry.directory === "packages/core" && entry.name === CORE_PACKAGE
      && entry.hasTestScript && entry.hasTypecheckScript)) {
      return buildScope("full", files, packages, "provider catalog requires the Core package");
    }
    return {
      ...buildScope("affected", files, packages, "verified generated provider model catalog refresh"),
      packages: [CORE_PACKAGE],
      typecheckPackages: [CORE_PACKAGE],
      providerModelCatalog: true,
    };
  }

  const validationManifests = new Set();
  const validationInputs = new Set();
  const newPackages = new Set();
  for (const file of scopeFiles.filter((file) => file.endsWith("/package.json"))) {
    const directory = dirname(file);
    const current = packages.find((entry) => entry.directory === directory);
    const previous = input.basePackageEntries?.find((entry) => entry.directory === directory);
    if (current && !previous && input.basePackageEntries
      && !input.basePackageEntries.some(entry => entry.name === current.name)
      && packages.filter(entry => entry.name === current.name).length === 1
      && isStandardPackageAddition(current, scopeFiles)) {
      newPackages.add(directory);
      continue;
    }
    if (!current || !previous || current.name !== previous.name
      || current.hasTestScript !== previous.hasTestScript || current.hasTypecheckScript !== previous.hasTypecheckScript
      || !current.scriptsFingerprint || !previous.scriptsFingerprint) {
      return buildScope("full", files, packages, `unverified workspace package identity or validation scripts: ${file}`);
    }
    if (current.scriptsFingerprint !== previous.scriptsFingerprint) {
      const validation = packageValidationScope({ current: current.manifest, previous: previous.manifest,
        directory, root: repositoryRoot, repositoryFiles: listRepositoryFiles(repositoryRoot),
        previousFiles: previous.files, changedFiles: scopeFiles });
      if (!validation || !isSupportedTestPackage(directory) || !isSupportedTypecheckPackage(directory)) {
        return buildScope("full", files, packages, `unverified workspace package identity or validation scripts: ${file}`);
      }
      validationManifests.add(file);
      for (const input of validation.testInputs) validationInputs.add(input);
    }
  }
  if (scopedLockfile && input.addedLockImporters.some(directory => !newPackages.has(directory))) {
    return buildScope("full", files, packages, "lockfile changes require verified new workspace importers");
  }

  const changedEntries = new Set();
  const changedTestEntries = new Set();
  const changedSourceEntries = new Set();
  const unresolvedFiles = [];

  for (const file of scopeFiles) {
    if (isDocumentationPath(file) || isMaintenancePath(file) || isAssurancePath(file)) continue;
    if (versionPaths.has(file) || (scopedLockfile && file === LOCKFILE)) continue;
    if (NATIVE_RELEASE_REVIEW_FILES.has(file)) continue;
    if (isMacosNativePath(file)) continue;
    const entry = findOwningPackage(file, packages);
    if (!entry) {
      unresolvedFiles.push(file);
      continue;
    }
    changedEntries.add(entry.name);
    if (isTestPath(file) || validationManifests.has(file) || validationInputs.has(file)) {
      changedTestEntries.add(entry.name);
    } else {
      changedSourceEntries.add(entry.name);
    }
  }

  // The root release number is embedded in the production Web build.
  if (versionPaths.size > 0) {
    if (!packages.some(entry => entry.name === WEB_PACKAGE)) {
      return buildScope("full", files, packages, "a product version consumer could not be verified");
    }
    changedEntries.add(WEB_PACKAGE);
    changedSourceEntries.add(WEB_PACKAGE);
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
  if (nativeRelease && !packages.some(entry => entry.name === "@ling-stack/daemon")) {
    return buildScope("full", files, packages, "native release review requires the Daemon build dependency");
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
    files: scopeFiles,
    packages,
  });
  for (const name of testSupportImporters) affectedNames.add(name);

  const affectedEntries = packages.filter((entry) => entry.name !== WEB_PACKAGE && affectedNames.has(entry.name));
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
    ? selectDaemonPlatforms({ files: scopeFiles, changedSourceEntries, testSupportImporters })
    : [];
  const linuxContract = affectedNames.has("@ling-stack/daemon") && daemonPlatforms.includes("linux");

  return {
    mode: "affected",
    files,
    packages: [...new Set([...affectedEntries.map((entry) => entry.name),
      ...(nativeRelease ? ["@ling-stack/daemon"] : [])])].sort(),
    testPackages,
    typecheckPackages,
    dependencyPolicy: scopeFiles.some(file => (file.endsWith("/package.json") && !validationManifests.has(file))
      || DEPENDENCY_CHECK_FILES.has(file)),
    assurance: scopeFiles.some(isAssurancePath) || sourceEntries.some(name => ASSURANCE_PACKAGES.has(name)),
    daemon: affectedNames.has("@ling-stack/daemon"),
    daemonPlatforms,
    linuxContract,
    macosNative: nativeSurfaceChanged || nativeRelease,
    macosHelper: nativeSurfaceChanged,
    nativeRelease,
    productVersion: versionPaths.size > 0 ? input.versionChange?.version : undefined,
    reason: versionPaths.size > 0 ? "verified product version fields and affected workspace inputs"
      : nativeRelease && changedEntries.size === 0 ? "native release review inputs and build dependencies"
      : changedEntries.size === 0 ? "offline assurance inputs and validation consumers" : changedSourceEntries.size === 0
      ? "test or test-support changes in affected workspace packages"
      : "workspace source change with transitive consumers",
  };
}

/** @typedef {{name: string, directory: string, dependencies: string[], hasTestScript: boolean, hasTypecheckScript: boolean, scriptsFingerprint?: string, manifest?: object, files?: string[]}} PackageEntry */
/** @typedef {{mode: "docs"|"affected"|"full", files: string[], packages: string[], testPackages: string[], typecheckPackages: string[], dependencyPolicy: boolean, assurance: boolean, daemon: boolean, daemonPlatforms: string[], linuxContract: boolean, macosNative: boolean, macosHelper: boolean, nativeRelease: boolean, productVersion?: string, providerModelCatalog?: boolean, documentationOnly?: boolean, reason: string}} CiScope */

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
  if (file.startsWith(LOCAL_OUTPUT_DIRECTORY)) return false;
  if (file.startsWith("docs/")
    || DOCUMENTATION_ROOT_FILES.has(file)
    || /(?:^|\/)README\.md$/iu.test(file)
    || /^\.github\/(?:PULL_REQUEST_TEMPLATE\.md|PULL_REQUEST_TEMPLATE\/[^/]+\.md|CODEOWNERS|FUNDING\.yml)$/u.test(file)) {
    return true;
  }

  const locale = /^README\.([A-Za-z0-9-]+)\.md$/u.exec(file)?.[1];
  if (locale === undefined) return false;
  try {
    Intl.getCanonicalLocales(locale);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
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
  return !NATIVE_RELEASE_REVIEW_FILES.has(file) && MACOS_NATIVE_PATH_PATTERNS.some((pattern) => pattern.test(file));
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

/** @param {PackageEntry} entry @param {string[]} changedFiles */
function isStandardPackageAddition(entry, changedFiles) {
  const name = /^packages\/([a-z0-9-]+)$/u.exec(entry.directory)?.[1];
  const manifest = entry.manifest;
  const scripts = manifest?.scripts;
  if (!name || manifest?.name !== `@ling-stack/${name}` || manifest.type !== "module"
    || !scripts || typeof scripts.build !== "string" || !scripts.build.trim() || scripts["build:ci"] !== "tsc -p tsconfig.json"
    || !Object.keys(scripts).every(key => ["build", "build:ci", "test", "test:ci", "typecheck", "typecheck:ci", "typecheck:tests"].includes(key))
    || typeof scripts["typecheck:ci"] !== "string" || !scripts["typecheck:ci"].split(" && ").includes("tsc -p tsconfig.json --noEmit")
    || !entry.hasTestScript || !entry.hasTypecheckScript) return false;
  return Boolean(packageValidationScope({ current: manifest, directory: entry.directory, root: repositoryRoot,
    repositoryFiles: listRepositoryFiles(repositoryRoot), changedFiles }));
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
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", ref, "--", "packages", "apps"], {
      cwd: root, encoding: "utf8",
    }).split("\0").filter(Boolean);
    return files.filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(file)).map((file) => {
      const directory = dirname(file);
      return {
        ...packageEntry(directory, JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8" }))),
        files: files.filter(candidate => candidate.startsWith(`${directory}/`)),
      };
    });
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
    manifest,
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
  const selected = mode === "full" ? packages.filter((entry) => entry.name !== WEB_PACKAGE) : [];
  return {
    mode,
    files,
    packages: selected.map((entry) => entry.name).sort(),
    testPackages: selected.filter((entry) => entry.hasTestScript && isSupportedTestPackage(entry.directory)).map((entry) => entry.name).sort(),
    typecheckPackages: selected.filter((entry) => entry.hasTypecheckScript && isSupportedTypecheckPackage(entry.directory)).map((entry) => entry.name).sort(),
    dependencyPolicy: mode === "full",
    assurance: mode === "full",
    daemon: mode === "full",
    daemonPlatforms: mode === "full" ? [...DAEMON_PLATFORMS] : [],
    linuxContract: mode === "full",
    macosNative: mode === "full" || files.some(isMacosNativePath),
    macosHelper: mode === "full" || files.some(isMacosNativePath),
    nativeRelease: files.some(file => NATIVE_RELEASE_REVIEW_FILES.has(file)),
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

// Pinned pnpm writes importer blocks separated by blank lines. Verify that
// removing the new blocks reproduces the entire baseline lockfile byte for byte.
function inspectAddedLockImporters(before, after, directories) {
  const start = after.indexOf("\nimporters:\n\n");
  if (start === -1 || directories.length === 0) return [];
  const body = start + "\nimporters:\n\n".length;
  const end = after.indexOf("\n\npackages:\n", body);
  if (end === -1) return [];
  const additions = new Set();
  const existing = [];
  for (const block of after.slice(body, end).split("\n\n")) {
    const [header, ...lines] = block.split("\n");
    const directory = /^  (packages\/[a-z0-9-]+):(?: \{\})?$/u.exec(header)?.[1];
    if (!directory || !directories.includes(directory)) {
      existing.push(block);
      continue;
    }
    if (additions.has(directory) || lines.some(line =>
      !/^ {4}(?:dependencies|devDependencies|optionalDependencies):$/u.test(line)
        && !/^ {6}'@ling-stack\/[a-z0-9-]+':$/u.test(line)
        && !/^ {8}(?:specifier: workspace:\*|version: link:(?:\.\.\/)+(?:[a-z0-9-]+\/)*[a-z0-9-]+)$/u.test(line))) return [];
    additions.add(directory);
  }
  if (additions.size !== directories.length || before !== after.slice(0, body) + existing.join("\n\n") + after.slice(end)) return [];
  return [...additions];
}

function documentationOnlyHistory({ base, head }) {
  try {
    const plan = planSecretScan({ eventName: "pull_request", base, head, cwd: repositoryRoot });
    if (plan.mode !== "range") return false;
    const files = execFileSync("git", [
      "log", ...plan.logOpts.split(" "), "--format=", "--name-only", "--no-renames", "-z", "--",
    ], { cwd: repositoryRoot, encoding: "utf8", timeout: 15_000 }).split("\0").filter(Boolean);
    return files.length > 0 && files.every(isDocumentationPath);
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const eventName = args.event ?? process.env.GITHUB_EVENT_NAME ?? "pull_request";
  let files;
  let deletedOutputFiles;
  let basePackageEntries;
  let versionChange;
  let generatedProviderCatalog;
  let addedLockImporters;
  if (args.files) {
    files = JSON.parse(args.files);
  } else if (eventName === "pull_request" && args.base && args.head) {
    const git = (argv) => execFileSync("git", argv, { cwd: repositoryRoot, encoding: "utf8" });
    const base = git(["merge-base", args.base, args.head]).trim();
    files = git(["diff", "--no-renames", "--name-only", "-z", base, args.head, "--"]).split("\0").filter(Boolean);
    if (files.some(file => file.startsWith(LOCAL_OUTPUT_DIRECTORY))) {
      deletedOutputFiles = git(["diff", "--no-renames", "--diff-filter=D", "--name-only", "-z",
        base, args.head, "--", LOCAL_OUTPUT_DIRECTORY]).split("\0").filter(Boolean);
    }
    if (files.some((file) => file.endsWith("/package.json"))) basePackageEntries = discoverPackages(repositoryRoot, base);
    if (args["force-full"] !== "true" && files.includes(LOCKFILE) && basePackageEntries) {
      const directories = files.filter(file => /^packages\/[a-z0-9-]+\/package\.json$/u.test(file))
        .map(dirname).filter(directory => !basePackageEntries.some(entry => entry.directory === directory));
      if (directories.length > 0 && [base, args.head].every(ref =>
        /^100644 blob /u.test(git(["ls-tree", ref, "--", LOCKFILE])))) {
        addedLockImporters = inspectAddedLockImporters(git(["show", `${base}:${LOCKFILE}`]),
          git(["show", `${args.head}:${LOCKFILE}`]), directories);
      }
    }
    versionChange = inspectProductVersionChange({ root: repositoryRoot, base, head: args.head, files });
    if (args["force-full"] !== "true" && /^[a-f0-9]{64}$/u.test(args["catalog-proof"])
      && files.includes(PROVIDER_MODEL_CATALOG_PATH) && [base, args.head].every(ref =>
        /^100644 blob /u.test(git(["ls-tree", ref, "--", PROVIDER_MODEL_CATALOG_PATH])))) {
      const after = git(["show", `${args.head}:${PROVIDER_MODEL_CATALOG_PATH}`]);
      generatedProviderCatalog = args["catalog-proof"] === providerModelCatalogDigest(after)
        && isGeneratedProviderModelCatalogRefresh(git(["show", `${base}:${PROVIDER_MODEL_CATALOG_PATH}`]), after);
    }
  } else {
    files = [];
  }
  const scope = classifyChangedFiles({ files, deletedOutputFiles, eventName,
    forceFull: args["force-full"] === "true", basePackageEntries, versionChange, generatedProviderCatalog, addedLockImporters });
  if (scope.mode === "docs" && scope.files.every(isDocumentationPath) && !args.files && args.base && args.head) {
    scope.documentationOnly = documentationOnlyHistory({ base: args.base, head: args["pr-head"] ?? args.head });
  }
  console.log(JSON.stringify(scope));
}
