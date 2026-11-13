import { createServer } from "node:net";
import { availableParallelism, freemem, loadavg } from "node:os";
import { lstat, realpath, readdir, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  artifactRef,
  digest,
  exactObject,
  identifier,
  parseJson,
  parseSuite,
  readBoundFile,
  requireCondition,
  sha256,
} from "./manifest.mjs";
import { preflight as suitePreflight } from "./preflight.mjs";

export const DEFAULT_TRIAL = "trials/t01-review.json";
export const DEFAULT_TRIAL_BYTE_DIGEST = "9943876f54f1b7b827e69ab0fe35df6f7dbb8dac414fa96e1fc3e2376e071601";

const PATH_KEYS = ["lingStackHome", "workspace", "output"];
const PORT_KEYS = ["daemon", "ui"];
const INVALID_PROVIDER_IDS = new Set(["auto", "default", "pending", "unassigned", "unknown"]);
const INPUT_DIGEST_KEYS = ["suiteBytes", "taskBytes", "promptBytes", "ruleBytes", "expectedBytes", "profileBytes", "lockBytes"];
const TRUSTED_TASK = Object.freeze({ suiteId: "ling-framework-assurance", suiteVersion: "6", taskId: "T01", taskVersion: "5",
  sourceCommit: "dd3fa912a09f0494c9899090e861dfa2058e5553" });
const TRUSTED_PROVIDER = Object.freeze({ providerId: "review-only-provider", modelId: "review-only-model" });

function boundedInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  requireCondition(Number.isSafeInteger(value) && value >= min && value <= max, "invalid_manifest", `${label} must be a bounded integer.`);
  return value;
}

function resourcePath(value, label) {
  requireCondition(typeof value === "string" && value.length >= 1 && value.length <= 1024
    && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== ".."
      && ![".git", ".ling-stack", "node_modules"].includes(part)),
  "invalid_manifest", `${label} must be a portable relative resource path.`);
  return value;
}

function parseInputDigests(value) {
  exactObject(value, INPUT_DIGEST_KEYS, "trial input digests");
  for (const key of INPUT_DIGEST_KEYS) digest(value[key], `trial input digest ${key}`);
  return value;
}

function parseProvider(value) {
  exactObject(value, ["providerId", "modelId"], "trial provider");
  identifier(value.providerId, "provider id");
  identifier(value.modelId, "model id");
  requireCondition(!INVALID_PROVIDER_IDS.has(value.providerId) && !INVALID_PROVIDER_IDS.has(value.modelId),
    "invalid_manifest", "Provider and model must be explicitly selected.");
  return value;
}

function parseBudget(value) {
  exactObject(value, ["maxAmountMinor", "currency", "maxProviderRequests", "maxInputTokens", "maxOutputTokens",
    "maxToolLoops", "maxSubagents", "maxGraderCalls", "maxInFlightReservations", "timeoutMs"], "trial budget");
  boundedInteger(value.maxAmountMinor, "maximum amount in minor currency units", { max: 1_000_000_000 });
  requireCondition(typeof value.currency === "string" && /^[A-Z]{3}$/.test(value.currency), "invalid_manifest", "Trial currency must be an ISO-like uppercase code.");
  boundedInteger(value.maxProviderRequests, "maximum Provider requests", { max: 1000 });
  boundedInteger(value.maxInputTokens, "maximum input tokens", { min: 1, max: 100_000_000 });
  boundedInteger(value.maxOutputTokens, "maximum output tokens", { min: 1, max: 100_000_000 });
  boundedInteger(value.maxToolLoops, "maximum tool loops", { max: 1000 });
  boundedInteger(value.maxSubagents, "maximum sub-agents", { max: 100 });
  boundedInteger(value.maxGraderCalls, "maximum grader calls", { max: 1000 });
  boundedInteger(value.maxInFlightReservations, "maximum in-flight reservations", { min: 1, max: 100 });
  boundedInteger(value.timeoutMs, "trial timeout", { min: 1, max: 3_600_000 });
  return value;
}

function parseStopRules(value) {
  exactObject(value, ["unknownUsage", "unknownEffect", "cancelUnconfirmed", "overBudget", "retryAfterUnknown"], "trial stop rules");
  requireCondition(value.unknownUsage === "stop" && value.unknownEffect === "stop"
    && value.cancelUnconfirmed === "block" && value.overBudget === "stop" && value.retryAfterUnknown === "forbid",
  "invalid_manifest", "Trial stop rules must fail closed on unknown state.");
  return value;
}

function parseAdmission(value) {
  exactObject(value, ["hostProfile", "toolBrokerMode", "network", "shell", "requiresFence", "requiresTerminalClaim",
    "requiresConfirmedStop", "executionAuthorized"], "trial admission");
  requireCondition(value.hostProfile === "pi_host_isolated_files_v1" && value.toolBrokerMode === "enforce"
    && value.network === false && value.shell === false && value.requiresFence === true
    && value.requiresTerminalClaim === true && value.requiresConfirmedStop === true
    && value.executionAuthorized === false, "invalid_manifest", "Trial admission must use the isolated fail-closed profile.");
  return value;
}

function parsePort(value, label) {
  exactObject(value, ["host", "port"], label);
  requireCondition(["127.0.0.1", "::1"].includes(value.host), "invalid_manifest", `${label} must bind only to loopback.`);
  boundedInteger(value.port, `${label} port`, { min: 1024, max: 65535 });
  return value;
}

function parseResources(value) {
  exactObject(value, ["rootPolicy", "paths", "ports", "minimum"], "trial resources");
  requireCondition(value.rootPolicy === "external_absolute_cli", "invalid_manifest", "Trial resource root must be supplied as an external absolute path.");
  exactObject(value.paths, PATH_KEYS, "trial resource paths");
  for (const key of PATH_KEYS) resourcePath(value.paths[key], `trial resource path ${key}`);
  exactObject(value.ports, PORT_KEYS, "trial ports");
  for (const key of PORT_KEYS) parsePort(value.ports[key], `trial ${key} port`);
  requireCondition(value.ports.daemon.port !== value.ports.ui.port, "invalid_manifest", "Daemon and UI ports must be distinct.");
  exactObject(value.minimum, ["availableParallelism", "freeMemoryBytes", "freeDiskBytes", "maxLoad1"], "trial resource minimums");
  boundedInteger(value.minimum.availableParallelism, "minimum parallelism", { min: 1, max: 1024 });
  boundedInteger(value.minimum.freeMemoryBytes, "minimum free memory", { min: 1, max: Number.MAX_SAFE_INTEGER });
  boundedInteger(value.minimum.freeDiskBytes, "minimum free disk", { min: 1, max: Number.MAX_SAFE_INTEGER });
  requireCondition(typeof value.minimum.maxLoad1 === "number" && Number.isFinite(value.minimum.maxLoad1)
    && value.minimum.maxLoad1 >= 0 && value.minimum.maxLoad1 <= 100_000, "invalid_manifest", "Maximum load must be finite and bounded.");
  return value;
}

export function parseTrialManifest(value) {
  exactObject(value, ["schemaVersion", "kind", "trialId", "mode", "task", "provider", "budget", "stopRules", "admission", "resources"], "trial manifest");
  requireCondition(value.schemaVersion === 1 && value.kind === "f3b_trial_manifest" && value.mode === "review_only",
    "invalid_manifest", "Unsupported trial manifest schema or mode.");
  identifier(value.trialId, "trial id");
  exactObject(value.task, ["suite", "suiteId", "suiteVersion", "taskId", "taskVersion", "sourceCommit", "inputDigests"], "trial task");
  artifactRef(value.task.suite);
  requireCondition(value.task.suite.mediaType === "application/json", "invalid_manifest", "Trial suite must be JSON.");
  for (const key of ["suiteId", "suiteVersion", "taskId", "taskVersion"]) identifier(value.task[key], `trial task ${key}`);
  requireCondition(typeof value.task.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(value.task.sourceCommit),
    "invalid_manifest", "Trial source commit must be frozen.");
  parseInputDigests(value.task.inputDigests);
  parseProvider(value.provider);
  parseBudget(value.budget);
  parseStopRules(value.stopRules);
  parseAdmission(value.admission);
  parseResources(value.resources);
  return value;
}

function isInside(root, child) {
  const childPath = relative(root, child);
  return childPath !== "" && childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath);
}

function pathDigest(path) {
  return sha256(Buffer.from(path));
}

function pathOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function canonicalizeMissingPath(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try {
      const canonical = await realpath(current);
      return resolve(canonical, ...missing);
    } catch (error) {
      if (error.code !== "ENOENT" || current === dirname(current)) throw error;
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}

async function inspectResourcePath(root, relativePath, role) {
  const target = resolve(root, relativePath);
  requireCondition(isInside(root, target), "unsafe_resource_path", "Trial resource path escapes its external root.");
  let current = root;
  let missing = false;
  for (const [index, part] of relativePath.split("/").entries()) {
    current = resolve(current, part);
    if (missing) continue;
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code === "ENOENT") { missing = true; continue; }
      return { role, pathDigest: pathDigest(target), state: "blocked", blocker: "resource_stat_failed" };
    }
    if (stat.isSymbolicLink()) return { role, pathDigest: pathDigest(target), state: "blocked", blocker: "resource_symlink" };
    if (index < relativePath.split("/").length - 1 && !stat.isDirectory()) {
      return { role, pathDigest: pathDigest(target), state: "blocked", blocker: "resource_parent_not_directory" };
    }
    if (index === relativePath.split("/").length - 1) {
      if (!stat.isDirectory()) return { role, pathDigest: pathDigest(target), state: "blocked", blocker: "resource_not_directory" };
      let entries;
      try { entries = await readdir(current); }
      catch { return { role, pathDigest: pathDigest(target), state: "blocked", blocker: "resource_read_failed" }; }
      return { role, pathDigest: pathDigest(target), state: entries.length === 0 ? "empty_directory" : "nonempty_directory",
        blocker: entries.length === 0 ? null : "resource_directory_not_empty" };
    }
  }
  return { role, pathDigest: pathDigest(target), state: "missing", blocker: null };
}

async function probeLoopbackPort({ host, port }) {
  return new Promise(resolveProbe => {
    const server = createServer();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* The probe may already be closed. */ }
      resolveProbe(result);
    };
    server.once("error", error => finish({ available: false, blocker: error?.code === "EADDRINUSE" ? "port_in_use" : "port_probe_failed" }));
    server.listen({ host, port }, () => server.close(() => finish({ available: true, blocker: null })));
  });
}

async function measureResources(root) {
  const filesystem = await statfs(root, { bigint: true });
  const freeDisk = filesystem.bavail * filesystem.bsize;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return {
    availableParallelism: availableParallelism(),
    freeMemoryBytes: freemem(),
    freeDiskBytes: Number(freeDisk > maxSafe ? maxSafe : freeDisk),
    load1: loadavg()[0],
  };
}

function check(checks, id, passed, blocker, observed) {
  checks.push({ id, status: passed ? "pass" : "blocked", blocker: passed ? null : blocker, observed });
}

async function readTrial({ fixtureRoot, trialPath }) {
  const file = await readBoundFile(fixtureRoot, trialPath);
  requireCondition(trialPath === DEFAULT_TRIAL, "invalid_manifest", "Only the committed T01 review manifest is supported.");
  requireCondition(file.sha256 === DEFAULT_TRIAL_BYTE_DIGEST, "artifact_digest_mismatch", "Trial manifest is not the reviewed committed input.");
  return { manifest: parseTrialManifest(parseJson(file.bytes, "trial manifest")), manifestByteDigest: file.sha256 };
}

async function verifyFrozenInputs({ repoRoot, fixtureRoot, manifest }) {
  for (const key of Object.keys(TRUSTED_TASK)) {
    requireCondition(manifest.task[key] === TRUSTED_TASK[key], "invalid_manifest", "Trial identity is not the reviewed T01 task.");
  }
  requireCondition(manifest.provider.providerId === TRUSTED_PROVIDER.providerId && manifest.provider.modelId === TRUSTED_PROVIDER.modelId,
    "invalid_manifest", "Trial Provider and model are not the reviewed no-call identities.");
  const suiteFile = await readBoundFile(fixtureRoot, manifest.task.suite.path);
  requireCondition(suiteFile.sha256 === manifest.task.suite.sha256, "artifact_digest_mismatch", "Trial suite digest does not match its frozen reference.");
  const checked = await suitePreflight({ repoRoot, fixtureRoot, suitePath: manifest.task.suite.path });
  requireCondition(checked.suite.suiteId === manifest.task.suiteId && checked.suite.suiteVersion === manifest.task.suiteVersion,
    "invalid_manifest", "Trial suite identity does not match the frozen task.");
  const item = checked.tasks.find(entry => entry.task.taskId === manifest.task.taskId);
  requireCondition(item && item.task.taskVersion === manifest.task.taskVersion && item.task.category === "analysis_readonly",
    "invalid_manifest", "Trial task identity is not the frozen read-only T01 task.");
  const actual = {
    suiteBytes: checked.suiteByteDigest,
    taskBytes: item.taskByteDigest,
    promptBytes: item.task.prompt.sha256,
    ruleBytes: item.task.ruleCase.sha256,
    expectedBytes: item.task.expected.sha256,
    profileBytes: item.task.validationProfile.artifact.sha256,
    lockBytes: item.task.source.lockSha256,
  };
  for (const key of INPUT_DIGEST_KEYS) requireCondition(actual[key] === manifest.task.inputDigests[key], "artifact_digest_mismatch", `Trial input ${key} is not frozen to the suite.`);
  requireCondition(item.task.source.commit === manifest.task.sourceCommit, "invalid_manifest", "Trial source commit does not match the task source.");
  return { suite: checked.suite, task: item.task, inputDigests: actual };
}

async function inspectResources({ repoRoot, manifest, resourceRoot, reportOutputDir, probePort = probeLoopbackPort, measure = measureResources }) {
  const checks = [];
  const rootPath = resolve(resourceRoot);
  let canonicalRoot = rootPath;
  try { canonicalRoot = await canonicalizeMissingPath(rootPath); }
  catch { /* The directory check below records an honest blocked result. */ }
  const rootRelative = relative(await realpath(repoRoot), canonicalRoot);
  const rootOutsideCheckout = rootRelative === ".." || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative);
  check(checks, "resource_root_outside_checkout", rootOutsideCheckout, "resource_root_inside_checkout", { pathDigest: pathDigest(canonicalRoot) });
  const rootReserved = canonicalRoot.split(sep).some(part => [".git", ".ling-stack", "node_modules"].includes(part));
  check(checks, "resource_root_not_reserved", !rootReserved, "resource_root_reserved", { pathDigest: pathDigest(canonicalRoot) });
  let rootStat;
  try { rootStat = await lstat(rootPath); }
  catch (error) { rootStat = error.code === "ENOENT" ? null : undefined; }
  check(checks, "resource_root_directory", Boolean(rootStat?.isDirectory() && !rootStat.isSymbolicLink()),
    rootStat === null ? "resource_root_missing" : "resource_root_not_directory", { pathDigest: pathDigest(canonicalRoot) });
  if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
    try { canonicalRoot = await realpath(rootPath); }
    catch { canonicalRoot = rootPath; }
  }
  const resourcePaths = {};
  if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
    for (const role of PATH_KEYS) resourcePaths[role] = await inspectResourcePath(canonicalRoot, manifest.resources.paths[role], role);
    for (const left of PATH_KEYS) for (const right of PATH_KEYS) {
      if (left >= right) continue;
      const leftPath = resolve(canonicalRoot, manifest.resources.paths[left]);
      const rightPath = resolve(canonicalRoot, manifest.resources.paths[right]);
      if (pathOverlap(leftPath, rightPath)) {
        check(checks, `resource_paths_distinct_${left}_${right}`, false, "resource_path_conflict", { left, right });
      }
    }
  } else {
    for (const role of PATH_KEYS) resourcePaths[role] = { role, pathDigest: pathDigest(resolve(canonicalRoot, manifest.resources.paths[role])), state: "not_checked", blocker: "resource_root_unavailable" };
  }
  for (const role of PATH_KEYS) {
    const item = resourcePaths[role];
    check(checks, `resource_path_${role}`, item.state === "missing" || item.state === "empty_directory", item.blocker, {
      pathDigest: item.pathDigest, state: item.state,
    });
  }
  const homePath = resolve(canonicalRoot, manifest.resources.paths.lingStackHome);
  const configuredHome = process.env.LING_STACK_HOME;
  let canonicalConfiguredHome;
  if (typeof configuredHome === "string" && isAbsolute(configuredHome)) {
    try { canonicalConfiguredHome = await canonicalizeMissingPath(configuredHome); }
    catch { canonicalConfiguredHome = undefined; }
  }
  const envMatches = canonicalConfiguredHome === homePath;
  check(checks, "ling_stack_home_is_independent", envMatches, configuredHome === undefined ? "ling_stack_home_unset" : "ling_stack_home_mismatch", {
    configured: configuredHome === undefined ? "unset" : "set", expectedDigest: pathDigest(homePath),
  });
  const reportPath = await canonicalizeMissingPath(reportOutputDir);
  const reportSeparated = !PATH_KEYS.some(role => pathOverlap(reportPath, resolve(canonicalRoot, manifest.resources.paths[role])))
    && !pathOverlap(reportPath, canonicalRoot);
  check(checks, "report_output_is_separate", reportSeparated, "report_output_conflict", { pathDigest: pathDigest(reportPath) });
  const ports = {};
  for (const role of PORT_KEYS) {
    const port = manifest.resources.ports[role];
    ports[role] = await probePort(port);
    check(checks, `port_${role}_available`, ports[role].available, ports[role].blocker, { host: port.host, port: port.port });
  }
  let measured;
  if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
    try { measured = await measure(canonicalRoot); }
    catch { measured = null; }
  }
  check(checks, "resource_capacity", Boolean(measured
    && measured.availableParallelism >= manifest.resources.minimum.availableParallelism
    && measured.freeMemoryBytes >= manifest.resources.minimum.freeMemoryBytes
    && measured.freeDiskBytes >= manifest.resources.minimum.freeDiskBytes
    && measured.load1 <= manifest.resources.minimum.maxLoad1),
  measured ? "resource_capacity_below_minimum" : "resource_measurement_failed", measured ?? { state: "unavailable" });
  return { checks, rootPathDigest: pathDigest(canonicalRoot), resourcePaths, ports, measured };
}

/**
 * @param {{repoRoot: string, fixtureRoot: string, trialPath?: string, resourceRoot: string, reportOutputDir: string,
 *   probePort?: (input: {host: string, port: number}) => Promise<{available: boolean, blocker: string | null}>,
 *   measureResourcesFn?: (root: string) => Promise<{availableParallelism: number, freeMemoryBytes: number, freeDiskBytes: number, load1: number}>}} options
 */
export async function trialPreflight({ repoRoot, fixtureRoot, trialPath = DEFAULT_TRIAL, resourceRoot, reportOutputDir,
  probePort = probeLoopbackPort, measureResourcesFn = measureResources }) {
  requireCondition(typeof resourceRoot === "string" && isAbsolute(resourceRoot), "invalid_arguments", "trial-preflight requires an absolute --resource-root.");
  requireCondition(typeof reportOutputDir === "string" && isAbsolute(reportOutputDir), "invalid_arguments", "trial-preflight requires an absolute report output directory.");
  const { manifest, manifestByteDigest } = await readTrial({ fixtureRoot, trialPath });
  const frozen = await verifyFrozenInputs({ repoRoot, fixtureRoot, manifest });
  const resources = await inspectResources({ repoRoot, manifest, resourceRoot, reportOutputDir, probePort, measure: measureResourcesFn });
  const blockers = [...new Set(resources.checks.filter(item => item.status === "blocked").map(item => item.blocker))];
  const status = blockers.length === 0 ? "ready-for-review" : "blocked";
  return {
    schemaVersion: 1,
    kind: "trial_preflight",
    status,
    trialId: manifest.trialId,
    manifestByteDigest,
    task: {
      suiteId: manifest.task.suiteId,
      suiteVersion: manifest.task.suiteVersion,
      taskId: manifest.task.taskId,
      taskVersion: manifest.task.taskVersion,
      sourceCommit: manifest.task.sourceCommit,
      inputDigests: frozen.inputDigests,
      requiredEvidence: frozen.task.requiredEvidence,
    },
    provider: manifest.provider,
    budget: manifest.budget,
    stopRules: manifest.stopRules,
    admission: { ...manifest.admission, executionAuthorized: false },
    resources: {
      rootPathDigest: resources.rootPathDigest,
      paths: Object.fromEntries(PATH_KEYS.map(role => [role, resources.resourcePaths[role]])),
      ports: resources.ports,
      measured: resources.measured,
    },
    checks: resources.checks,
    blockers,
    executionAuthorized: false,
    externalProviderCalls: 0,
    ordinaryRunsDispatched: 0,
    userStoresInitialized: 0,
    taskCodeExecuted: false,
  };
}

export function renderTrialPreflightMarkdown(report) {
  const lines = [
    "# Trial preflight",
    "",
    `- Status: **${report.status}**`,
    `- Trial: \`${report.trialId}\``,
    `- Task: \`${report.task.taskId}@${report.task.taskVersion}\``,
    `- Provider/model: \`${report.provider.providerId}\` / \`${report.provider.modelId}\``,
    `- Execution authorized: \`${report.executionAuthorized}\``,
    "",
    "| Check | Status | Blocker |",
    "| --- | --- | --- |",
    ...report.checks.map(item => `| ${item.id} | ${item.status} | ${item.blocker ?? ""} |`),
    "",
    `Blockers: ${report.blockers.length === 0 ? "none" : report.blockers.join(", ")}`,
    "",
    "This report is a zero-dispatch preflight; it does not authorize a Provider, model, Run, Store, daemon, or paid task.",
    "",
  ];
  return lines.join("\n");
}
