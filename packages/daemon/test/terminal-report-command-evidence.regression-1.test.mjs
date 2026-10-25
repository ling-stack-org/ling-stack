import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, validateTerminalReportEvidenceSnapshot } from "../../core/dist/index.js";
import {
  collectRunTerminalReportEvidence,
  collectTurnTerminalReportEvidence,
  collectWorkflowTerminalReportEvidence,
} from "../dist/features/channels/terminal-report-evidence.js";
import { buildTerminalReportPrompt } from "../dist/features/channels/terminal-report-prompt.js";
import { projectTerminalReportCommandEvidence } from "../dist/features/channels/terminal-report-command-evidence.js";

const now = "2026-10-25T10:52:48.391Z";
const command = "node --version";

// Reproduce the packaged R6 receipt shape, without executing a command/model
// or reading the real QA database. Every store below belongs to a temp folder.
async function fixture(t, { surface = "run", stdout = "v24.15.0\n", stderr = "", result = true, truncated = false } = {}) {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-report-command-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Report command fixture", boundPath: cwd }, now);
  const thread = surface === "turn" ? store.createLingThread({ kind: "conversation", title: "Version", objective: command }, now) : undefined;
  const turn = thread ? store.createLingTurn({ threadId: thread.id, kind: "initial_request", title: "Version", userInstruction: command }, now) : undefined;
  const workflow = surface === "workflow" ? store.createChannelWorkflow({ channelId: channel.id,
    title: "Version", objective: command, status: "succeeded", createdBy: "ling_agent" }, now) : undefined;
  const step = workflow ? store.createChannelWorkflowStep({ workflowId: workflow.id,
    title: "Version", prompt: command, toParticipantId: "engineer", toParticipantLabel: "Engineer", status: "succeeded" }, now) : undefined;
  const task = store.createTask({ channelId: channel.id, title: "Version", prompt: command }, now);
  const run = store.createRun({ id: "run_report_command", cwd, taskId: task.id,
    channelId: workflow ? channel.id : undefined, teammateId: workflow ? "engineer" : undefined,
    workflowStepId: step?.id, threadId: thread?.id, turnId: turn?.id,
    providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {},
    requestSnapshot: { cwd, responseLanguage: "zh-CN" }, createdAt: now });
  if (step) store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId: run.id }, now);
  store.markRunStarted(run.id, now);
  store.appendEvent(run.id, "tool_start", { toolCallId: "version", toolName: "bash", args: { command, cwd } });
  if (result) store.appendEvent(run.id, "tool_end", { toolCallId: "version", toolName: "bash", isError: false,
    result: { details: { unifiedExec: { status: "succeeded", cwd,
      command: { kind: "shell", command, shell: "bash" }, startedAt: now, endedAt: now,
      durationMs: 3, exitCode: 0, timedOut: false, cancelled: false,
      stdout: { preview: stdout, byteCount: Buffer.byteLength(stdout), truncated },
      stderr: { preview: stderr, byteCount: Buffer.byteLength(stderr), truncated: false }, artifacts: [],
    } } } });
  if (result) store.markRunSucceeded(run.id, now);
  else store.markRunCancelled(run.id, now);
  const snapshot = (budgets) => workflow
    ? collectWorkflowTerminalReportEvidence(store, workflow.id, { generatedAt: now, budgets })
    : turn ? collectTurnTerminalReportEvidence(store, turn.id, { generatedAt: now, budgets })
      : collectRunTerminalReportEvidence(store, run.id, { generatedAt: now, budgets });
  return { store, run, snapshot };
}

for (const surface of ["run", "turn", "workflow"]) test(`${surface} report retains atomic command output and exit without inventing a check`, async t => {
  const { snapshot } = await fixture(t, { surface });
  const evidence = snapshot();
  assert.equal(evidence.operations.length, 1);
  assert.equal(evidence.checks.length, 0, "a version query is not a test assertion");
  assert.equal(evidence.operations[0].commandEvidence?.command, command);
  assert.equal(evidence.operations[0].commandEvidence?.exitCode, 0);
  assert.equal(evidence.operations[0].commandEvidence?.stdout, "v24.15.0\n");
  assert.equal(evidence.operations[0].commandEvidence?.timedOut, false);
  assert.equal(evidence.operations[0].commandEvidence?.cancelled, false);
  assert.equal(evidence.operations[0].commandEvidence?.outputTruncated, false);
  assert.equal(validateTerminalReportEvidenceSnapshot(evidence).ok, true);
  const model = JSON.parse(buildTerminalReportPrompt(evidence).prompt.split("Evidence snapshot: ")[1]);
  assert.equal(model.operations[0].commandEvidence.stdout, "v24.15.0\n");
  assert.equal(model.operations[0].commandEvidence.exitCode, 0);
});

test("report output is redacted before bounding and preserves stdout/stderr whitespace", async t => {
  const { snapshot } = await fixture(t, { stdout: "line one\n  sk-testCredential123456\nline three\n", stderr: "warning\n  details\n" });
  const evidence = snapshot().operations[0].commandEvidence;
  assert.ok(evidence);
  assert.equal(evidence.stdout, "line one\n  [REDACTED]\nline three\n");
  assert.equal(evidence.stderr, "warning\n  details\n");
  // appendEvent already redacts this value before the action projection. Its
  // legacy chunk does not carry a redaction flag, so do not invent provenance.
  assert.equal(evidence.outputRedacted, false);
});

test("the pure command projection redacts across chunk boundaries before limiting output", () => {
  const action = { commandEvidence: { command: "node --version", latestEventSeq: 3,
    outputTail: [
      { stream: "stdout", text: "\u001b[31msk-testCre", redacted: false },
      { stream: "stdout", text: "dential123456\u001b[0m\n", redacted: false },
    ], outputByteCount: 0, outputTruncated: false } };
  const original = JSON.stringify(action);
  const evidence = projectTerminalReportCommandEvidence(action, 10);
  assert.equal(evidence.stdout, "[REDACTED]");
  assert.equal(evidence.outputRedacted, true);
  assert.equal(evidence.outputTruncated, true);
  assert.equal(evidence.commandTruncated, true);
  assert.equal(evidence.exitCode, undefined);
  assert.equal(JSON.stringify(action), original, "projection must not mutate atomic evidence");
});

test("upstream redaction and incomplete output flags survive the bounded projection", () => {
  const evidence = projectTerminalReportCommandEvidence({ commandEvidence: {
    command, latestEventSeq: 3, outputTail: [{ stream: "stderr", text: "[REDACTED]", redacted: true }],
    outputByteCount: 100, outputTruncated: true,
  } }, 80);
  assert.equal(evidence.outputRedacted, true);
  assert.equal(evidence.outputTruncated, true);
  assert.equal(evidence.stderr, "[REDACTED]");
  assert.equal(evidence.timedOut, undefined);
  assert.equal(evidence.cancelled, undefined);
});

test("report output has a shared finite budget and reports upstream truncation", async t => {
  const { snapshot } = await fixture(t, { stdout: "a".repeat(200), stderr: "b".repeat(200), truncated: true });
  const evidence = snapshot({ summaryCharacters: 80 }).operations[0].commandEvidence;
  assert.ok(evidence);
  assert.ok(evidence.stdout.length + evidence.stderr.length <= 80);
  assert.ok(evidence.stdout.length > 0 && evidence.stderr.length > 0);
  assert.equal(evidence.outputTruncated, true);
  assert.equal(evidence.exitCode, 0);
});

test("a cancelled action with no accepted result does not invent an exit receipt", async t => {
  const { snapshot } = await fixture(t, { result: false });
  const evidence = snapshot();
  assert.equal(evidence.operations[0].commandEvidence?.command, command);
  assert.equal(evidence.operations[0].commandEvidence?.exitCode, undefined);
  assert.equal(evidence.operations[0].commandEvidence?.timedOut, undefined);
  assert.equal(evidence.operations[0].commandEvidence?.cancelled, undefined);
  assert.ok(evidence.risks.some(risk => risk.id.startsWith("execution-unconfirmed:")));
});

test("command output changes invalidate the report fingerprint even when titles and statuses match", async t => {
  const left = await fixture(t, { stdout: "v24.15.0\n" });
  const right = await fixture(t, { stdout: "v24.16.0\n" });
  const a = left.snapshot(), b = right.snapshot();
  // Exclude fixture-owned identities so this actually detects output, not IDs.
  const { computeTerminalReportEvidenceFingerprint } = await import("../../core/dist/index.js");
  const alternate = { ...a, operations: a.operations.map((op, i) => ({ ...op, commandEvidence: b.operations[i].commandEvidence })) };
  assert.notEqual(computeTerminalReportEvidenceFingerprint(a), computeTerminalReportEvidenceFingerprint(alternate));
});

test("restricted operation aliases cannot leak the new command output into the model prompt", async t => {
  const { snapshot } = await fixture(t);
  const evidence = snapshot();
  assert.equal(evidence.operations[0].commandEvidence?.stdout, "v24.15.0\n");
  const hidden = { ...evidence.operations[0].sourceRefs[0], visibility: "developer_only" };
  const generated = buildTerminalReportPrompt({ ...evidence, references: [...evidence.references, hidden] });
  const model = JSON.parse(generated.prompt.split("Evidence snapshot: ")[1]);
  assert.equal(model.operations.length, 0);
  assert.doesNotMatch(generated.prompt, /v24\.15\.0/u);
});
