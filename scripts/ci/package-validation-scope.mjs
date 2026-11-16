import { readFileSync, readdirSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { isDeepStrictEqual } from "node:util";

const validationScripts = new Set(["test", "test:ci", "typecheck", "typecheck:ci"]);
const testCommand = /^node --test(?: --test-concurrency=\d+)? ((?:(?:test|tests)\/\*\.test\.(?:mjs|ts) ?)+)$/u;
const typecheckCommand = /^tsc -p (tsconfig(?:\.[\w-]+)?\.json)( --noEmit)?$/u;

/**
 * Recognize package-local Node/TypeScript validation migrations. Production
 * metadata, build commands, hooks and CI entrypoint presence must stay fixed.
 * Opaque shell commands retain the full-regression fallback.
 */
export function packageValidationScope({ current, previous, directory, root, repositoryFiles, previousTestFiles }) {
  if (!current || !previous || !Array.isArray(previousTestFiles)
    || previousTestFiles.some(file => typeof file !== "string")) return undefined;
  const { scripts, ...metadata } = current;
  const { scripts: oldScripts, ...oldMetadata } = previous;
  if (!scripts || !oldScripts || !isDeepStrictEqual(metadata, oldMetadata)
    || !isDeepStrictEqual(Object.keys(scripts).sort(), Object.keys(oldScripts).sort())) return undefined;
  const productionScripts = value => Object.fromEntries(Object.entries(value).filter(([name]) => !validationScripts.has(name)));
  if (!isDeepStrictEqual(productionScripts(scripts), productionScripts(oldScripts))) return undefined;
  if ([scripts, oldScripts].some(value => [...validationScripts].some(name => typeof value[name] !== "string" || !value[name].trim()))) return undefined;

  const packageRoot = join(root, directory);
  const production = Object.values(productionScripts(scripts));
  const testConfigs = new Set();
  const typedTestIncludes = new Set();
  for (const candidate of [oldScripts, scripts]) {
    const tests = testCommand.exec(candidate["test:ci"]);
    if (!tests) return undefined;
    const checks = candidate["typecheck:ci"].split(" && ");
    for (const command of checks) {
      const match = typecheckCommand.exec(command);
      if (!match) return undefined;
      if (!match[2]) {
        let config;
        try { config = JSON.parse(readFileSync(join(packageRoot, match[1]), "utf8")); }
        catch { return undefined; }
        if (config.compilerOptions?.noEmit !== true) return undefined;
        // A config shared with source/build inputs remains a source change.
        if (/^tsconfig\.tests?\.json$/u.test(match[1]) && Array.isArray(config.include) && config.include.length > 0
          && config.include.every(path => typeof path === "string" && /^(?:test|tests)\//u.test(path) && !path.split("/").includes(".."))
          && !config.files && !config.references && !config.exclude
          && !production.some(command => typeof command !== "string" || command.includes(match[1]))
          && isolatedConfig(packageRoot, match[1], repositoryFiles.filter(file => file.startsWith(`${directory}/`))
            .map(file => file.slice(directory.length + 1))) && candidate === scripts) {
          testConfigs.add(`${directory}/${match[1]}`);
          for (const pattern of config.include) typedTestIncludes.add(pattern);
        }
      }
    }
    const buildCommands = typeof candidate.build === "string" ? candidate.build.split(" && ") : [];
    const prefixes = ["", "corepack pnpm build && ",
      ...buildCommands.map((_, index) => `${buildCommands.slice(0, index + 1).join(" && ")} && `)];
    for (const task of ["test", "typecheck"]) {
      const suffixes = [candidate[`${task}:ci`], `corepack pnpm ${task}:ci`];
      if (!prefixes.some(prefix => suffixes.some(suffix => candidate[task] === prefix + suffix))) return undefined;
    }
  }
  // A migration cannot narrow discovery by leaving another test language out.
  const patterns = testCommand.exec(scripts["test:ci"])[1].trim().split(" ");
  const oldPatterns = testCommand.exec(oldScripts["test:ci"])[1].trim().split(" ");
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
  const baselineTests = previousTestFiles.filter(file => oldPatterns.some(pattern => matchesGlob(file, `${directory}/${pattern}`)));
  if (baselineTests.length === 0 || baselineTests.some(file =>
    !testIdentities.has(file.replace(/\.(?:mjs|ts)$/u, "")))) return undefined;
  return { testConfigs: [...testConfigs] };
}

function isolatedConfig(packageRoot, name, files) {
  const referencesConfig = path => typeof path !== "string" || path.split("/").at(-1).replace(/\.json$/u, "") === name.replace(/\.json$/u, "");
  for (const file of files.filter(file => /(?:^|\/)tsconfig(?:\.[\w.-]+)?\.json$/u.test(file) && file !== name)) {
    let config;
    try { config = JSON.parse(readFileSync(join(packageRoot, file), "utf8")); }
    catch { return false; }
    const parents = typeof config.extends === "string" ? [config.extends] : config.extends ?? [];
    if (!Array.isArray(parents) || parents.some(referencesConfig)
      || (config.references && (!Array.isArray(config.references)
        || config.references.some(reference => referencesConfig(reference?.path))))) return false;
  }
  return true;
}
