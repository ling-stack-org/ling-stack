import assert from "node:assert/strict";
import { test } from "node:test";
import { semanticProgressEvent, semanticToolResult, semanticToolUpdate } from "../dist/features/runs/execution-loop-semantic-evidence.js";
import { renderUnifiedExecModelOutput } from "../dist/features/runs/unified-exec-model-output.js";
import { ExecutionLoopDetector } from "../dist/features/runs/execution-loop-detector.js";

// Synthetic projection controls, NOT producer/SQLite/safety conformance. The
// neighboring semantic-progress file owns the original real-producer evidence.
const at = "2026-10-15T12:00:00.000Z", later = "2026-10-15T12:00:01.000Z";
const observation = { scope: "process_group", leaderExited: true, stdioClosed: true,
  descendants: "unverified", settledBy: "close", signalFailures: [] };
const artifactId = (call, role) => role === "result" ? `artifact_unit_run_${call}_unified_exec_${role}` : `artifact_store_random_${call}_${role}`;

function handled(call, durationMs = 10) {
  const result = { status: "succeeded", runId: "unit_run", taskId: "unit_task", toolCallId: call,
    cwd: "/owned", command: { kind: "shell", command: "printf same", shell: "bash" },
    environmentSummary: { mode: "inherit_minimal", cwd: "/owned", keys: ["PATH"], redactedKeys: [] },
    startedAt: durationMs === 10 ? at : later, endedAt: later, durationMs, exitCode: 0,
    timedOut: false, cancelled: false, processObservation: structuredClone(observation),
    stdout: { preview: "same\n", byteCount: 5, lineCount: 1, truncated: false, artifactId: artifactId(call, "stdout") },
    stderr: { preview: "", byteCount: 0, lineCount: 0, truncated: false },
    artifacts: [
      { artifactId: artifactId(call, "result"), role: "result", contentType: "application/json", sizeBytes: 500 + durationMs, redacted: false, truncated: false },
      { artifactId: artifactId(call, "stdout"), role: "stdout", contentType: "text/plain; charset=utf-8", sizeBytes: 5, redacted: false, truncated: false },
    ],
  };
  return { content: [{ type: "text", text: renderUnifiedExecModelOutput(result) }], details: { unifiedExec: result }, isError: false };
}

const semantic = value => semanticToolResult("bash", value.details.unifiedExec.toolCallId, value);

function chunk(overrides = {}) {
  return { toolCallId: "stream", stream: "stdout", sequence: 1, ts: at, text: "same\n",
    byteCount: 5, redacted: false, truncated: false, ...overrides };
}

function artifact(call, role = "result") {
  const id = artifactId(call, role);
  return { toolName: "bash", toolCallId: call, role, artifactId: id, artifact: {
    id, runId: "unit_run", type: role === "result" ? "json" : "log",
    path: `unit_run/unified-exec/${call}/${role === "result" ? "result.json" : `${role}.txt`}`,
    title: `Unified exec ${role}`, contentType: role === "result" ? "application/json" : "text/plain; charset=utf-8",
    sizeBytes: 510, createdAt: at,
  } };
}

test("A24 typed complete result removes only producer bookkeeping and exact generated timing text", () => {
  const first = handled("one"), second = handled("two", 25);
  const original = structuredClone(first);
  assert.notDeepEqual(first, second);
  assert.deepEqual(semantic(first), semantic(second));
  assert.deepEqual(first, original, "comparison cannot rewrite the persisted or model-visible result");
  assert.equal(semantic(first).details.unifiedExec.stdout.preview, "same\n");
  assert.equal(semantic(first).content[0].text, renderUnifiedExecModelOutput({ ...first.details.unifiedExec, durationMs: 0 }));
});

test("A24 unknown tool, partial result and mismatched call identity preserve all original fields", () => {
  const full = handled("one"), partial = { content: [], details: { unifiedExec: { id: "user", ts: at, text: "content" } } };
  assert.equal(semanticToolResult("custom", "one", full), full);
  assert.equal(semanticToolResult("bash", "other-call", full), full);
  assert.equal(semanticToolResult("bash", "one", partial), partial);
  const malformed = handled("one");
  malformed.details.unifiedExec.artifacts[0].artifactId = "ordinary-user-artifact";
  assert.equal(semanticToolResult("bash", "one", malformed), malformed);
});

test("A24 user text and unknown details are not discarded or changed by timing-like words", () => {
  for (const extra of ["\nUser timing: 10ms", "\nCommand exited 0 in 10ms."]) {
    const value = handled("one");
    value.content[0].text += extra;
    assert.equal(semantic(value).content[0].text, value.content[0].text);
  }
  const first = handled("one"), second = handled("two", 25);
  first.details.user = { id: "user-a", ts: at, durationMs: 5 };
  second.details.user = { id: "user-b", ts: later, durationMs: 5 };
  assert.notDeepEqual(semantic(first), semantic(second));
  assert.deepEqual(semantic(first).details.user, first.details.user);
  first.content.push({ type: "text", text: "User extra result" });
  assert.deepEqual(semantic(first).content, first.content, "extra user blocks cannot be normalized away");
});

test("A24 result content, status, exit, signal, command and observation changes remain distinct", () => {
  const base = handled("one");
  for (const mutate of [
    value => { value.details.unifiedExec.stdout.preview = "different"; },
    value => { value.details.unifiedExec.stderr.preview = "error"; },
    value => { value.details.unifiedExec.status = "failed"; },
    value => { value.details.unifiedExec.exitCode = 7; },
    value => { value.details.unifiedExec.signal = "SIGTERM"; },
    value => { value.details.unifiedExec.timedOut = true; },
    value => { value.details.unifiedExec.cancelled = true; },
    value => { value.details.unifiedExec.command.command = "printf different"; },
    value => { value.details.unifiedExec.processObservation.stopReason = "output_drain"; },
    value => { value.details.unifiedExec.stdout.truncated = true; },
    value => { value.details.unifiedExec.artifacts[1].sizeBytes = 6; },
    value => { value.details.unifiedExec.userMetadata = { id: "semantic", time: later }; },
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notDeepEqual(semantic(changed), semantic(base));
  }
});

test("A24 typed stream ignores only sequence/time and keeps stream/content/flags/extensions", () => {
  const first = chunk(), next = chunk({ sequence: 2, ts: later });
  assert.deepEqual(semanticToolUpdate("bash", "stream", first), semanticToolUpdate("bash", "stream", next));
  for (const overrides of [{ stream: "stderr" }, { text: "different" }, { byteCount: 6 },
    { redacted: true }, { truncated: true }, { id: "user-value" }, { time: later }]) {
    assert.notDeepEqual(semanticToolUpdate("bash", "stream", first), semanticToolUpdate("bash", "stream", chunk(overrides)));
  }
  assert.equal(semanticToolUpdate("custom", "stream", first), first);
  assert.equal(semanticToolUpdate("bash", "different", first), first);
  const partial = { id: "user", ts: at, text: "same\n", sequence: 1 };
  assert.equal(semanticToolUpdate("bash", "stream", partial), partial);
});

test("A24 only exact generated artifact paths discard bookkeeping, not real size or custom content", () => {
  const first = artifact("one"), next = artifact("two");
  next.artifact.createdAt = later; next.artifact.sizeBytes = 999;
  assert.deepEqual(semanticProgressEvent("artifact_created", first), semanticProgressEvent("artifact_created", next));
  for (const mutate of [
    value => { value.artifact.path = "ordinary/report.json"; },
    value => { value.artifact.title = "A user report"; },
    value => { value.toolName = "custom"; },
  ]) {
    const unknown = structuredClone(first); mutate(unknown);
    assert.equal(semanticProgressEvent("artifact_created", unknown), unknown);
  }
  const stdout = artifact("one", "stdout"), changed = structuredClone(stdout);
  changed.artifact.sizeBytes++;
  assert.notDeepEqual(semanticProgressEvent("artifact_created", stdout), semanticProgressEvent("artifact_created", changed));
  changed.artifact.sizeBytes = stdout.artifact.sizeBytes;
  changed.artifact.sealedPayload = { id: "user", time: later };
  assert.notDeepEqual(semanticProgressEvent("artifact_created", stdout), semanticProgressEvent("artifact_created", changed));
});

test("A24 valid Host settlement ignores its fresh receipt ID but preserves outcome and observations", () => {
  const first = { executionId: "first", outcome: "completed", ownerCurrent: true, observation };
  const next = { ...first, executionId: "next" };
  assert.deepEqual(semanticProgressEvent("host_command_settled", first), semanticProgressEvent("host_command_settled", next));
  for (const changed of [
    { ...next, outcome: "stop_unconfirmed", ownerCurrent: false },
    { ...next, outcome: "stop_unconfirmed", observation: { ...observation, stopReason: "timeout" } },
    { ...next, userMetadata: { id: "user", timestamp: later } },
  ]) assert.notDeepEqual(semanticProgressEvent("host_command_settled", first), semanticProgressEvent("host_command_settled", changed));
  const malformed = { executionId: "new", outcome: "completed", ownerCurrent: false };
  assert.equal(semanticProgressEvent("host_command_settled", malformed), malformed);
});

test("A24 Host outcome changes reset no-progress while duplicate receipt identities do not", () => {
  const detector = new ExecutionLoopDetector("attempt-unit", { noProgressActionBudget: 2, exactRepeatThreshold: 20 });
  let seq = 0;
  const observe = (type, data) => detector.observe({ type, data, seq: ++seq });
  const start = id => observe("tool_start", { toolName: "bash", toolCallId: id, args: { command: "same" } });
  const settle = (id, outcome, ownerCurrent, details) => observe("host_command_settled", {
    executionId: id, outcome, ownerCurrent, ...(details ? { observation: details } : {}),
  });
  assert.equal(start("first"), undefined);
  assert.equal(settle("receipt-a", "completed", true, observation), undefined);
  assert.equal(start("second"), undefined);
  assert.equal(settle("receipt-b", "stop_unconfirmed", false, { ...observation, stopReason: "timeout" }), undefined);
  assert.equal(start("third"), undefined, "an actual outcome transition resets the budget");
  assert.equal(settle("receipt-c", "stop_unconfirmed", false, { ...observation, stopReason: "timeout" }), undefined);
  const finding = start("fourth");
  assert.equal(finding?.event.loopKind, "no_progress_budget");
  assert.equal(finding?.event.noProgressActionCount, 2);
});
