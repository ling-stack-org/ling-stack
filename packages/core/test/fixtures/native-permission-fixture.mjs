import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../dist/index.js";

export async function nativePermissionFixture(t, now = new Date().toISOString()) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-native-permission-"));
  const stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const store = open();
  const channel = store.createChannel({ name: "Permission tests", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Permissions", prompt: "Test" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Permissions", objective: "Test" }, now);
  const run = store.createRun({ id: "run_permission", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
    providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const work = store.createWorkUnit({ id: "wu_permission", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: run.id, idempotencyKey: run.id, createdByActor: "user", request: {},
    linkedRunId: run.id, runnerId: "codex-app-server", now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1,
    runtimeInstanceId: "runtime_permission", runnerId: "codex-app-server", now });
  store.linkRunToWorkUnit(run.id, work.id, now);
  const fence = toRuntimeAttemptFence(attempt);
  const entry = store.reserveNativeExecution({ runId: run.id, generation: 1, fence,
    selection: { engineId: "codex-app-server", profileId: "profile_codex", profileRevision: 1,
      profileFingerprint: "a".repeat(64), configurationFingerprint: "b".repeat(64) } }, now);
  const key = { submissionId: entry.submission.id, fence };
  store.bindNativeExecutionSession({ ...key, nativeSessionId: "permission-thread" }, now);
  store.beginNativeSubmission(key, now);
  store.acceptNativeSubmission({ ...key, nativeTurnId: "permission-turn" }, now);
  const expiresAt = new Date(Date.parse(now) + 300000).toISOString();
  const payload = { type: "native_permission_request", version: 1, scope: "turn", cwd, reason: "Read the fixture",
    resources: [{ kind: "filesystem", access: "read", target: { kind: "path", path: cwd } }] };
  let requestId = 0;
  const input = (changes = {}) => ({ ...key, method: "item/permissions/requestApproval", requestId: ++requestId,
    approval: { actionType: "runtime_permission_request", risk: "high", toolCallId: `permission-item-${requestId}`,
      title: "Approve turn permissions", description: payload.reason, payload: structuredClone(payload), expiresAt, ...changes } });
  const create = (changes = {}) => store.createNativeApproval(input(changes), now).approval;
  return { cwd, store, open, now, run, key, payload, input, create };
}
