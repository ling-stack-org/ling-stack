import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cancel-observation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "cancel_task", title: "Cancel fixture", prompt: "Only finite-lived test processes" };
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "cancel_run");
  const events = [];
  return {
    cwd, events, store, run, sourceFence,
    execute(source, { signal, onEvent, timeoutMs = 8000 } = {}) {
      return executeUnifiedBashTool({
        store, run, sourceFence, signal,
        request: { toolCallId: "cancel_call", toolName: "bash", cwd, task,
          input: { command: `${quote(process.execPath)} -e ${quote(source)}`, timeoutMs } },
        appendAndMaybeStream(type, data) { events.push({ type, data }); onEvent?.(type, data); },
      });
    },
    async result() {
      const artifact = store.listArtifacts(run.id).find(value => value.title === "Unified exec result");
      assert.ok(artifact, "cancelled commands retain an actual Host result artifact");
      return JSON.parse(await readFile(join(store.paths.artifactsDir, artifact.path), "utf8"));
    },
  };
}

test("cancel is bounded when a detached descendant retains stdout, without claiming it stopped", { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let cancelledAt;
  // The detached fixture only holds inherited pipes and expires after four seconds.
  // It never writes outside the temporary fixture or requires a guessed PID kill.
  const source = `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 4000)'],
      { detached: true, stdio: ['ignore', 1, 2] });
    child.on('spawn', () => { process.stdout.write('READY:' + 'x'.repeat(512)); });
    child.unref();
    setInterval(() => {}, 1000);
  `;
  try {
    await assert.rejects(f.execute(source, { signal: controller.signal, onEvent(type, data) {
      if (type === "tool_update" && data.partialResult?.text?.includes("READY:") && cancelledAt === undefined) {
        cancelledAt = Date.now();
        controller.abort();
      }
    } }), { name: "AbortError" });
    assert.ok(cancelledAt, "cancellation follows actual child launch, not a timing guess");
    assert.ok(Date.now() - cancelledAt < 2500, "inherited pipes must not indefinitely hold cancellation");
    const result = await f.result();
    assert.equal(result.status, "cancelled");
    assert.equal(result.processObservation.descendants, "unverified");
    assert.equal(result.processObservation.stopReason, "cancelled");
    assert.equal(result.processObservation.stdioClosed, false);
    assert.equal(result.processObservation.settledBy, "cleanup_deadline");
    assert.equal(result.stdout.truncated, true, "deadline collection is incomplete even below the preview byte limit");
    assert.equal(result.stderr.truncated, true);
    assert.ok(result.artifacts.filter(artifact => artifact.role !== "result").every(artifact => artifact.truncated));
  } finally {
    controller.abort();
    // Let the finite-lived escaped process expire; expiry is cleanup, not cancellation proof.
    if (cancelledAt) await new Promise(resolve => setTimeout(resolve, Math.max(0, cancelledAt + 4500 - Date.now())));
  }
});

test("ordinary cancelled command records observed exit separately from descendant proof", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.execute("process.stdout.write('READY:' + 'x'.repeat(512)); setInterval(() => {}, 1000);", {
    signal: controller.signal,
    onEvent(type, data) { if (type === "tool_update" && data.partialResult?.text?.includes("READY:")) controller.abort(); },
  }), { name: "AbortError" });
  const result = await f.result();
  assert.equal(result.processObservation.leaderExited, true);
  assert.equal(result.processObservation.stdioClosed, true);
  assert.equal(result.processObservation.descendants, "unverified");
  assert.equal(result.processObservation.stopReason, "cancelled");
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd)[0].state, "stop_unconfirmed");
});
test("timeout escalates a live SIGTERM-ignoring command and exposes unverified descendants", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const started = Date.now();
  const result = await f.execute("process.on('SIGTERM', () => {}); process.stdout.write('running'); setInterval(() => {}, 1000);", { timeoutMs: 300 });
  const value = result.details.unifiedExec;
  assert.equal(value.status, "timed_out");
  assert.equal(value.signal, "SIGKILL");
  assert.equal(value.processObservation.leaderExited, true);
  assert.equal(value.processObservation.stdioClosed, true);
  assert.equal(value.processObservation.stopReason, "timeout");
  assert.equal(value.processObservation.descendants, "unverified");
  assert.ok(result.content[0].text.includes("Do not automatically retry overlapping writes"));
  assert.ok(Date.now() - started < 2500);
});

test("pre-cancelled command does not spawn or write execution artifacts", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.execute("throw new Error('must not run');", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.events.length, 0);
});
