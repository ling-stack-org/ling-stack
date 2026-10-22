import { applyDelegationBudgetMigration } from "../../dist/storage/sqlite/delegation-budget-migration.js";
import { SqliteDelegationWriteStore } from "../../dist/storage/sqlite/delegation-write-store.js";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../dist/index.js";

export const budgetNow = "2026-10-19T00:00:00.000Z";
export const budgetLater = "2026-10-19T00:00:01.000Z";
export const budgetProvider = Object.freeze({ providerId: "fixture", baseUrl: "https://provider.invalid/v1", api: "openai-responses", model: "fixture-model" });
export const budgetPrice = Object.freeze({ schemaVersion: 1, version: "fixture-1", currency: "USD", scope: budgetProvider,
  inputMicrosPerMillionTokens: 1_000_000, cachedInputMicrosPerMillionTokens: 500_000, outputMicrosPerMillionTokens: 2_000_000 });

/** Actual Store/domain primitives on an isolated real SQLite database, no Runner or Provider. */
export function createBudgetHarness(cwd, options = {}) {
  const createdAt = options.now ?? budgetNow;
  const activeAt = options.later ?? budgetLater;
  const store = options.store ?? createSqliteRunStore(cwd);
  const db = store.database;
  db.exec("PRAGMA busy_timeout=10000");
  applyDelegationBudgetMigration({ database: db,
    hasMigration: version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(version, name, createdAt) });
  let root = store.getRun("root");
  let unit; let attempt;
  if (!root) {
    unit = store.createWorkUnit({ id: "root-unit", workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "root",
      status: "claimed", idempotencyKey: "root-unit", createdByActor: "system", request: {}, now: createdAt });
    attempt = store.createWorkUnitAttempt({ id: "root-attempt", workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "runtime", runnerId: "pi", status: "created", now: createdAt });
    root = store.createRun({ id: "root", cwd, workUnitId: unit.id, taskId: "inline-task", providerName: budgetProvider.providerId,
      providerModel: budgetProvider.model, taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt });
    store.linkRunToWorkUnit(root.id, unit.id, createdAt);
  } else {
    unit = store.getWorkUnit(root.workUnitId);
    attempt = store.getWorkUnitAttempt(unit.activeAttemptId);
  }
  const fence = toRuntimeAttemptFence(attempt);
  const authority = { schemaVersion: 1, authoritySetId: "authority-set", sourceRevision: "policy-1", workspaceId: DEFAULT_WORKSPACE_ID,
    participantIds: ["engineer", "qa"], runnerIds: ["pi"], maxDepth: options.maxDepth ?? 3, sandbox: "workspace_write", mayEscalate: false,
    tools: ["read", "write"], toolDecisions: { read: "allow", write: "ask" },
    workspaceRoots: [{ path: cwd, access: "write" }], providers: [budgetProvider], networkScopes: ["provider.invalid"], secretRefs: ["env:QA_KEY"] };
  const budget = { tokenBudget: 100, ...(options.budget ?? {}) };
  const capture = { rootRunId: root.id, runId: root.id, sourceFence: fence, authority, budget,
    currency: "USD", provider: budgetProvider, runnerId: "pi", ...(options.price ? { price: options.price } : {}) };
  const captures = new WeakMap(), usages = new WeakMap(), childReceipts = new WeakMap();
  const issue = (map, payload) => { const token = Object.freeze({}); map.set(token, structuredClone(payload)); return token; };
  const read = (map, token) => {
    if (!map.has(token)) throw Object.assign(new Error("delegation.authority_invalid"), { code: "delegation.authority_invalid" });
    return structuredClone(map.get(token));
  };
  let currentAuthority = structuredClone(authority);
  let faultPort;
  const ports = {
    getRun: id => store.getRun(id), getWorkUnit: id => store.getWorkUnit(id),
    createRunWithinTransaction: input => { const value = store.runSessions.createRunWithinTransaction(input); if (faultPort === "run") throw new Error("injected-run-fault"); return value; },
    createWorkUnitWithinTransaction: input => { const value = store.runtimeWorkUnits.createWorkUnit(input); if (faultPort === "unit") throw new Error("injected-unit-fault"); return value; },
    linkWorkUnitRunWithinTransaction: (id, runId, now) => store.runtimeWorkUnits.updateLinkedRunId(id, runId, now),
    createArtifactWithinTransaction: input => { const value = store.artifacts.createArtifactWithinTransaction(input); if (faultPort === "artifact") throw new Error("injected-artifact-fault"); return value; },
    getArtifact: id => store.getArtifact(id), readCapture: token => read(captures, token),
    readCurrentAuthority: () => structuredClone(currentAuthority), readUsageReceipt: token => read(usages, token), readChildReceipt: token => read(childReceipts, token),
  };
  const writer = new SqliteDelegationWriteStore({ database: db }, ports);
  const captureToken = payload => issue(captures, payload ?? capture);
  const rootCapture = captureToken();
  const freeze = (overrides = {}) => writer.freezeRootDelegationBudget({ runId: root.id, sourceFence: fence,
    capture: rootCapture, now: createdAt, ...overrides });
  const start = (runId = root.id) => {
    const run = store.getRun(runId), ownUnit = store.getWorkUnit(run.workUnitId);
    db.prepare("UPDATE run_sessions SET status='running',started_at=?,ended_at=NULL WHERE id=?").run(createdAt, runId);
    db.prepare("UPDATE work_units SET status='running',started_at=?,ended_at=NULL WHERE id=?").run(createdAt, ownUnit.id);
    db.prepare("UPDATE work_unit_attempts SET status='started',started_at=?,ended_at=NULL WHERE id=?").run(createdAt, ownUnit.activeAttemptId);
  };
  const spawn = (overrides = {}) => writer.prepareDelegatedChild({ parentRunId: root.id, sourceFence: fence, spawnCallId: "spawn", objective: "Create a small fixture",
    requestedBudget: { tokenBudget: 40 }, required: true, capture: rootCapture, now: activeAt, ...overrides });
  const charge = (overrides = {}) => writer.reserveModelInvocation({ runId: root.id, sourceFence: fence, invocationId: "call", reservedTokens: 20,
    capture: rootCapture, now: activeAt, ...overrides });
  const receipt = (charge, changes = {}) => issue(usages, { kind: "measured", runId: charge.runId, attemptId: charge.attemptId, invocationId: charge.invocationId,
    inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, ...changes });
  return { cwd, db, store, root, unit, attempt, fence, authority, capture, rootCapture, writer, ports, freeze, start, spawn, charge, captureToken, receipt,
    childReceipt: payload => issue(childReceipts, payload),
    setCurrentAuthority: value => { currentAuthority = structuredClone(value); }, setFaultPort: value => { faultPort = value; } };
}
