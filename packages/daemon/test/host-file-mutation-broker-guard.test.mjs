import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSessionRunPolicy } from "@ling-stack/core";
import { executeHarnessedFileMutationTool } from "../dist/features/harness/tool-execution/broker.js";
import { createFileMutationActionDraft } from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";
import { appendExecutionActionArtifactEvents } from "../dist/features/runs/action-artifacts.js";

async function fixture(t, mode) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-host-file-broker-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: `guard-${mode}`, title: "File guard", prompt: "Bounded file operation" };
  const f = createUnifiedExecFixture(t, cwd, task, `guard-${mode}`);
  const request = { toolName: "write", toolCallId: `write-${mode}`, cwd, task,
    input: { path: "guarded.txt", content: "guarded\n" } };
  const draft = createFileMutationActionDraft({ request, allowedWritePaths: [cwd] });
  return { ...f, cwd, request, draft, execute(hostOperation, extra = {}) {
    return executeHarnessedFileMutationTool({ mode, store: f.store, run: f.run, sourceFence: f.sourceFence,
      request, draft, allowedWritePaths: [cwd], hostOperation,
      effectivePolicySnapshot: resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
        authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot,
      appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data), ...extra });
  } };
}

for (const mode of ["off", "shadow", "enforce"]) {
  test(`${mode} file Broker never bypasses actual-effect admission`, async t => {
    const f = await fixture(t, mode), calls = [];
    const result = await f.execute({ assertMayPrepare() { calls.push("prepare"); },
      bindHarnessExecution(id) {
        const record = f.store.getHarnessToolExecution(id);
        assert.equal(record.runId, f.run.id);
        assert.equal(record.attemptId, f.sourceFence.attemptId);
        assert.equal(record.toolCallId, f.request.toolCallId);
        assert.equal(record.executionStartedAt, undefined);
        calls.push("bind");
      }, effectGuard: { launch() { calls.push("launch"); throw new Error("admission_closed"); },
        cleanup() { assert.fail("unlaunched file has no cleanup"); } } });
    assert.equal(result.isError, true);
    assert.equal(existsSync(join(f.cwd, "guarded.txt")), false);
    assert.ok(calls.includes("prepare"));
    assert.equal(calls.filter(call => call === "launch").length, mode === "off" ? 0 : 1);
    assert.equal(calls.includes("bind"), mode !== "off");
    if (mode === "off") assert.match(result.content[0].text, /host_file_broker_evidence_required/u);
  });
  test(`${mode} admission rejection precedes preparation and disk writes`, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.execute({ assertMayPrepare() { throw new Error("admission_closed"); },
      bindHarnessExecution() { assert.fail("closed admission cannot bind an execution"); },
      effectGuard: { launch() { assert.fail("closed admission cannot launch"); }, cleanup() { assert.fail("no effect"); } } }),
    /admission_closed/u);
    assert.equal(f.store.listHarnessToolExecutions(f.run.id).length, 0);
    assert.equal(existsSync(join(f.cwd, "guarded.txt")), false);
  });
}

test("tracked shadow Broker never falls back to an operation without exact durable evidence", async t => {
  const f = await fixture(t, "shadow-fallback");
  const original = f.store.prepareHarnessToolExecution;
  f.store.prepareHarnessToolExecution = () => { throw new Error("unavailable_broker"); };
  t.after(() => { f.store.prepareHarnessToolExecution = original; });
  let launches = 0;
  // Use the same real fallback path but with a valid mode.
  const request = f.request, draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
  const result = await executeHarnessedFileMutationTool({ mode: "shadow", store: f.store, run: f.run,
    sourceFence: f.sourceFence, request, draft, allowedWritePaths: [f.cwd],
    hostOperation: { assertMayPrepare() {}, bindHarnessExecution() { assert.fail("no Broker identity exists"); },
      effectGuard: { launch() { launches++; throw new Error("admission_closed"); }, cleanup() { assert.fail("no effect"); } } },
    appendAndMaybeStream: (type, data) => f.store.appendEvent(f.run.id, type, data) });
  assert.equal(result.isError, true);
  assert.equal(launches, 0);
  assert.equal(existsSync(join(f.cwd, "guarded.txt")), false);
});

test("failed exact binding cannot fall back to an untracked write", async t => {
  const f = await fixture(t, "shadow");
  const result = await f.execute({ assertMayPrepare() {}, bindHarnessExecution() { throw new Error("binding_invalid"); },
    effectGuard: { launch() { assert.fail("unbound effect is forbidden"); }, cleanup() { assert.fail("no effect"); } } });
  assert.equal(result.isError, true);
  assert.equal(existsSync(join(f.cwd, "guarded.txt")), false);
  assert.equal(f.store.listHarnessToolExecutions(f.run.id)[0].executionStartedAt, undefined);
});

test("successful Broker evidence is committed only after the guarded real file write", async t => {
  const f = await fixture(t, "enforce");
  let boundId, physicalWrites = 0;
  const result = await f.execute({ assertMayPrepare() {}, bindHarnessExecution(id) { boundId = id; },
    effectGuard: { launch(effect) {
      assert.ok(boundId);
      assert.equal(f.store.getHarnessToolExecution(boundId).state, "executing");
      assert.equal(existsSync(join(f.cwd, "guarded.txt")), false);
      physicalWrites++;
      return effect();
    }, cleanup() { assert.fail("successful effect needs no rollback"); } } });
  assert.equal(result.isError, undefined);
  assert.equal(physicalWrites, 1);
  assert.equal(readFileSync(join(f.cwd, "guarded.txt"), "utf8"), "guarded\n");
  assert.equal(f.store.getHarnessToolExecution(boundId).state, "succeeded");
});

test("approved file result has sealed durable evidence without publishing the private payload", async t => {
  const f = await fixture(t, "enforce");
  const approval = f.store.createApprovalRequest({ runId: f.run.id, taskId: f.run.taskId,
    toolCallId: f.request.toolCallId, actionType: "write", risk: "medium", title: "Approved write",
    description: "File guard evidence", payload: f.draft.payload }, new Date().toISOString());
  f.store.approveApprovalRequest(approval.id, { reason: "Isolated test" }, new Date().toISOString());
  const result = await f.execute(undefined, { approvalId: approval.id });
  assert.equal(result.isError, undefined);
  const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
  const artifact = execution.evidenceArtifactIds.map(id => f.store.getArtifact(id))
    .find(value => value?.path.endsWith("/patch-result.json"));
  assert.ok(artifact?.sealedPayload, "file completion requires immutable SQLite result evidence");
  assert.equal(artifact.sealedPayload.status, "applied");
  assert.match(artifact.contentSha256, /^[a-f0-9]{64}$/u);
  const published = [];
  appendExecutionActionArtifactEvents({ artifacts: [artifact], approval, role: "result",
    appendAndMaybeStream: (_type, data) => { published.push(data); } });
  assert.equal(published.length, 1);
  assert.equal(Object.hasOwn(published[0].artifact, "sealedPayload"), false);
  assert.equal(Object.hasOwn(published[0].artifact, "contentSha256"), false);
  const storedEvent = f.store.listEvents(f.run.id).find(event => event.type === "artifact_created"
    && event.data.artifactId === artifact.id);
  assert.ok(storedEvent);
  assert.equal(Object.hasOwn(storedEvent.data.artifact, "sealedPayload"), false);
});
