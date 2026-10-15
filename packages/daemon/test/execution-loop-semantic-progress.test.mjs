import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { redactSecrets } from "@ling-stack/core";
import { translatePiEvent } from "../../runner-pi/dist/events.js";
import { ExecutionLoopDetector } from "../dist/features/runs/execution-loop-detector.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createStreamCapture } from "../dist/features/runs/unified-exec-output.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

// Narrow integration, not a model/orchestrator/GUI acceptance claim:
// - executeUnifiedBashTool creates real OS output, Host command tickets, journal
//   settlements and artifact files in the fixture's own SQLite workspace;
// - its returned handled result crosses the ORIGINAL Pi tool_end normalizer;
// - UnifiedExec tool_update/artifact_created use the ORIGINAL direct Host path;
// - appendExecutionEvent returns the actual redacted durable envelope observed
//   by the detector, as orchestrator.appendRunEvent does after persistence.
// No approval, sandbox, preparation receipt or command ticket is stubbed.
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const nodeCommand = source => `${quote(process.execPath)} -e ${quote(source)}`;
const printCommand = text => nodeCommand(`process.stdout.write(${JSON.stringify(text)});`);

async function createCase(t, limits = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a24-semantic-progress-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "a24-producer-task", title: "A24 semantic progress", prompt: "Owned bounded local fixture" };
  // This existing fixture creates genuine current WorkUnit/Attempt/Run facts.
  // It is an internal policyless controlled Run, not Full Access permission.
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "a24-producer-run");
  const detector = new ExecutionLoopDetector(sourceFence.attemptId, limits);
  const observedEvents = [], results = [];
  let finding;

  function append(type, data) {
    const envelope = store.appendExecutionEvent(run.id, sourceFence, type, redactSecrets(data));
    observedEvents.push(envelope);
    finding ??= detector.observe(envelope);
    return envelope;
  }

  function fromSdk(event) {
    const normalized = translatePiEvent(event);
    assert.ok(normalized, `the original Pi normalizer must accept ${event.type}`);
    return append(normalized.type, { ...normalized });
  }

  async function execute(index, command, text, exitCode = 0) {
    assert.equal(finding, undefined, "the fixture must never dispatch another command after its breaker trips");
    const toolCallId = `a24-command-${index}`, input = { command, timeoutMs: 3000 };
    fromSdk({ type: "tool_execution_start", toolCallId, toolName: "bash", args: input });
    // no_progress_budget can trip at start, before a real command is launched.
    if (finding) return undefined;
    const handled = await executeUnifiedBashTool({ store, run, sourceFence,
      request: { toolCallId, toolName: "bash", cwd, task, input }, appendAndMaybeStream: append,
    });
    const result = handled.details?.unifiedExec;
    assert.ok(result?.processObservation, "a synthetic failure cannot stand in for the real command producer");
    assert.equal(result.status, exitCode === 0 ? "succeeded" : "failed");
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.stdout.preview, text);
    assert.equal(handled.isError, exitCode !== 0);
    assert.equal(result.toolCallId, toolCallId);
    assert.ok(result.artifacts.every(artifact => store.getArtifact(artifact.artifactId)?.runId === run.id));
    const journal = store.listEvents(run.id, { limit: 1000 });
    const prepared = journal.filter(event => event.type === "host_command_prepared" && event.data.toolCallId === toolCallId);
    assert.equal(prepared.length, 1, "the original command producer owns exactly one durable preparation");
    const settled = journal.filter(event => event.type === "host_command_settled" &&
      event.data.executionId === prepared[0].data.executionId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].data.outcome, "completed", "real leader/stdio closure, not a forged no-start ticket");
    results.push(result);
    fromSdk({ type: "tool_execution_end", toolCallId, toolName: "bash", result: handled, isError: handled.isError });
    return result;
  }

  return { cwd, store, run, sourceFence, observedEvents, results, append, fromSdk, execute,
    get finding() { return finding; } };
}

function assertFinding(fixture, kind, count) {
  const event = fixture.finding?.event;
  assert.ok(event, `semantic ${kind} must trip despite fresh bookkeeping metadata`);
  assert.equal(event.loopKind, kind);
  assert.equal(event.repeatedCount, count);
  assert.equal(event.attemptId, fixture.sourceFence.attemptId);
  assert.equal(event.retryable, false);
  assert.match(event.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(event.observedEventSeq, fixture.observedEvents.at(-1).seq);
  assert.doesNotMatch(JSON.stringify(event), /A24_STABLE|A24_DUPLICATE|A24_CYCLE|semantic-state/u);
}

test("A24 real UnifiedExec results with fresh times/call/artifact IDs still form an exact repeat", { timeout: 15_000 }, async t => {
  const f = await createCase(t), text = "A24_STABLE\n", command = printCommand(text);
  for (let index = 0; index < 3; index++) {
    await f.execute(index, command, text);
    if (index < 2) assert.equal(f.finding, undefined);
  }
  assert.equal(new Set(f.results.map(result => result.toolCallId)).size, 3);
  assert.equal(new Set(f.results.map(result => result.startedAt)).size, 3);
  assert.equal(new Set(f.results.map(result => result.artifacts.find(artifact => artifact.role === "result").artifactId)).size, 3);
  assert.ok(f.results.every(result => result.command.command === command && result.stdout.preview === text));
  const ends = f.observedEvents.filter(event => event.type === "tool_end");
  assert.equal(ends.length, 3);
  assert.ok(ends.every(event => event.data.result.details.unifiedExec.stdout.preview === text));
  assert.ok(ends.every(event => /Command exited 0 in \d+ms\./u.test(event.data.result.content[0].text)),
    "the real model-visible producer summary carries elapsed metadata too");
  assertFinding(f, "exact_repeat", 3);
});

test("A24 real Host stream chunks with changing sequence/time but identical text repeat six times", async t => {
  const f = await createCase(t), toolCallId = "a24-stream", text = "A24_DUPLICATE\n";
  f.fromSdk({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "owned stream capture" } });
  const capture = createStreamCapture("stdout", toolCallId, f.append, []);
  for (let index = 0; index < 6; index++) {
    capture.ingest(Buffer.from(text));
    if (index < 5) assert.equal(f.finding, undefined);
    await delay(2);
  }
  capture.flush();
  const updates = f.observedEvents.filter(event => event.type === "tool_update");
  assert.deepEqual(updates.map(event => event.data.partialResult.sequence), [1, 2, 3, 4, 5, 6]);
  assert.ok(updates.every(event => event.data.partialResult.text === text && event.data.partialResult.stream === "stdout"));
  assert.equal(new Set(updates.map(event => event.data.partialResult.ts)).size, 6);
  assert.equal(capture.snapshot().artifactContent, text.repeat(6));
  assertFinding(f, "repeated_update", 6);
});

test("A24 real A-B command/result cycle is detected across six distinct producer executions", { timeout: 25_000 }, async t => {
  const f = await createCase(t);
  for (let index = 0; index < 6; index++) {
    const text = `A24_CYCLE_${index % 2 === 0 ? "A" : "B"}\n`;
    await f.execute(index, printCommand(text), text);
    if (index < 5) assert.equal(f.finding, undefined);
  }
  assert.equal(f.results.length, 6);
  assertFinding(f, "cycle", 3);
  assert.equal(f.finding.event.cycleLength, 2);
});

test("A24 duplicate producer output/artifact metadata cannot replenish the no-progress budget", { timeout: 20_000 }, async t => {
  const f = await createCase(t, { noProgressActionBudget: 3, exactRepeatThreshold: 20,
    repeatedUpdateThreshold: 20, cycleRepeatThreshold: 20 });
  const text = "A24_STABLE\n", command = printCommand(text);
  for (let index = 0; index < 4 && !f.finding; index++) await f.execute(index, command, text);
  assertFinding(f, "no_progress_budget", 3);
  assert.equal(f.results.length, 3, "the fourth start must stop before a fourth OS command dispatch");
  assert.equal(f.finding.event.observedEventType, "tool_start");
  assert.equal(f.finding.event.noProgressActionCount, 3);
  assert.equal(f.store.listEvents(f.run.id, { limit: 1000 }).filter(event => event.type === "host_command_prepared").length, 3);
});

const stateCommand = nodeCommand('const s=JSON.parse(require("node:fs").readFileSync("semantic-state.json","utf8"));process.stdout.write(s.text);process.exitCode=s.exitCode;');

test("A24 genuine output changes from the same command remain semantic progress", { timeout: 20_000 }, async t => {
  const f = await createCase(t);
  for (let index = 0; index < 4; index++) {
    const text = `A24_CONTENT_${index}\n`;
    await writeFile(join(f.cwd, "semantic-state.json"), JSON.stringify({ text, exitCode: 0 }));
    await f.execute(index, stateCommand, text);
    assert.equal(f.finding, undefined);
  }
  assert.equal(new Set(f.results.map(result => result.command.command)).size, 1);
  assert.equal(new Set(f.results.map(result => result.stdout.preview)).size, 4);
});

test("A24 genuine success/failure changes are not collapsed into an exact repeated result", { timeout: 25_000 }, async t => {
  const f = await createCase(t), text = "A24_SAME_BODY\n";
  for (const [index, exitCode] of [0, 0, 7, 7, 0, 0].entries()) {
    await writeFile(join(f.cwd, "semantic-state.json"), JSON.stringify({ text, exitCode }));
    await f.execute(index, stateCommand, text, exitCode);
    assert.equal(f.finding, undefined, "equal stdout does not erase real exit-status changes");
  }
  assert.equal(new Set(f.results.map(result => result.command.command)).size, 1);
  assert.deepEqual(f.results.map(result => result.status), ["succeeded", "succeeded", "failed", "failed", "succeeded", "succeeded"]);
});

test("A24 one bounded long-running command may stream changing evidence without a false loop", { timeout: 10_000 }, async t => {
  const f = await createCase(t, { noProgressActionBudget: 2 });
  const text = Array.from({ length: 16 }, (_, index) => `A24_PROGRESS_${index}\n`).join("");
  const command = nodeCommand('let i=0;const timer=setInterval(()=>{process.stdout.write("A24_PROGRESS_"+i+"\\n");if(++i===16)clearInterval(timer);},5);');
  await f.execute(0, command, text);
  assert.equal(f.finding, undefined);
  assert.equal(f.results.length, 1);
  const updates = f.observedEvents.filter(event => event.type === "tool_update");
  assert.equal(updates.map(event => event.data.partialResult.text).join(""), text);
  assert.ok(updates.length > 0);
  assert.equal(f.observedEvents.filter(event => event.type === "tool_start").length, 1);
});
