import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Packer } from "docx";
import { DEFAULT_WORKSPACE_ID, digestHarnessToolValue, toRuntimeAttemptFence } from "@ling-stack/core";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { createDefaultMcpBroker, createHostOfficeLocalGenerationFacade } from "../dist/features/mcp/broker.js";
import { captureMcpResultAuthority } from "../dist/features/mcp/result-authority.js";
import { officeDocumentTools } from "../dist/features/plugins/office-documents-generation-broker.js";
import { createOriginalOfficeDirectoryStoreFactory } from "../dist/features/office-documents/office-local-directory-core-authority.js";
import { callback, count, reservedConsumer, rows, snapshot } from "./support/office-local-directory-consumer-callback-fixture.mjs";
import * as officeAuthority from "../dist/features/office-documents/office-local-authority.js";

// Portable mechanism and unconfigured refusal tests. No reviewed addon/stage is
// loaded, and none of these cases stands in for genuine native conformance.
const now = () => new Date().toISOString();
const nestedMessage = (error, message) => error?.message === message || (error?.cause && nestedMessage(error.cause, message))
  || (Array.isArray(error?.errors) && error.errors.some(cause => nestedMessage(cause, message)));

/** Original composition without Host-reviewed native configuration; no addon or stage resource is acquired. */
function unconfigured(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-consumer-unconfigured-")));
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  const store = createOriginalOfficeDirectoryStoreFactory(supervisor)(cwd), runtime = supervisor.getRuntime(cwd, store);
  t.after(() => { supervisor.releaseAll(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const at = now(), id = randomUUID();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: runtime.runtimeInstanceId,
    runnerId: "pi", status: "started", now: at });
  store.createRun({ id, cwd, workUnitId: unit.id, taskId: id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit(id, unit.id, at); store.markRunStarted(id, at);
  const source = { runId: id, ...toRuntimeAttemptFence(attempt) }, tracker = new AttemptHostOperationTracker({ store, source });
  const baseBroker = createDefaultMcpBroker(), factory = createHostOfficeLocalGenerationFacade({ baseBroker, workspaceCwd: cwd, facade: baseBroker });
  const server = store.createMcpServer({ id: OFFICE_DOCUMENTS_MCP_SERVER_ID, displayName: "Office", enabled: true, required: false,
    transport: { type: "streamable-http", url: "http://127.0.0.1:1/never-used", headers: {}, secretHeaderRefs: {} } }, at);
  store.replaceMcpServerTools(server.id, officeDocumentTools, at);
  return { cwd, supervisor, store, source, tracker, factory, server, rawName: "office_create_document", toolCallId: "unconfigured",
    request: { path: "new/nested/result.docx", blocks: [{ type: "paragraph", text: "No implicit native authority" }] } };
}

test("unconfigured original Host explicitly refuses missing-directory create with zero effects and retained blockers", async t => {
  const f = unconfigured(t); let projections = 0;
  await assert.rejects(callback(f, { onResult() { projections++; } }).call(),
    error => nestedMessage(error, "office_local_native_artifact_unconfigured"));
  assert.equal(existsSync(join(f.cwd, "new")), false); assert.equal(projections, 0);
  assert.equal(count(f, "host_office_local_executions"), 0); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.equal(rows(f).length, 2); assert.ok(rows(f).every(row => row.phase === "unknown_outcome"));
  assert.ok(snapshot(f).operations.every(row => row.state === "blocked"));
});

test("unconfigured V2 selection privately latches the original reservation against no-start and V1 fallback before public reads", async t => {
  const f = unconfigured(t), original = reservedConsumer(f);
  await assert.rejects(original.invoke(), error => nestedMessage(error, "office_local_native_artifact_unconfigured"));
  assert.ok(Object.isFrozen(original.reservation)); assert.deepEqual(Reflect.ownKeys(original.reservation), []);
  const ownerRead = t.mock.method(f.store, "isCurrentRunExecutionOwner", () => assert.fail("selected V2 must reject fallback before a replaceable public authority read"));
  const corePrepare = t.mock.method(f.store, "prepareHostOfficeLocalExecution", () => assert.fail("selected V2 cannot prepare V1"));
  assert.throws(() => officeAuthority.settleOfficeLocalReservationNoStart(original.reservation), /office_local_protocol_mismatch/u);
  // Rejection must precede all V1 argument reads: absent data is not itself the
  // guard, and neither closed lifecycle nor caller-editable DTO selects it.
  assert.throws(() => officeAuthority.prepareOfficeLocalWrite(original.reservation, undefined, undefined, "unused", "unused"),
    /office_local_protocol_mismatch/u);
  assert.deepEqual([ownerRead.mock.callCount(), corePrepare.mock.callCount()], [0, 0]);
  assert.equal(count(f, "host_office_local_executions"), 0); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.equal(count(f, "host_office_local_no_start_receipts"), 0); assert.equal(existsSync(join(f.cwd, "new")), false);
  assert.ok(rows(f).every(row => row.phase === "unknown_outcome")); assert.ok(snapshot(f).operations.every(row => row.state === "blocked"));
});

for (const fallback of ["generic no-start", "V1 preparation"]) {
  test(`unconfigured V2 claim owner reader cannot synchronously reenter ${fallback} before its private route latch`, async t => {
    const f = unconfigured(t), original = reservedConsumer(f);
    const serialize = Packer.toBuffer.bind(Packer), tools = f.store.listMcpTools.bind(f.store);
    const owner = f.store.isCurrentRunExecutionOwner.bind(f.store);
    let phase = "beforeSerializer", serializedBytes, toolReadReturned = false,
      reentered = false, fallbackReturned = false, reentryError, inReentry = false, nestedOwnerReads = 0;
    t.mock.method(Packer, "toBuffer", async (...args) => {
      serializedBytes = await serialize(...args);
      phase = "postSerializer";
      return serializedBytes;
    });
    t.mock.method(f.store, "listMcpTools", (...args) => {
      const result = tools(...args);
      // This original MCP reader completes the post-serializer forward fence;
      // the next owner reader is inside the actual production V2 route claim.
      // The handshake uses actual returns, not stack matching or call counts.
      if (phase === "postSerializer") { toolReadReturned = true; phase = "claimOwner"; }
      return result;
    });
    t.mock.method(f.store, "isCurrentRunExecutionOwner", (...args) => {
      if (inReentry) nestedOwnerReads++;
      if (phase === "claimOwner") {
        phase = "done"; reentered = true; inReentry = true;
        try {
          if (fallback === "generic no-start") officeAuthority.settleOfficeLocalReservationNoStart(original.reservation);
          else officeAuthority.prepareOfficeLocalWrite(original.reservation, undefined, undefined, "unused", "unused");
          fallbackReturned = true;
        } catch (error) { reentryError = error; }
        finally { inReentry = false; }
      }
      return owner(...args);
    });
    const corePrepare = t.mock.method(f.store, "prepareHostOfficeLocalExecution");
    await assert.rejects(original.invoke(), error => nestedMessage(error, "office_local_native_artifact_unconfigured"));
    assert.ok(Buffer.isBuffer(serializedBytes) && serializedBytes.length > 0);
    assert.equal(toolReadReturned, true); assert.equal(reentered, true); assert.equal(fallbackReturned, false);
    assert.equal(reentryError?.message, "office_local_protocol_mismatch");
    assert.deepEqual([nestedOwnerReads, corePrepare.mock.callCount()], [0, 0]);
    assert.equal(count(f, "host_office_local_executions"), 0); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
    assert.equal(count(f, "host_office_local_no_start_receipts"), 0); assert.equal(existsSync(join(f.cwd, "new")), false);
    assert.equal(rows(f).length, 2); assert.ok(rows(f).every(row => row.phase === "unknown_outcome"));
    assert.equal(snapshot(f).operations.length, 2); assert.ok(snapshot(f).operations.every(row => row.state === "blocked"));
    t.diagnostic(`original claim owner ${fallback}: protocol_mismatch before ${nestedOwnerReads} nested owner reads; original pair unknown/blocked`);
  });
}

test("existing parent create ignores caller V2 claims and keeps the original V1 policy digest", async t => {
  const f = unconfigured(t); mkdirSync(join(f.cwd, "existing"));
  const input = { ...f.request, path: "existing/result.docx", directoryV2: true, runtime: { coreSafe: true } };
  const authority = captureMcpResultAuthority(f.store, f.server.id, f.rawName).authority, c = callback(f);
  const result = await c.call(f.rawName, input), execution = f.store.getHostOfficeLocalExecution(f.store.database
    .prepare("SELECT execution_id FROM host_office_local_executions").get().execution_id);
  assert.equal(result.details.path, join(f.cwd, input.path)); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.equal(execution.policyDigest, digestHarnessToolValue({ protocol: "ling-office-local-binary-v1", authority,
    approval: c.definitions.find(tool => tool.rawName === f.rawName).defaultApproval }));
  assert.ok(rows(f).every(row => row.phase === "safe"));
});

test("strict overwrite true missing-directory create preserves the independent V1 refusal instead of selecting V2", async t => {
  const f = unconfigured(t);
  await assert.rejects(callback(f).call(f.rawName, { ...f.request, overwrite: true }),
    error => nestedMessage(error, "office_local_directory_creator_unverified"));
  assert.equal(count(f, "host_office_local_executions"), 1); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.equal(existsSync(join(f.cwd, "new/nested/result.docx")), false); assert.ok(rows(f).every(row => row.phase !== "safe"));
});

test("serializer failure before V2 selection safely closes only the original unprepared pair and creates no directory", async t => {
  const f = unconfigured(t), failure = new Error("original SDK failed before V2 selection");
  t.mock.method(Packer, "toBuffer", async () => { await Promise.resolve(); throw failure; });
  await assert.rejects(callback(f).call(), error => error.cause === failure);
  assert.equal(existsSync(join(f.cwd, "new")), false); assert.equal(count(f, "host_office_local_directory_v2_executions"), 0);
  assert.ok(rows(f).every(row => row.phase === "safe" && row.settlementKind === "known_no_start"));
});
