import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { verifyGstackShellResourcePrerequisites } from "./verify-shell-resource-prerequisites.mjs";

const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const fail = reason => { throw new Error(`gstack_shell_ast_${reason}`); };
const readRecord = (path, options = {}) => readGstackClosureFileRecord(path, { ...options, errorPrefix: "gstack_shell_ast" });
const dynamicEvaluators = new Set(["eval", "bash", "sh", "zsh", "dash", "ksh"]);
const partKinds = new Set(["Lit", "SglQuoted", "DblQuoted", "ParamExp", "CmdSubst", "ArithmExp", "ProcSubst", "ExtGlob", "BraceExp"]);
const toolPaths = ["inspect-shell-call-sites.mjs", "verify-shell-resource-prerequisites.mjs", "verify-shared-command-closure.mjs",
  "shell-ast/main.go", "shell-ast/go.mod", "shell-ast/go.sum", "shell-ast/THIRD-PARTY-NOTICES"];

// Inventory actual syntax without evaluating source, resolving variables, or
// granting dependency/runtime acceptance to any static call site.
export async function inspectGstackShellCallSites(options) {
  const { parserPath, expectedParserChecksum, parserTimeoutMs = 10_000 } = options;
  if (!validChecksum(expectedParserChecksum)) fail("parser_checksum_required");
  if (typeof parserPath !== "string" || !isAbsolute(parserPath)) fail("parser_required");
  if (!Number.isSafeInteger(parserTimeoutMs) || parserTimeoutMs < 1 || parserTimeoutMs > 30_000) fail("timeout_invalid");
  const executable = resolve(parserPath), parser = await readRecord(executable);
  if (parser.checksum !== expectedParserChecksum) fail("parser_mismatch");
  const toolInputs = [];
  for (const path of toolPaths) {
    const record = await readRecord(fileURLToPath(new URL(`./${path}`, import.meta.url)));
    toolInputs.push({ path, checksum: record.checksum, sizeBytes: record.sizeBytes });
  }
  const prerequisite = await verifyGstackShellResourcePrerequisites(options);
  const root = await realpath(resolve(options.runtimeRoot)), sources = new Map();
  let totalBytes = 0;
  for (const script of prerequisite.scripts) {
    const source = await readRecord(join(root, script.path), { retain: true, maximumBytes: 2 * 1024 * 1024 });
    if (source.checksum !== script.checksum || source.sizeBytes !== script.sizeBytes) fail("source_changed");
    totalBytes += source.sizeBytes;
    if (totalBytes > 48 * 1024 * 1024) fail("input_budget_exceeded");
    sources.set(script.path, source);
  }
  const request = Buffer.from(JSON.stringify({ schemaVersion: 1, scripts: [...sources].map(([path, source]) => ({
    path, bytesBase64: source.bytes.toString("base64"),
  })) }));
  if (request.length > 64 * 1024 * 1024) fail("input_budget_exceeded");
  const home = await realpath(await mkdtemp(join(tmpdir(), "ling shell AST ")));
  let parsed;
  try {
    const env = { HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home, CI: "1" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const run = spawnSync(executable, [], { cwd: home, env, input: request,
      timeout: parserTimeoutMs, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" });
    if (run.error || run.signal || run.status !== 0) fail(`parser_failed:${run.error?.code ?? run.signal ?? run.status}`);
    try { parsed = JSON.parse(run.stdout.toString("utf8")); }
    catch { fail("parser_report_invalid"); }
  } finally { await rm(home, { recursive: true, force: true }); }
  validateReport(parsed, sources);
  for (const [path, expected] of sources) {
    const actual = await readRecord(join(root, path));
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) fail("source_changed");
  }
  if ((await readRecord(executable)).checksum !== parser.checksum) fail("parser_changed");
  for (const tool of toolInputs) {
    const actual = await readRecord(fileURLToPath(new URL(`./${tool.path}`, import.meta.url)));
    if (actual.checksum !== tool.checksum || actual.sizeBytes !== tool.sizeBytes) fail("tool_changed");
  }
  const manifestPath = join(dirname(root), "source-manifest.json");
  if ((await readRecord(manifestPath, { maximumBytes: 16 * 1024 * 1024 })).checksum !== prerequisite.sourceManifestChecksum) fail("manifest_changed");
  const sites = parsed.scripts.flatMap(script => script.calls.map(call => ({ consumerPath: script.path,
    consumerChecksum: script.checksum, ...call })));
  const sourceSites = sites.filter(site => ["source", "."].includes(site.arguments[0].literal));
  const dynamicEvaluationSites = sites.filter(site => site.arguments[0].literal === "eval" ||
    dynamicEvaluators.has(site.arguments[0].literal) && site.arguments.some(argument => argument.literal === "-c"));
  const unresolvedCommandSites = sites.filter(site => site.arguments[0].literal === null);
  return { schemaVersion: 1, deliveryStage: "resource-prerequisites", validationMode: "parse-only",
    dependencyClosure: "pending", hostAcceptance: "pending", packageAcceptance: "pending", releaseEligible: false,
    upstreamRevision: prerequisite.upstreamRevision, sourceManifestChecksum: prerequisite.sourceManifestChecksum,
    inventoryChecksum: prerequisite.inventoryChecksum, buildHost: prerequisite.buildHost,
    parser: { name: parsed.parser, version: parsed.parserVersion, dialect: parsed.dialect, checksum: parser.checksum },
    toolInputs, toolInputGraphChecksum: checksum(JSON.stringify(toolInputs)),
    shellPrerequisiteChecksum: checksum(JSON.stringify(prerequisite)), scripts: parsed.scripts,
    callGraphChecksum: checksum(JSON.stringify(parsed.scripts)), sourceSites,
    sourceSiteGraphChecksum: checksum(JSON.stringify(sourceSites)), dynamicEvaluationSites, unresolvedCommandSites,
    pendingGates: ["review-every-source-and-dynamic-call-site", "complete-shell-and-dynamic-resource-closure",
      "runtime-shell-adaptation", "redistribution-review", "native-windows-validation", "real-skill-execution", "installed-client-acceptance"] };
}

function validateReport(report, sources) {
  if (report?.schemaVersion !== 1 || report.parser !== "mvdan.cc/sh/v3/syntax" || report.parserVersion !== "v3.14.1" ||
    report.dialect !== "bash" || report.validationMode !== "parse-only" || !Array.isArray(report.scripts) || report.scripts.length !== sources.size) fail("parser_report_invalid");
  const paths = [...sources.keys()];
  let totalCalls = 0;
  for (const [index, script] of report.scripts.entries()) {
    const source = sources.get(script.path);
    if (!source || script.path !== paths[index] || script.checksum !== source.checksum ||
      script.sizeBytes !== source.sizeBytes || !Array.isArray(script.calls)) fail("parser_report_invalid");
    let previousStart = -1, locationOffset = 0, line = 1, lastNewline = -1;
    for (const call of script.calls) {
      totalCalls++;
      if (totalCalls > 100_000 || !validSpan(call, source.sizeBytes) || call.start < previousStart ||
        !Number.isSafeInteger(call.line) || call.line < 1 || !Number.isSafeInteger(call.column) || call.column < 1 ||
        !Array.isArray(call.arguments) || !call.arguments.length) fail("parser_report_invalid");
      previousStart = call.start;
      while (locationOffset < call.start) {
        if (source.bytes[locationOffset] === 10) { line++; lastNewline = locationOffset; }
        locationOffset++;
      }
      if (call.line !== line || call.column !== call.start - lastNewline) fail("parser_report_invalid");
      let previousEnd = call.start;
      for (const argument of call.arguments) {
        if (!validSpan(argument, source.sizeBytes) || argument.start < previousEnd || argument.end > call.end ||
          typeof argument.raw !== "string" || source.bytes.subarray(argument.start, argument.end).toString("utf8") !== argument.raw ||
          !(argument.literal === null || typeof argument.literal === "string") ||
          !Array.isArray(argument.partKinds) || !argument.partKinds.length || argument.partKinds.some(kind => !partKinds.has(kind))) fail("parser_report_invalid");
        previousEnd = argument.end;
      }
      if (previousEnd !== call.end) fail("parser_report_invalid");
    }
  }
}

function validSpan(span, length) {
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimeRoot, parserPath, expectedParserChecksum, reportPath, shellPath = "/bin/bash"] = process.argv.slice(2);
  if (!runtimeRoot || !parserPath || !reportPath) throw new Error("Usage: node inspect-shell-call-sites.mjs <runtime-root> <parser-path> <parser-sha256> <report-path> [bash-path]");
  const inventory = JSON.parse((await readRecord(fileURLToPath(new URL("./pinned-shell-inventory.json", import.meta.url)), { retain: true })).bytes);
  const interpreter = await realpath(shellPath);
  const report = await inspectGstackShellCallSites({ runtimeRoot, parserPath, expectedParserChecksum,
    expectedSourceManifestChecksum: inventory.sourceManifestChecksum, expectedUpstreamRevision: inventory.upstreamRevision,
    shellPath: interpreter, expectedShellChecksum: (await readRecord(interpreter)).checksum });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ receiptChecksum: checksum(bytes), scripts: report.scripts.length,
    calls: report.scripts.reduce((count, script) => count + script.calls.length, 0), sourceSites: report.sourceSites.length,
    dynamicEvaluationSites: report.dynamicEvaluationSites.length, unresolvedCommandSites: report.unresolvedCommandSites.length,
    callGraphChecksum: report.callGraphChecksum, releaseEligible: report.releaseEligible }));
}
