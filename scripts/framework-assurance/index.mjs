#!/usr/bin/env node
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AssuranceError, parseJson, readBoundFile, requireCondition } from "./manifest.mjs";
import { preflight } from "./preflight.mjs";
import { calibrate } from "./evidence.mjs";
import { buildReport, compareBundles, observationBundle, parseObservationBundle, renderReportMarkdown } from "./report.mjs";
import { prepareOutputDir, publishFile, publishJson } from "./output.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HELP = `Usage: node scripts/framework-assurance/index.mjs <command> [options]

Commands:
  preflight       Verify the frozen suite, artifacts and local source pins.
  calibrate       Grade synthetic positive/negative/missing-evidence controls.
  report          Summarize offline observations; never dispatches tasks.
  sdk-consumer    Pack and verify the real SDK in an external consumer.

Options:
  --suite <path>       Suite path relative to fixtures/framework-assurance.
  --input <path>       Offline observations JSON for report.
  --compare <path>     Optional second offline observations JSON.
  --variable <name>    model or executionStrategy; only with --compare.
  --output <dir>       Output outside the checkout; defaults to a new temp dir.
  --help              Print this message.

No command calls a Provider or starts a daemon. Live task evidence is not accepted.
`;

async function readBundle(path) {
  const absolute = resolve(path);
  return parseObservationBundle(parseJson((await readBoundFile(dirname(absolute), basename(absolute))).bytes));
}

export async function runCli(args, { repoRoot = REPO_ROOT, signal } = {}) {
  const parsed = parseArgs({ args, strict: true, allowPositionals: true,
    options: { suite: { type: "string" }, input: { type: "string" }, compare: { type: "string" }, variable: { type: "string" },
      output: { type: "string" }, help: { type: "boolean", short: "h" } } });
  const { values, positionals } = parsed;
  if (values.help) return { exitCode: 0, text: HELP };
  requireCondition(positionals.length === 1 && ["preflight", "calibrate", "report", "sdk-consumer"].includes(positionals[0]),
    "invalid_arguments", "Choose exactly one supported command; see --help.");
  const command = positionals[0];
  const allowed = { preflight: ["suite", "output"], calibrate: ["suite", "output"], report: ["input", "compare", "variable", "output"], "sdk-consumer": ["output"] }[command];
  requireCondition(Object.keys(values).every(key => allowed.includes(key)), "invalid_arguments", "Option is not valid for this command.");
  requireCondition(command !== "report" || Boolean(values.input), "invalid_arguments", "report requires --input observations.json.");
  requireCondition(!values.variable || Boolean(values.compare), "invalid_arguments", "--variable requires --compare.");
  requireCondition(!values.variable || ["model", "executionStrategy"].includes(values.variable),
    "invalid_arguments", "--variable must be model or executionStrategy.");
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
  }
  const outputDir = await prepareOutputDir(repoRoot, values.output);
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
