#!/usr/bin/env node
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AssuranceError, parseJson, readBoundFile, requireCondition } from "./manifest.mjs";
import { preflight } from "./preflight.mjs";
import { DEFAULT_TRIAL, renderTrialPreflightMarkdown, trialPreflight } from "./trial-preflight.mjs";
import { assessHostReadiness, renderHostReadinessMarkdown } from "./host-readiness.mjs";
import { calibrate } from "./evidence.mjs";
import { buildReport, compareBundles, observationBundle, parseObservationBundle, renderReportMarkdown } from "./report.mjs";
import { prepareOutputDir, publishFile, publishJson } from "./output.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HELP = `Usage: node scripts/framework-assurance/index.mjs <command> [options]

Commands:
  preflight       Verify the frozen suite, artifacts and local source pins.
  calibrate       Grade synthetic positive/negative/missing-evidence controls.
  report          Summarize offline observations; never dispatches tasks.
  trial-preflight Check one frozen T01 trial manifest and external resources.
  host-readiness  Assess a complete read-only Host evidence projection.
  sdk-consumer    Pack and verify the real SDK in an external consumer.

Options:
  --suite <path>       Suite path relative to fixtures/framework-assurance.
  --trial <path>       Trial manifest relative to fixtures/framework-assurance.
  --resource-root <path>
                       External absolute root for trial runtime resources.
  --input <path>       Offline observations or captured Host evidence JSON.
  --compare <path>     Optional second offline observations JSON.
  --variable <name>    model or executionStrategy; only with --compare.
  --output <dir>       Output outside the checkout; defaults to a new temp dir.
  --help              Print this message.

No command calls a Provider or starts a daemon. Host readiness reads a captured
read-only evidence projection and never grants execution authority.
`;

async function readBundle(path) {
  const absolute = resolve(path);
  return parseObservationBundle(parseJson((await readBoundFile(dirname(absolute), basename(absolute))).bytes));
}

async function readJson(path, label) {
  const absolute = resolve(path);
  return parseJson((await readBoundFile(dirname(absolute), basename(absolute))).bytes, label);
}

/**
 * @param {string[]} args
 * @param {{repoRoot?: string, fixtureRoot?: string, signal?: AbortSignal,
 *   probePort?: (input: {host: string, port: number}) => Promise<{available: boolean, blocker: string | null}>}} [options]
 */
export async function runCli(args, { repoRoot = REPO_ROOT, fixtureRoot = resolve(repoRoot, "fixtures/framework-assurance"), signal, probePort } = {}) {
  const parsed = parseArgs({ args, strict: true, allowPositionals: true,
    options: { suite: { type: "string" }, trial: { type: "string" }, "resource-root": { type: "string" }, input: { type: "string" },
      compare: { type: "string" }, variable: { type: "string" }, output: { type: "string" }, help: { type: "boolean", short: "h" } } });
  const { values, positionals } = parsed;
  if (values.help) return { exitCode: 0, text: HELP };
  requireCondition(positionals.length === 1 && ["preflight", "calibrate", "report", "trial-preflight", "host-readiness", "sdk-consumer"].includes(positionals[0]),
    "invalid_arguments", "Choose exactly one supported command; see --help.");
  const command = positionals[0];
  const allowed = { preflight: ["suite", "output"], calibrate: ["suite", "output"], report: ["input", "compare", "variable", "output"],
    "trial-preflight": ["trial", "resource-root", "output"], "host-readiness": ["input", "output"], "sdk-consumer": ["output"] }[command];
  requireCondition(Object.keys(values).every(key => allowed.includes(key)), "invalid_arguments", "Option is not valid for this command.");
  requireCondition(command !== "report" || Boolean(values.input), "invalid_arguments", "report requires --input observations.json.");
  requireCondition(command !== "trial-preflight" || Boolean(values["resource-root"]), "invalid_arguments", "trial-preflight requires --resource-root.");
  requireCondition(command !== "host-readiness" || Boolean(values.input), "invalid_arguments", "host-readiness requires --input evidence.json.");
  requireCondition(!values.variable || Boolean(values.compare), "invalid_arguments", "--variable requires --compare.");
  requireCondition(!values.variable || ["model", "executionStrategy"].includes(values.variable),
    "invalid_arguments", "--variable must be model or executionStrategy.");
  const outputDir = await prepareOutputDir(repoRoot, values.output);
  let result; const files = {};
  if (command === "preflight") {
    const checked = await preflight({ repoRoot, suitePath: values.suite });
    result = { schemaVersion: 1, kind: checked.kind, suiteId: checked.suite.suiteId, suiteVersion: checked.suite.suiteVersion,
      suiteByteDigest: checked.suiteByteDigest, taskCount: checked.tasks.length,
      tasks: checked.tasks.map(({ task, taskByteDigest }) => ({ taskId: task.taskId, taskVersion: task.taskVersion,
        taskByteDigest, provenance: task.provenance.kind, sourceCommit: task.source.commit })),
      graderSourceDigests: checked.graderSourceDigests, externalProviderCalls: 0, ordinaryRunsDispatched: 0,
      userStoresInitialized: 0, taskCodeExecuted: false };
  } else if (command === "calibrate") {
    result = await calibrate({ repoRoot, suitePath: values.suite });
  } else if (command === "report") {
    const bundle = await readBundle(values.input);
    result = values.compare ? compareBundles(bundle, await readBundle(values.compare), values.variable ?? null) : buildReport(bundle);
  } else if (command === "trial-preflight") {
    result = await trialPreflight({ repoRoot, fixtureRoot, trialPath: values.trial ?? DEFAULT_TRIAL,
      resourceRoot: values["resource-root"], reportOutputDir: outputDir, probePort });
  } else if (command === "host-readiness") {
    result = assessHostReadiness(await readJson(values.input, "captured Host evidence"));
  }
  if (command === "sdk-consumer") {
    const { runSdkConsumer } = await import("./sdk-consumer.mjs");
    const { reportPath, ...report } = await runSdkConsumer({ repoRoot, outputDir, signal });
    result = report;
    if (reportPath) files.consumerReport = reportPath;
  }
  files.result = await publishJson(outputDir, `${command}.json`, result);
  if (command === "calibrate") {
    const bundle = observationBundle(result); const report = buildReport(bundle);
    files.observations = await publishJson(outputDir, "observations.json", bundle);
    files.report = await publishJson(outputDir, "report.json", report);
    files.markdown = await publishFile(outputDir, "report.md", renderReportMarkdown(report));
  } else if (command === "report" && result.kind === "offline_assurance_report") {
    files.markdown = await publishFile(outputDir, "report.md", renderReportMarkdown(result));
  } else if (command === "trial-preflight") {
    files.markdown = await publishFile(outputDir, "trial-preflight.md", renderTrialPreflightMarkdown(result));
  } else if (command === "host-readiness") {
    files.markdown = await publishFile(outputDir, "host-readiness.md", renderHostReadinessMarkdown(result));
  }
  return { exitCode: result.status === "blocked" ? 2 : result.passed === false ? 1 : 0,
    text: `${JSON.stringify({ command, passed: result.passed ?? null, outputDir, files })}\n` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const listeners = ["SIGINT", "SIGTERM"].map(name => {
    const listener = () => controller.abort(name);
    process.on(name, listener);
    return [name, listener];
  });
  try {
    const result = await runCli(process.argv.slice(2), { signal: controller.signal });
    process.stdout.write(result.text); process.exitCode = result.exitCode;
  } catch (error) {
    // Do not print filesystem or transport causes containing private paths or credentials.
    const code = error instanceof AssuranceError ? error.code
      : typeof error?.code === "string" && error.code.startsWith("ERR_PARSE_ARGS") ? "invalid_arguments" : "assurance_failed";
    process.stderr.write(`${JSON.stringify({ code, message: error instanceof AssuranceError ? error.message : "Assurance input or environment could not be processed; no task was dispatched." })}\n`);
    process.exitCode = 2;
  } finally {
    for (const [name, listener] of listeners) process.removeListener(name, listener);
    if (controller.signal.aborted) process.exitCode = controller.signal.reason === "SIGINT" ? 130 : 143;
  }
}
