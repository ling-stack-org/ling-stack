import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { redactSecrets } from "@ling-stack/core";
import { translatePiEvent } from "../../runner-pi/dist/events.js";
import { ExecutionLoopDetector } from "../dist/features/runs/execution-loop-detector.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = `${quote(process.execPath)} -e ${quote(
  'const state=JSON.parse(require("node:fs").readFileSync("semantic-state.json","utf8"));process.stdout.write(state.text);',
)}`;

// Narrow original-producer integration, not full orchestrator/model/GUI acceptance.
// Real commands, current fences, durable events, journal and artifact files are
// fixture-owned. The original SDK normalizer handles start/end; UnifiedExec emits
// updates/artifacts directly. Journal settlement uses its dedicated Store path and
// is deliberately NOT injected into the detector as an original emitter callback.
// No approval, sandbox, command preparation or receipt method is stubbed.
test("A24 same command with equal truncated previews but changing complete output remains progress", { timeout: 20_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a24-full-output-progress-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "a24-full-output-task", title: "A24 complete output progress", prompt: "Owned bounded local fixture" };
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "a24-full-output-run");
  const detector = new ExecutionLoopDetector(sourceFence.attemptId);
  const observedEvents = [], results = [], fullOutputs = [], findings = [];
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

  const prefix = "A24_FIXED_OUTPUT_LINE\n".repeat(450);
  assert.ok(Buffer.byteLength(prefix) > 8 * 1024, "all changing tails must lie beyond the original 8KiB preview");
  assert.ok(Buffer.byteLength(prefix) < 12 * 1024, "keep each real command bounded, without six identical output chunks");

  for (let index = 0; index < 3; index++) {
    assert.equal(finding, undefined, "never dispatch another command after the breaker trips");
    const tail = `A24_REAL_TAIL_${index}\n`, text = prefix + tail;
    const toolCallId = `a24-full-output-${index}`, input = { command, timeoutMs: 3000 };
    await writeFile(join(cwd, "semantic-state.json"), JSON.stringify({ text }));
    fromSdk({ type: "tool_execution_start", toolCallId, toolName: "bash", args: input });
    assert.equal(finding, undefined, "the current start must remain admitted before launching a real command");
    const handled = await executeUnifiedBashTool({ store, run, sourceFence,
      request: { toolCallId, toolName: "bash", cwd, task, input }, appendAndMaybeStream: append,
    });
    const result = handled.details?.unifiedExec;
    assert.ok(result?.processObservation, "a synthetic failure is not real command evidence");
    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.equal(handled.isError, false);
    assert.equal(result.toolCallId, toolCallId);
    assert.equal(result.stdout.byteCount, Buffer.byteLength(text));
    assert.equal(result.stdout.lineCount, text.split(/\r\n|\r|\n/u).length);
    assert.equal(result.stdout.preview, text.slice(0, 8 * 1024));
    assert.equal(result.stdout.preview.includes(tail), false);
    assert.equal(result.stdout.truncated, true, "the model-visible preview omits the changing tail");
    assert.ok(result.artifacts.every(summary => store.getArtifact(summary.artifactId)?.runId === run.id));

    const stdoutSummary = result.artifacts.find(summary => summary.role === "stdout");
    assert.ok(stdoutSummary);
    assert.equal(stdoutSummary.artifactId, result.stdout.artifactId);
    assert.equal(stdoutSummary.truncated, false, "the durable full log is complete, not an unknown truncated tail");
    assert.equal(stdoutSummary.redacted, false);
    assert.equal(stdoutSummary.sizeBytes, Buffer.byteLength(text));
    const artifact = store.getArtifact(stdoutSummary.artifactId);
    assert.ok(artifact);
    const artifactPath = join(store.paths.artifactsDir, artifact.path);
    const relativeToFixture = relative(cwd, artifactPath);
    assert.ok(relativeToFixture && !isAbsolute(relativeToFixture) && !relativeToFixture.startsWith(".."),
      "only read the artifact owned by this temporary fixture");
    const fullOutput = await readFile(artifactPath, "utf8");
    assert.equal(fullOutput, text, "inspect the original producer's actual complete artifact, not a synthetic summary");
    assert.ok(fullOutput.endsWith(tail));
    const updates = observedEvents.filter(event => event.type === "tool_update" && event.data.toolCallId === toolCallId);
    assert.ok(updates.length > 0);
    assert.equal(updates.map(event => event.data.partialResult.text).join(""), text,
      "the original Host stream path also observes the changing real tail");

    const journal = store.listEvents(run.id, { limit: 1000 });
    const prepared = journal.filter(event => event.type === "host_command_prepared" && event.data.toolCallId === toolCallId);
    assert.equal(prepared.length, 1);
    const settled = journal.filter(event => event.type === "host_command_settled" && event.data.executionId === prepared[0].data.executionId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].data.outcome, "completed", "real process leader and stdio closure, not a forged no-start receipt");
    results.push(result);
    fullOutputs.push(fullOutput);
    fromSdk({ type: "tool_execution_end", toolCallId, toolName: "bash", result: handled, isError: handled.isError });
    findings.push(finding);
  }

  // Establish all three producer/artifact facts before the expected no-loop check.
  // Equal sizes/previews cannot prove semantic equality when a complete log exists.
  assert.equal(new Set(results.map(result => result.command.command)).size, 1);
  assert.equal(new Set(results.map(result => result.toolCallId)).size, 3);
  assert.equal(new Set(results.map(result => result.stdout.artifactId)).size, 3);
  assert.equal(new Set(results.map(result => result.stdout.preview)).size, 1);
  assert.equal(new Set(results.map(result => result.stdout.byteCount)).size, 1);
  assert.equal(new Set(results.map(result => result.stdout.lineCount)).size, 1);
  assert.equal(new Set(fullOutputs).size, 3);
  assert.equal(observedEvents.filter(event => event.type === "tool_end").length, 3);
  assert.equal(observedEvents.some(event => event.type === "host_command_settled"), false,
    "the real dedicated journal write must not be mislabeled as an original emitter observation");
  assert.deepEqual(findings, [undefined, undefined, undefined],
    "changing complete command output must not trip exact_repeat merely because the bounded preview and sizes are equal");
});
