import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../dist/index.js";

/** Real isolated SQLite connections and original in-memory tickets, never replay capabilities. */
export async function createHostCommandPreflightFixture(t, mode = "tracked", bind = true) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-command-preflight-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  other.database.exec("PRAGMA busy_timeout=10");
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", title: "Launch preflight", objective: "Zero producer rejection" }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Run", userInstruction: "Run",
    idempotencyKey: "preflight-turn", payload: { body: "Run", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "preflight-unit", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "preflight-runtime",
    runnerId: "pi", status: "started", now });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now); store.markRunStarted(run.id, now);
  const source = { runId: run.id, ...fence };
  const host = mode === "tracked" ? store.admitHostOperation({ operationId: "preflight-host", source, kind: "command", toolCallId: "call" }) : undefined;
  const command = store.prepareHostCommandExecution({ runId: run.id, sourceFence: fence, toolCallId: "call", cwd,
    command: { kind: "shell", shell: "bash", command: "echo preflight" } });
  if (host && bind) store.bindHostOperationEvidence(host, { kind: "host_command", id: command.executionId });
  store.database.exec("CREATE TABLE launch_preflight_probe(id TEXT PRIMARY KEY)");
  return { cwd, store, other, run, unit, fence, source, host, command, thread, turn,
    launch: (producer, preflight) => host ? store.launchTrackedHostCommandExecution(host, command, producer, preflight)
      : store.launchHostCommandExecution(command, producer, preflight),
    replace: () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2, runtimeInstanceId: "new-runtime",
      runnerId: "pi", status: "started", now: new Date().toISOString() }),
    ask: () => store.createUserInputRequest({ sourceRunId: run.id, sourceItemId: turn.item.id, sourceFence: fence,
      toolCallId: "ask", idempotencyKey: "preflight-ask", toolInput: { schemaVersion: 1, waitMode: "required",
        questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, new Date().toISOString()),
  };
}
