import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, matchesGlob, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const requiredValidationScripts = ["test", "test:ci", "typecheck", "typecheck:ci"];
const validationScripts = new Set([...requiredValidationScripts, "typecheck:tests"]);
const testCommand = /^node (?:--experimental-strip-types )?--test(?: --test-concurrency=[1-9]\d*)? ((?:(?:test|tests)\/\*\.test\.(?:mjs|ts) ?)+)$/u;
const typecheckCommand = /^(?:tsc -p (tsconfig(?:\.[\w-]+)?\.json)( --noEmit)?|tsc( --noEmit))$/u;
const testConfigName = /^tsconfig\.tests?\.json$/u;
const testTypecheckCall = /^corepack pnpm (?:run )?typecheck:tests$/u;
const syntaxCheckCommand = /^node --check src\/(?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:js|mjs|cjs)$/u;
const testCompilerOptions = ["allowImportingTsExtensions", "lib", "target"];
const workspacePackageName = /^@ling-stack\/[a-z0-9-]+$/u;
const browserHostTestRunner = "node scripts/test.mjs";
const browserHostTestPatterns = ["test/*.test.mjs", "test/*.test.ts"];
// Browser Host tests use the Daemon broker built for the A01 fixture.
export const VALIDATION_BUILD_DEPENDENCIES = new Map([["@ling-stack/browser-host", ["@ling-stack/daemon"]]]);
const localizationTestDeclarations = [
  "scripts/catalog-locales.d.mts",
  "scripts/catalog-utils.d.mts",
  "scripts/protected-tokens.d.mts",
];

/**
 * Recognize package-local Node/TypeScript validation migrations. Production
 * metadata, build commands, hooks and CI entrypoint presence must stay fixed.
 * Opaque shell commands retain the full-regression fallback.
 */
export function packageValidationScope({ current, previous, directory, root, repositoryFiles, previousFiles = [], changedFiles,
  previousTestConfigs = new Map() }) {
  if (!current || !Array.isArray(previousFiles) || !Array.isArray(changedFiles)
    || [...previousFiles, ...changedFiles].some(file => typeof file !== "string")) return undefined;
  const { scripts, ...metadata } = current;
  const { scripts: oldScripts, ...oldMetadata } = previous ?? current;
  const candidates = previous ? [oldScripts, scripts] : [scripts];
  if (!scripts || !oldScripts || !isDeepStrictEqual(metadata, oldMetadata)) return undefined;
  const productionScripts = value => Object.fromEntries(Object.entries(value).filter(([name]) => !validationScripts.has(name)));
  if (!isDeepStrictEqual(productionScripts(scripts), productionScripts(oldScripts))) return undefined;
  if (candidates.some(value => requiredValidationScripts.some(name => typeof value[name] !== "string" || !value[name].trim()))) return undefined;
  if ([...validationScripts].some(name => Object.hasOwn(scripts, `pre${name}`) || Object.hasOwn(scripts, `post${name}`))) return undefined;

  const packageRoot = join(root, directory);
  const production = Object.values(productionScripts(scripts));
  const workspaceBuilds = new Set(Object.entries({ ...metadata.dependencies, ...metadata.devDependencies })
    .filter(([name, range]) => workspacePackageName.test(name) && range === "workspace:*")
    .flatMap(([name]) => [`corepack pnpm --filter ${name} build`, `corepack pnpm --filter ${name} run build`,
      `corepack pnpm --filter ${name}... run build:ci`]));
  if (typeof scripts["build:deps"] === "string"
    && scripts["build:deps"].split(" && ").every(command => workspaceBuilds.has(command))) {
    workspaceBuilds.add("corepack pnpm build:deps");
    workspaceBuilds.add("corepack pnpm run build:deps");
  }
  if (workspacePackageName.test(metadata.name) && typeof scripts["build:ci"] === "string" && scripts["build:ci"].trim()) {
    workspaceBuilds.add(`corepack pnpm --filter ${metadata.name}... run build:ci`);
  }
  for (const dependency of VALIDATION_BUILD_DEPENDENCIES.get(metadata.name) ?? []) {
    workspaceBuilds.add(`corepack pnpm --filter ${dependency}... run build:ci`);
  }
  const previousPaths = new Set(previousFiles);
  const testConfigs = new Set();
  const typedTestIncludes = new Set();
  const localization = directory === "packages/localization" && metadata.name === "@ling-stack/localization";
  const browserHost = directory === "packages/browser-host" && metadata.name === "@ling-stack/browser-host"
    && previousPaths.has("packages/browser-host/scripts/test.mjs") && !changedFiles.includes("packages/browser-host/scripts/test.mjs");
  const testPrelude = localization ? "node scripts/check-catalogs.mjs && " : "";
  const typecheckPrelude = localization ? "node scripts/compile-catalogs.mjs && " : "";
  const testPatterns = [];
  const typecheckInputs = [];
  for (const candidate of candidates) {
    const testEntry = candidate["test:ci"];
    const typecheckEntry = candidate["typecheck:ci"];
    if (!testEntry.startsWith(testPrelude) || !typecheckEntry.startsWith(typecheckPrelude)) return undefined;
    const nodeTest = testEntry.slice(testPrelude.length);
    const tests = testCommand.exec(nodeTest);
    const hostTests = browserHost && nodeTest === browserHostTestRunner;
    if (!tests && !hostTests) return undefined;
    if (browserHost && (nodeTest === browserHostTestRunner) !== (oldScripts["test:ci"] === browserHostTestRunner)) return undefined;
    testPatterns.push(hostTests ? browserHostTestPatterns : tests[1].trim().split(" "));
    const checks = typecheckEntry.slice(typecheckPrelude.length).split(" && ");
    const checked = new Set();
    const sourceChecks = [];
    const testChecks = [];
    if (candidate["typecheck:tests"] !== undefined && scripts["typecheck:tests"] !== oldScripts["typecheck:tests"]
      && !checks.some(command => testTypecheckCall.test(command))) return undefined;
    for (const command of checks) {
      if (syntaxCheckCommand.test(command)) {
        checked.add(command);
        sourceChecks.push(command);
        continue;
      }
      const wrapped = testTypecheckCall.test(command);
      const match = typecheckCommand.exec(wrapped ? candidate["typecheck:tests"] ?? "" : command);
      if (!match || (wrapped && !testConfigName.test(match[1]))) return undefined;
      const name = match[1] ?? "tsconfig.json";
      const configPath = `${directory}/${name}`;
      const noEmitFlag = Boolean(match[2] || match[3]);
      const isTestConfig = testConfigName.test(name);
      if (isTestConfig || !noEmitFlag) {
        if (previous && candidate === oldScripts && !previousPaths.has(configPath)) return undefined;
        const changed = previousPaths.has(configPath) && changedFiles.includes(configPath);
        const baseline = changed && isTestConfig ? previousTestConfigs.get(configPath) : undefined;
        if (changed && baseline === undefined) return undefined;
        let config;
        try {
          config = JSON.parse(previous && candidate === oldScripts && changed
            ? baseline : readFileSync(join(packageRoot, name), "utf8"));
          if (changed && candidate === scripts && !isSafeTestConfigChange(JSON.parse(baseline), config)) return undefined;
        } catch { return undefined; }
        if ((!noEmitFlag && config?.compilerOptions?.noEmit !== true) || config?.compilerOptions?.noCheck === true) return undefined;
        // A config shared with source/build inputs remains a source change.
        if (candidate === scripts && isTestConfig && hasTestConfigInputs(config)
          && !production.some(command => typeof command !== "string" || command.includes(name))
          && isolatedConfig(root, configPath, changed ? repositoryFiles
            : repositoryFiles.filter(file => file.startsWith(`${directory}/`)))) {
          testConfigs.add(configPath);
          for (const pattern of config.include) typedTestIncludes.add(pattern);
        }
      }
      checked.add(configPath);
      (isTestConfig ? testChecks : sourceChecks).push(command);
    }
    typecheckInputs.push(checked);
    const buildCommands = typeof candidate.build === "string" ? candidate.build.split(" && ") : [];
    // A package's unchanged build script may include its own verified
    // TypeScript or syntax check before the test command. Keep that narrow
    // prefix available without allowing arbitrary shell steps.
    for (const command of buildCommands) {
      if (typecheckCommand.test(command) || syntaxCheckCommand.test(command)) workspaceBuilds.add(command);
    }
    if (typeof candidate["build:ci"] === "string"
      && (typecheckCommand.test(candidate["build:ci"]) || syntaxCheckCommand.test(candidate["build:ci"]))) {
      workspaceBuilds.add("corepack pnpm build:ci");
      workspaceBuilds.add("corepack pnpm run build:ci");
    }
    const buildPrefixes = ["", "corepack pnpm build && ", "corepack pnpm run build && ",
      ...buildCommands.map((_, index) => `${buildCommands.slice(0, index + 1).join(" && ")} && `)];
    // The local test command can call the verified local typecheck command.
    for (const task of ["typecheck", "test"]) {
      const prefixes = task === "test" ? [...buildPrefixes, "corepack pnpm typecheck && ", "corepack pnpm run typecheck && "] : buildPrefixes;
      const suffixes = [candidate[`${task}:ci`], `corepack pnpm ${task}:ci`, `corepack pnpm run ${task}:ci`];
      if (task === "typecheck" && previous && candidate === oldScripts && sourceChecks.length > 0) {
        suffixes.push(typecheckPrelude + sourceChecks.join(" && "));
      }
      if (task === "test" && tests) {
        // Local validation can use the same discovery with default workers,
        // or run the verified test typecheck after building its dependencies.
        const direct = [nodeTest, `node --test ${tests[1]}`];
        suffixes.push(...direct.map(command => testPrelude + command));
        if (!localization && testChecks.length > 0) {
          suffixes.push(...direct.map(command => [...testChecks, command].join(" && ")));
        }
      }
      if (!prefixes.some(prefix => suffixes.some(suffix =>
        matchesValidationCommand(candidate[task], prefix + suffix, workspaceBuilds))
        || (localization && task === "test" && candidate[task] === testPrelude + prefix + nodeTest))) return undefined;
    }
  }
  if (previous && [...typecheckInputs[0]].some(input => !typecheckInputs[1].has(input))) return undefined;
  // A migration cannot narrow discovery by leaving another test language out.
  const oldPatterns = previous ? testPatterns[0] : [];
  const patterns = testPatterns.at(-1);
  const testIdentities = new Set();
  let testCount = 0;
  for (const directoryName of new Set([...patterns, ...oldPatterns].map(pattern => pattern.split("/")[0]))) {
    let files;
    try { files = readdirSync(join(packageRoot, directoryName)); }
    catch { return undefined; }
    const tests = files.filter(file => /\.test\.(?:mjs|ts)$/u.test(file));
    for (const file of tests) testIdentities.add(`${directory}/${directoryName}/${file}`.replace(/\.(?:mjs|ts)$/u, ""));
    testCount += tests.length;
    if (tests.some(file =>
      !patterns.some(pattern => pattern === `${directoryName}/*.test.${file.split(".").at(-1)}`))) return undefined;
    if (tests.filter(file => file.endsWith(".ts")).some(file =>
      ![...typedTestIncludes].some(pattern => matchesGlob(`${directoryName}/${file}`, pattern)))) return undefined;
  }
  if (testCount === 0) return undefined;
  const baselineTests = previousFiles.filter(file => oldPatterns.some(pattern => matchesGlob(file, `${directory}/${pattern}`)));
  if (previous && (baselineTests.length === 0 || baselineTests.some(file =>
    !testIdentities.has(file.replace(/\.(?:mjs|ts)$/u, ""))))) return undefined;
  const testInputs = [...testConfigs];
  const declarations = browserHost ? ["scripts/test.d.mts"] : localization ? localizationTestDeclarations : [];
  if (typedTestIncludes.size > 0) {
    // These private script declarations accompany the no-emit test config.
    // Changes to their runtime counterparts retain the consumer graph.
    for (const declaration of declarations) {
      const file = `${directory}/${declaration}`;
      const implementation = file.replace(/\.d\.mts$/u, ".mjs");
      if (changedFiles.includes(file) && !previousPaths.has(file)
        && previousPaths.has(implementation) && !changedFiles.includes(implementation)
        && lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) testInputs.push(file);
    }
  }
  return { testInputs };
}

function isSafeTestConfigChange(previous, current) {
  if (![previous, current].every(config => hasTestConfigInputs(config) && config.compilerOptions?.noEmit === true)) return false;
  const { compilerOptions: before, ...previousStructure } = previous;
  const { compilerOptions: after, ...currentStructure } = current;
  // TypeScript can derive module defaults from target.
  if (before.target !== after.target && (typeof before.module !== "string" || typeof before.moduleResolution !== "string")) return false;
  const otherOptions = options => Object.fromEntries(Object.entries(options).filter(([name]) => !testCompilerOptions.includes(name)));
  return isDeepStrictEqual(previousStructure, currentStructure)
    && isDeepStrictEqual(otherOptions(before), otherOptions(after));
}

function hasTestConfigInputs(config) {
  return Array.isArray(config?.include) && config.include.length > 0
    && config.include.every(path => typeof path === "string" && /^(?:test|tests)\//u.test(path) && !path.split("/").includes(".."))
    && !config.files && !config.references && !config.exclude;
}

function matchesValidationCommand(command, validation, workspaceBuilds) {
  if (command === validation) return true;
  const suffix = ` && ${validation}`;
  return command.endsWith(suffix)
    && command.slice(0, -suffix.length).split(" && ").every(step => workspaceBuilds.has(step));
}

function isolatedConfig(root, configPath, files) {
  const target = resolve(root, configPath);
  const name = basename(target, ".json");
  for (const file of files.filter(file => file !== configPath && /(?:^|\/)tsconfig(?:\.[\w.-]+)?\.json$/u.test(file))) {
    const referencesConfig = path => {
      if (typeof path !== "string") return true;
      if (!isAbsolute(path) && !/^\.{1,2}(?:\/|$)/u.test(path) && basename(path, ".json") === name) return true;
      const reference = resolve(root, dirname(file), path);
      return reference === target || reference + ".json" === target;
    };
    let config;
    try { config = JSON.parse(readFileSync(join(root, file), "utf8")); }
    catch { return false; }
    const parents = typeof config?.extends === "string" ? [config.extends] : config?.extends ?? [];
    if (!Array.isArray(parents) || parents.some(referencesConfig)
      || (config?.references && (!Array.isArray(config.references)
        || config.references.some(reference => referencesConfig(reference?.path))))) return false;
  }
  return true;
}
