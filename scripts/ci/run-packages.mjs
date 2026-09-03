import { spawnSync } from "node:child_process";

/**
 * Run one CI-only package script without invoking the package's local build
 * chain. Build dependencies are prepared once by the CI build job, so this
 * runner keeps typecheck and unit-test jobs deterministic and non-duplicative.
 */
const args = parseArgs(process.argv.slice(2));
const task = args.task;
const excludedPackages = new Set(parsePackages(args.exclude));
const packages = parsePackages(args.packages).filter((packageName) => !excludedPackages.has(packageName));
const includeDependencies = args.closure === "true";

if (!task) {
  console.error("Missing required --task=<script> argument.");
  process.exit(2);
}

if (packages.length === 0) {
  console.log(`No packages selected for ${task}; nothing to run.`);
  process.exit(0);
}

const pnpmArgs = ["pnpm", "--workspace-concurrency=1"];
for (const packageName of packages) {
  pnpmArgs.push("--filter", includeDependencies ? `${packageName}...` : packageName);
}
pnpmArgs.push("--if-present", "run", task);

const result = spawnSync("corepack", pnpmArgs, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

/** @param {string[]} argv */
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const [key, inlineValue] = value.slice(2).split("=", 2);
    parsed[key] = inlineValue ?? argv[++index];
  }
  return parsed;
}

/** @param {string | undefined} value */
function parsePackages(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--packages must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError("--packages must be a JSON array of non-empty package names");
  }
  return [...new Set(parsed)].sort();
}
