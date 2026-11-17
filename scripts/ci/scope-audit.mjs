import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const laneDefinitions = [
  ["dependency-policy", "Dependency policy and security", scope => scope.dependencyPolicy,
    "a dependency manifest or dependency-security input is in scope"],
  ["framework-assurance", "Offline assurance and SDK consumer", scope => scope.assurance,
    "an assurance input or its producer package is in scope"],
  ["build", "Selected package build", scope => scope.packages.length > 0,
    scope => `${scope.packages.length} package${scope.packages.length === 1 ? "" : "s"} selected`],
  ["typecheck", "Selected package typecheck", scope => scope.typecheckPackages.length > 0,
    scope => `${scope.typecheckPackages.length} package${scope.typecheckPackages.length === 1 ? "" : "s"} with typecheck selected`],
  ["unit-tests", "Core, package, and Web tests", scope => scope.testPackages.some(name => name !== "@ling-stack/daemon"),
    scope => `${scope.testPackages.filter(name => name !== "@ling-stack/daemon").length} package${scope.testPackages.filter(name => name !== "@ling-stack/daemon").length === 1 ? "" : "s"} with tests selected`],
  ["daemon-tests", "Daemon test shards", scope => scope.daemon,
    scope => scope.daemonPlatforms.length ? `platforms: ${scope.daemonPlatforms.join(", ")}` : "Daemon is outside the affected graph"],
  ["daemon-linux-contracts", "Linux restricted-command contracts", scope => scope.daemon,
    "Daemon validation is selected"],
  ["macos-native", "macOS native and release contracts", scope => scope.macosNative,
    scope => `helper=${scope.macosHelper ? "selected" : "skipped"}; release=${scope.nativeRelease ? "selected" : "skipped"}`],
  ["web-smoke", "Production Web smoke", scope => scope.web,
    "the Web package is selected"],
];

const booleanFields = ["dependencyPolicy", "assurance", "daemon", "macosNative", "macosHelper", "nativeRelease", "web"];

/** @typedef {{mode: string, files: string[], packages: string[], testPackages: string[], typecheckPackages: string[], dependencyPolicy: boolean, assurance: boolean, daemon: boolean, daemonPlatforms: string[], macosNative: boolean, macosHelper: boolean, nativeRelease: boolean, web: boolean, reason: string}} Scope */

/**
 * Check that the selected scope is a subset of the forced full scope.
 * This is an audit of the selector, not a replacement for product tests.
 * @param {Scope} scope
 * @param {Scope} fullScope
 */
export function auditScope(scope, fullScope) {
  const issues = [];
  if (fullScope?.mode !== "full") issues.push("forced full scope did not produce mode=full");
  if (fullScope?.mode === "full") {
    if (!Array.isArray(fullScope.packages) || fullScope.packages.length === 0) issues.push("forced full scope selected no packages");
    for (const field of ["dependencyPolicy", "assurance", "daemon", "macosNative", "macosHelper", "web"]) {
      if (fullScope[field] !== true) issues.push(`forced full scope has ${field}=${String(fullScope[field])}`);
    }
    if (JSON.stringify(fullScope.daemonPlatforms) !== JSON.stringify(["linux", "darwin"])) {
      issues.push("forced full scope must retain both Daemon platforms");
    }
  }
  for (const field of ["packages", "testPackages", "typecheckPackages"]) {
    const selected = new Set(Array.isArray(scope?.[field]) ? scope[field] : []);
    const full = new Set(Array.isArray(fullScope?.[field]) ? fullScope[field] : []);
    for (const value of selected) if (!full.has(value)) issues.push(`${field} selects ${value} outside full scope`);
  }
  for (const field of booleanFields) {
    if (scope?.[field] === true && fullScope?.[field] !== true) issues.push(`${field}=true is absent from full scope`);
  }
  const selectedPlatforms = new Set(Array.isArray(scope?.daemonPlatforms) ? scope.daemonPlatforms : []);
  const fullPlatforms = new Set(Array.isArray(fullScope?.daemonPlatforms) ? fullScope.daemonPlatforms : []);
  for (const platform of selectedPlatforms) if (!fullPlatforms.has(platform)) issues.push(`daemon platform ${platform} is outside full scope`);
  if (!scope?.daemon && selectedPlatforms.size > 0) issues.push("daemonPlatforms must be empty when daemon=false");
  if (scope?.mode === "docs" && (["packages", "testPackages", "typecheckPackages"]
    .some(field => Array.isArray(scope[field]) && scope[field].length > 0))) {
    issues.push("documentation scope selected product packages");
  }
  if (scope?.mode !== "full" && typeof scope?.reason !== "string") issues.push("non-full scope is missing a reason");
  return {
    passed: issues.length === 0,
    issues,
    selectedPackageCount: scope.packages.length,
    fullPackageCount: fullScope.packages.length,
    omittedPackageCount: Math.max(0, fullScope.packages.length - scope.packages.length),
  };
}

function list(values) {
  return values.length ? values.map(value => `\`${value}\``).join(", ") : "none";
}

/** @param {Scope} scope @param {Scope} fullScope @param {{executionTier?: string, audit?: ReturnType<typeof auditScope>}} [options] */
export function renderScopeSummary(scope, fullScope, options = {}) {
  const audit = options.audit ?? auditScope(scope, fullScope);
  const changedFiles = Array.isArray(scope.files) ? scope.files : [];
  const shownFiles = changedFiles.slice(0, 20);
  const omittedFiles = changedFiles.length - shownFiles.length;
  const lines = [
    "## CI scope",
    "",
    `- Mode: **${scope.mode ?? "unknown"}**; execution tier: **${options.executionTier ?? "unknown"}**`,
    `- Reason: ${scope.reason || "not provided"}`,
    `- Changed files: **${changedFiles.length}**; selected packages: **${audit.selectedPackageCount}/${audit.fullPackageCount}** of the forced full scope`,
    `- Test packages: ${list(scope.testPackages ?? [])}`,
    `- Typecheck packages: ${list(scope.typecheckPackages ?? [])}`,
    `- Daemon platforms: ${list(scope.daemonPlatforms ?? [])}`,
    `- Scope audit: **${audit.passed ? "passed" : "failed"}**${audit.issues.length ? ` (${audit.issues.join("; ")})` : "; selected work is a subset of the forced full scope"}`,
    "",
    "### Selected and skipped lanes",
    "",
    "| Lane | Status | Why |",
    "| --- | --- | --- |",
  ];
  for (const [, label, selected, detail] of laneDefinitions) {
    const isSelected = Boolean(selected(scope));
    const explanation = typeof detail === "function" ? detail(scope) : detail;
    lines.push(`| ${label} | **${isSelected ? "selected" : "skipped"}** | ${isSelected ? explanation : `no matching input; ${explanation}`} |`);
  }
  lines.push("", "<details>", "<summary>Changed paths</summary>", "", ...shownFiles.map(file => `- \`${file}\``));
  if (omittedFiles > 0) lines.push(`- …and ${omittedFiles} more path${omittedFiles === 1 ? "" : "s"}`);
  lines.push("", "</details>", "");
  return lines.join("\n");
}

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const [key, ...rest] = argv[index].split("=");
    if (!["--scope", "--full-scope", "--execution-tier", "--output"].includes(key) || Object.hasOwn(args, key)) {
      throw new Error(`Unknown or duplicate argument: ${key}`);
    }
    const value = rest.length ? rest.join("=") : argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args["--scope"] || !args["--full-scope"] || !args["--output"]) {
    throw new Error("--scope, --full-scope, and --output are required");
  }
  const [scope, fullScope] = await Promise.all([
    readFile(args["--scope"], "utf8").then(JSON.parse),
    readFile(args["--full-scope"], "utf8").then(JSON.parse),
  ]);
  const audit = auditScope(scope, fullScope);
  const report = renderScopeSummary(scope, fullScope, { executionTier: args["--execution-tier"], audit });
  await mkdir(dirname(resolve(args["--output"])), { recursive: true });
  await writeFile(resolve(args["--output"]), report);
  console.log(report);
  if (!audit.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
