import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { codeAssessmentHunkContent, type CodeAssessmentDetail } from "@ling-stack/contracts";
import { createSqliteRunStore } from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { createDaemonServer, type DaemonServer } from "../dist/index.js";
import { codeAssessmentQualityCases, type CodeAssessmentQualityCase } from "./fixtures/code-assessment-quality.ts";

const exec = promisify(execFile);
const enabled = process.env.LING_CODE_ASSESSMENT_QUALITY_RUN === "1";
const maxRequests = 9;
const maxCaseMs = 180_000;
const maxTotalMs = 15 * 60_000;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

interface RelayState { count: number; rejected: number; model: string; deadline: number; active?: { runId: string; count: number }; receipts: unknown[]; }

/** A bounded local relay keeps credentials out of the daemon/store and forbids retries after forwarding. */
async function startRelay(upstream: string, apiKey: string | undefined, state: RelayState): Promise<{ server: Server; baseUrl: string }> {
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    if (!state.active || state.active.count > 0 || state.count >= maxRequests || Date.now() >= state.deadline) {
      state.rejected++; response.writeHead(400).end("quality dispatch rejected"); return;
    }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { const data = Buffer.from(chunk); bytes += data.length; if (bytes > 32 * 1024) { response.writeHead(413).end(); return; } chunks.push(data); }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { response.writeHead(400).end(); return; }
    const outputCap = payload.max_completion_tokens ?? payload.max_tokens;
    if (payload.stream !== true || payload.model !== state.model || !Number.isSafeInteger(outputCap) || (outputCap as number) < 1 || (outputCap as number) > 2048
      || payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length !== 0)) { response.writeHead(400).end("quality wire bounds invalid"); return; }
    if (!state.active || state.active.count > 0 || state.count >= maxRequests) { state.rejected++; response.writeHead(400).end("quality retry rejected"); return; }
    state.count++; state.active.count++;
    const receipt = { runId: state.active.runId, ordinal: state.count, requestSha256: sha256(JSON.stringify(payload)), inputBytes: bytes,
      outputTokenLimit: outputCap, startedAt: new Date().toISOString(), status: 0, outputBytes: 0, responseSha256: "", error: "" };
    state.receipts.push(receipt);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const upstreamResponse = await fetch(`${upstream.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(Math.min(85_000, state.deadline - Date.now())),
    }).catch(() => { receipt.error = "upstream_dispatch_failed"; response.writeHead(502).end("quality upstream failed"); return undefined; });
    if (!upstreamResponse) return;
    receipt.status = upstreamResponse.status;
    response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "text/event-stream" });
    let outputBytes = 0;
    if (!upstreamResponse.body) { response.end(); return; }
    const reader = upstreamResponse.body.getReader(); const responseHash = createHash("sha256");
    try {
      while (true) { const next = await reader.read(); if (next.done) break; outputBytes += next.value.byteLength; if (outputBytes > 256 * 1024) {
        receipt.error = "upstream_response_budget_exhausted"; await reader.cancel(); response.destroy(); break;
      } responseHash.update(next.value); response.write(Buffer.from(next.value)); }
    } finally { receipt.outputBytes = outputBytes; receipt.responseSha256 = responseHash.digest("hex"); response.end(); }
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

class QualityRunner extends PiRunnerAdapter {
  private readonly relayState: RelayState;
  constructor(relayState: RelayState) { super(); this.relayState = relayState; }
  readonly observations: Array<{ readonly runId: string; readonly taskId: string; readonly prompt: string; readonly systemPrompt?: string;
    readonly tools: readonly string[]; readonly mcpTools: readonly unknown[]; readonly eventCounts: Record<string, number> }> = [];
  async runTask(options: PiRunnerRunOptions) {
    assert.ok(options.runId); assert.equal(this.relayState.active, undefined, "Quality cases run sequentially.");
    const observation = { runId: options.runId, taskId: options.task.id, prompt: options.task.prompt, systemPrompt: options.systemPrompt,
      tools: options.tools ?? [], mcpTools: options.mcpTools ?? [], eventCounts: {} as Record<string, number> };
    this.observations.push(observation);
    assert.deepEqual(options.tools, []); assert.deepEqual(options.mcpTools, []); assert.deepEqual(options.hostCapabilityTools, []);
    assert.deepEqual(options.mediaGenerationTools, []); assert.equal(options.onMcpToolCall, undefined); assert.equal(options.onUserInputRequest, undefined);
    this.relayState.active = { runId: options.runId, count: 0 };
    try { return await super.runTask({ ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(88_000)]),
      onEvent: event => { observation.eventCounts[event.type] = (observation.eventCounts[event.type] ?? 0) + 1; options.onEvent?.(event); } }); }
    finally { this.relayState.active = undefined; }
  }
}

async function request<T>(base: string, cwd: string, path: string, method = "GET", body?: unknown): Promise<{ status: number; value: T }> {
  const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(maxCaseMs),
  });
  const value = await response.json() as T;
  return { status: response.status, value };
}

async function prepareRepo(cwd: string, item: CodeAssessmentQualityCase): Promise<void> {
  for (const entry of await readdir(cwd)) if (entry !== ".git" && entry !== ".ling-stack") await rm(join(cwd, entry), { recursive: true, force: true });
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(cwd, item.path), item.before);
  await exec("git", ["add", "-A"], { cwd }); await exec("git", ["commit", "--allow-empty", "-qm", `gold ${item.id} baseline`], { cwd });
  await writeFile(join(cwd, item.path), item.after);
}

test("opt-in real code-assessment quality smoke (manual semantic review required)", { skip: !enabled, timeout: maxTotalMs + 30_000 }, async t => {
  const startedAt = Date.now();
  const upstreamInput = process.env.LING_CODE_ASSESSMENT_QUALITY_UPSTREAM?.trim();
  const model = process.env.LING_CODE_ASSESSMENT_QUALITY_MODEL?.trim() || "gpt-5.5";
  const apiKey = process.env.LING_CODE_ASSESSMENT_QUALITY_API_KEY;
  if (!upstreamInput) throw new Error("Set LING_CODE_ASSESSMENT_QUALITY_UPSTREAM to the configured text-chat endpoint; the H3 video model is intentionally unsupported.");
  let upstreamUrl: URL;
  try { upstreamUrl = new URL(upstreamInput); } catch { throw new Error("Quality upstream URL is invalid."); }
  if (!(upstreamUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(upstreamUrl.hostname))
    || upstreamUrl.username || upstreamUrl.password || upstreamUrl.search || upstreamUrl.hash) throw new Error("Quality upstream must be loopback HTTP without URL credentials/query.");
  const upstream = upstreamUrl.href.replace(/\/+$/u, "");
  if (/minimax-h3/iu.test(model)) throw new Error("The H3 audio/video model is not a text-chat assessment candidate.");
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-code-assessment-quality-")));
  await exec("git", ["init", "-q", "-b", "main"], { cwd }); await exec("git", ["config", "user.email", "quality@example.invalid"], { cwd }); await exec("git", ["config", "user.name", "Quality smoke"], { cwd });
  const store = createSqliteRunStore(cwd); const relayState: RelayState = { count: 0, rejected: 0, model, deadline: startedAt + maxTotalMs, receipts: [] };
  const runner = new QualityRunner(relayState);
  const relay = await startRelay(upstream, apiKey, relayState);
  const now = new Date().toISOString();
  const provider = store.createProviderPreset({ kind: "openai-compatible", displayName: "Quality smoke relay", providerId: "quality-smoke-relay", model, api: "openai-completions", baseUrl: relay.baseUrl,
    authHeader: false, reasoning: false, input: ["text"], capabilities: ["chat"], enabled: true, maxTokens: 2_048 }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Opt-in loopback text model quality smoke", checkedAt: now });
  const daemon: DaemonServer = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false } }, { runner, storeFactory: () => store });
  const results: unknown[] = [];
  const reportPath = process.env.LING_CODE_ASSESSMENT_QUALITY_REPORT?.trim() || join(tmpdir(), `ling-code-assessment-quality-${Date.now()}.json`);
  const sourceHashes = await Promise.all([new URL(import.meta.url), new URL("./fixtures/code-assessment-quality.ts", import.meta.url),
    new URL("../src/features/code-assessments/prompt.ts", import.meta.url), new URL("../dist/features/code-assessments/prompt.js", import.meta.url)]
    .map(async path => ({ path: path.pathname, sha256: sha256(await readFile(path, "utf8")) })));
  const saveReport = () => {
    const serialized = `${JSON.stringify({ schemaVersion: 1, kind: "code_assessment_quality_smoke", generatedAt: new Date().toISOString(), model, upstream,
    sourceHashes, semanticReview: "pending_independent_review", requestBudget: { maxRequests, forwardedRequests: relayState.count, rejectedRetries: relayState.rejected,
      maxCaseMs, maxTotalMs, maxWireInputBytes: 32768, maxOutputTokens: 2048, maxResponseBytes: 262144 }, receipts: relayState.receipts, observations: runner.observations, results }, null, 2)}\n`;
    return writeFile(reportPath, apiKey ? serialized.replaceAll(apiKey, "[REDACTED]") : serialized, { mode: 0o600 });
  };
  t.after(async () => { await saveReport(); await daemon.stop(); await new Promise<void>(resolve => relay.server.close(() => resolve())); await rm(cwd, { recursive: true, force: true });
    console.error(`Quality smoke report saved to ${reportPath}; semantic scoring remains manual review.`); });
  await daemon.start(); const address = daemon.server.address(); assert.ok(address && typeof address === "object"); const base = `http://127.0.0.1:${address.port}`;
  for (const item of codeAssessmentQualityCases) {
    assert.ok(Date.now() < relayState.deadline, "Quality batch total deadline exceeded.");
    const caseStarted = Date.now(); const observationStart = runner.observations.length; await prepareRepo(cwd, item);
    const created = await request<CodeAssessmentDetail>(base, cwd, "/workspace/code-assessments", "POST", { kind: item.kind, target: { type: "working_tree" }, providerPresetId: provider.id });
    assert.equal(created.status, 202, `${item.id}: ${JSON.stringify(created.value)}`);
    let detail = created.value;
    while (["queued", "analyzing"].includes(detail.assessment.status)) {
      if (Date.now() - caseStarted > maxCaseMs) {
        results.push({ id: item.id, kind: item.kind, status: "case_timeout", assessment: detail.assessment, snapshot: detail.snapshot, gold: item.gold,
          semanticReview: "pending_independent_review" });
        await request(base, cwd, `/workspace/code-assessments/${encodeURIComponent(detail.assessment.id)}/cancel`, "POST", {});
        throw new Error(`${item.id}: case timeout`);
      }
      await delay(100); detail = (await request<CodeAssessmentDetail>(base, cwd, `/workspace/code-assessments/${encodeURIComponent(detail.assessment.id)}`)).value;
    }
    const observations = runner.observations.slice(observationStart);
    const observation = observations.at(-1);
    const { id: snapshotId, capturedAt, digest, ...snapshotBody } = detail.snapshot;
    const lineEvidence = detail.findings.map(finding => {
      const file = detail.snapshot.files.find(file => file.path === finding.path);
      const lines = codeAssessmentHunkContent(file?.diff ?? "", finding.side);
      const excerpt = Array.from({ length: finding.endLine - finding.startLine + 1 }, (_, index) => lines.get(finding.startLine + index)).join("\n");
      return { findingId: finding.id, digestMatches: finding.snapshotDigest === digest, pathCaptured: Boolean(file), exactEvidence: excerpt.includes(finding.evidence),
        linesCaptured: Array.from({ length: finding.endLine - finding.startLine + 1 }, (_, index) => lines.has(finding.startLine + index)).every(Boolean) };
    });
    const phaseRuns = detail.assessment.phaseRuns ?? [];
    const runEvents = phaseRuns.map(run => ({ runId: run.runId, events: store.listEvents(run.runId, { limit: 1000 }) }));
    results.push({ id: item.id, kind: item.kind, sourceSha256: sha256(item.before + "\0" + item.after), snapshotDigest: detail.snapshot.digest, snapshot: detail.snapshot,
      promptSha256: observation ? sha256(observation.prompt) : undefined, promptHashes: observations.map(value => sha256(value.prompt)),
      systemPromptSha256: observation?.systemPrompt ? sha256(observation.systemPrompt) : undefined,
      model, phase: detail.assessment.phase, phaseRuns, status: detail.assessment.status, errorMessage: detail.assessment.errorMessage, findings: detail.findings,
      threatModel: detail.assessment.threatModelArtifactId ? store.getArtifact(detail.assessment.threatModelArtifactId)?.sealedPayload : undefined,
      toolEvidence: { options: observations.map(value => ({ runId: value.runId, tools: value.tools, mcpTools: value.mcpTools, eventCounts: value.eventCounts })),
        durableToolEvents: runEvents.map(run => ({ runId: run.runId, types: run.events.filter(event => event.type === "tool_start" || event.type === "tool_end").map(event => event.type) })) },
      runEvents, gold: item.gold, contractReview: { completed: detail.assessment.status === "completed", snapshotDigestMatches: sha256(JSON.stringify(snapshotBody)) === digest,
        lineEvidence, expectedPhases: item.kind === "security" ? ["threat_model", "reviewing_code"] : ["reviewing_code"],
        actualPhases: phaseRuns.map(run => run.phase), semanticDecision: "manual_required" },
      elapsedMs: Date.now() - caseStarted });
    await saveReport();
  }
  await saveReport();
  assert.equal(relayState.count, maxRequests, `Expected exactly ${maxRequests} bounded model requests; report=${reportPath}`);
  assert.ok(results.every(result => (result as { status: string }).status === "completed"), `Some model reports did not satisfy the assessment contract; report=${reportPath}`);
  assert.ok(Date.now() - startedAt <= maxTotalMs + 30_000);
});
