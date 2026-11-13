import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FrameworkAssuranceEvidenceResponse } from "@ling-stack/contracts";
import {
  DEFAULT_WORKSPACE_ID, SqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence,
  type DelegationAuthorityCapture, type DelegationBudgetCharge, type DelegationCompletionEvidenceV1, type DelegationUsageReceipt,
} from "@ling-stack/core";
import { createDelegationHostStoreBinding } from "@ling-stack/core/delegation-host-store-bridge";
import { handleGetRunAssuranceEvidence, projectDelegationBudgetEvidence } from "../dist/features/runs/assurance-evidence.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const rootRunId = "root-budget";

function evidence(input: {
  budget?: { tokenBudget?: number; costBudgetMicros?: number };
  reservation?: Record<string, unknown>;
  charges?: readonly Partial<DelegationBudgetCharge>[];
  issues?: readonly Record<string, unknown>[];
  rootOnly?: boolean;
} = {}): DelegationCompletionEvidenceV1 {
  return {
    schemaVersion: 1,
    rootRunIds: [rootRunId],
    roots: [{
      runId: rootRunId,
      budget: input.budget ? {
        schemaVersion: 1,
        rootRunId,
        frozenAt: "2026-11-10T08:00:00.000Z",
        deadlineAt: "2026-11-10T09:00:00.000Z",
        authorityArtifactId: "authority-artifact",
        authorityDigest: "authority-digest",
        createdAt: "2026-11-10T08:00:00.000Z",
        ...input.budget,
      } : undefined,
      charges: input.rootOnly ? input.charges ?? [] : [],
    }],
    steps: input.rootOnly ? [] : [{
      step: { id: "step-budget" },
      reservation: input.reservation,
      charges: input.charges ?? [],
    }],
    issues: input.issues ?? [],
    status: "pending",
    fingerprint: "completion-fingerprint",
  } as unknown as DelegationCompletionEvidenceV1;
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "reservation-budget",
    rootRunId,
    delegationStepId: "step-budget",
    childRunId: "child-budget",
    requestDigest: "request-digest",
    deadlineAt: "2026-11-10T09:00:00.000Z",
    state: "settled",
    settledTokenUsage: 5,
    settledCostMicros: 7,
    idempotencyKey: "reservation-key",
    revision: 1,
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:01:00.000Z",
    settledAt: "2026-11-10T08:02:00.000Z",
    ...overrides,
  };
}

test("settled child usage stays within the root budget", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 10 },
    reservation: reservation(),
  }), rootRunId);
  assert.equal(result.status, "within");
  assert.equal(result.usage.tokenStatus, "within");
  assert.equal(result.usage.costStatus, "within");
  assert.equal(result.usage.tokens, 5);
  assert.equal(result.usage.costMicros, 7);
});

test("an in-flight reservation is pending and remains visible as reserved capacity", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 10 },
    reservation: reservation({ state: "reserved", settledTokenUsage: undefined, settledCostMicros: undefined, settledAt: undefined, tokenReserved: 6, costReservedMicros: 8 }),
  }), rootRunId);
  assert.equal(result.status, "pending");
  assert.equal(result.usage.tokenStatus, "pending");
  assert.equal(result.usage.tokens, 6);
  assert.deepEqual(result.reservations[0], {
    reservationId: "reservation-budget",
    stepId: "step-budget",
    state: "reserved",
    tokenReserved: 6,
    costReservedMicros: 8,
    settledTokenUsage: null,
    settledCostMicros: null,
    failureCode: null,
  });
});

test("unknown usage blocks the budget even when a conservative reservation exists", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 10 },
    charges: [{
      id: "charge-unknown",
      rootRunId,
      runId: rootRunId,
      attemptId: "attempt-budget",
      invocationId: "invocation-budget",
      state: "unresolved",
      reservedTokens: 4,
      reservedCostMicros: 5,
    }],
  }), rootRunId);
  assert.equal(result.status, "unknown");
  assert.equal(result.usage.tokenStatus, "unknown");
  assert.equal(result.usage.tokens, null);
  assert.ok(result.blockers.includes("delegation.usage_unknown"));
});

test("a settled reservation over the root cap is over, without double-counting nested allocation", () => {
  const result = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10, costBudgetMicros: 20 },
    reservation: reservation({ settledTokenUsage: 12, settledCostMicros: 9 }),
  }), rootRunId);
  assert.equal(result.status, "over");
  assert.equal(result.usage.tokenStatus, "over");
  assert.equal(result.usage.tokens, 12);
  assert.equal(result.usage.costMicros, 9);
});

test("missing root authority and corrupt usage remain distinct admission blockers", () => {
  const missing = projectDelegationBudgetEvidence(evidence({ reservation: reservation() }), rootRunId);
  assert.equal(missing.status, "missing");
  assert.equal(missing.usage.tokenStatus, "missing");

  const invalid = projectDelegationBudgetEvidence(evidence({
    budget: { tokenBudget: 10 },
    reservation: reservation(),
    issues: [{ code: "delegation.completion_usage_invalid" }],
  }), rootRunId);
  assert.equal(invalid.status, "invalid");
  assert.ok(invalid.blockers.includes("delegation.completion_usage_invalid"));
});

function rootCharge(overrides: Partial<DelegationBudgetCharge> = {}): DelegationBudgetCharge {
  return {
    id: "root-charge", rootRunId, runId: rootRunId, attemptId: "root-attempt", invocationId: "root-call",
    requestDigest: "root-request", state: "measured", inputTokens: 3, cachedInputTokens: 0, outputTokens: 2,
    actualCostMicros: 7, idempotencyKey: "root-charge", revision: 1,
    createdAt: "2026-11-11T08:00:00.000Z", updatedAt: "2026-11-11T08:00:01.000Z", ...overrides,
  };
}

test("a Run without delegation budget facts remains not applicable", () => {
  const result = projectDelegationBudgetEvidence(evidence({ rootOnly: true }), rootRunId);
  assert.equal(result.status, "not_applicable");
  assert.equal(result.usage.tokens, null);
  assert.deepEqual(result.charges, []);
});

test("a frozen root budget remains visible before any Provider charge or child exists", () => {
  const result = projectDelegationBudgetEvidence(evidence({ rootOnly: true,
    budget: { tokenBudget: 10, costBudgetMicros: 20 } }), rootRunId);
  assert.equal(result.status, "within");
  assert.equal(result.usage.tokens, 0);
  assert.equal(result.usage.costMicros, 0);
  assert.equal(result.roots[0]?.tokenBudget, 10);
  assert.equal(result.roots[0]?.chargeCount, 0);
  assert.deepEqual(result.reservations, []);
});

for (const [name, charge, expected, tokens, cost] of [
  ["measured root usage", rootCharge(), "within", 5, 7],
  ["root token overrun", rootCharge({ inputTokens: 9, outputTokens: 3 }), "over", 12, 7],
  ["root cost overrun", rootCharge({ actualCostMicros: 21 }), "over", 5, 21],
  ["reserved root capacity", rootCharge({ state: "reserved", reservedTokens: 8, reservedCostMicros: 9 }), "pending", 8, 9],
  ["unknown root usage", rootCharge({ state: "unresolved", reservedTokens: 8, reservedCostMicros: 9 }), "unknown", null, null],
  ["unknown root cost", rootCharge({ actualCostMicros: undefined }), "unknown", 5, null],
  ["cancelled root dispatch", rootCharge({ state: "cancelled_before_dispatch" }), "within", 0, 0],
] as const) {
  test(`a root without child steps preserves ${name}`, () => {
    const result = projectDelegationBudgetEvidence(evidence({ rootOnly: true,
      budget: { tokenBudget: 10, costBudgetMicros: 20 }, charges: [charge] }), rootRunId);
    assert.equal(result.status, expected);
    assert.equal(result.usage.tokens, tokens);
    assert.equal(result.usage.costMicros, cost);
    assert.equal(result.charges[0]?.chargeId, charge.id);
    assert.equal(result.charges[0]?.runId, rootRunId);
    assert.equal(result.charges[0]?.state, charge.state);
    assert.equal(result.roots[0]?.chargeCount, 1);
    assert.deepEqual(result.reservations, []);
    if (expected !== "within") assert.ok(result.blockers.length > 0);
  });
}

test("root charges without a frozen budget retain a missing-budget blocker", () => {
  const result = projectDelegationBudgetEvidence(evidence({ rootOnly: true, charges: [rootCharge()] }), rootRunId);
  assert.equal(result.status, "missing");
  assert.equal(result.charges.length, 1);
  assert.ok(result.blockers.includes("delegation.completion_budget_missing"));
});

test("root read issues remain visible even without any mapped budget facts", () => {
  const result = projectDelegationBudgetEvidence(evidence({ rootOnly: true,
    issues: [{ code: "delegation.completion_fact_invalid" }] }), rootRunId);
  assert.notEqual(result.status, "not_applicable");
  assert.ok(result.issues.includes("delegation.completion_fact_invalid"));
  assert.ok(result.blockers.includes("delegation.completion_fact_invalid"));
});

test("the HTTP projection preserves real SQLite root reservations and unknown usage without child steps", async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-assurance-root-budget-")));
  let store: SqliteRunStore | undefined;
  let server: Server | undefined;
  t.after(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    store?.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-11-11T08:00:00.000Z", later = "2026-11-11T08:00:01.000Z";
  let capture: DelegationAuthorityCapture;
  const captureRef = Object.freeze({});
  const receipts = new WeakMap<object, DelegationUsageReceipt>();
  const host = createDelegationHostStoreBinding({
    readCapture(reference) { assert.equal(reference, captureRef); return capture; },
    readCurrentAuthority() { return capture.authority; },
    readUsageReceipt(reference) {
      const receipt = typeof reference === "object" && reference !== null ? receipts.get(reference) : undefined;
      assert.ok(receipt);
      return receipt;
    },
    readChildReceipt() { throw new Error("No delegated child in this fixture"); },
  });
  store = new SqliteRunStore({ cwd, paths: resolveStoragePaths(cwd).workspace, delegationHostBinding: host.binding });
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: rootRunId,
    idempotencyKey: "assurance-root-unit", status: "claimed", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "root-runtime",
    runnerId: "pi", effectiveRunnerId: "pi", status: "created", now });
  const run = store.createRun({ id: rootRunId, cwd, workUnitId: unit.id, taskId: "root-task", providerName: "fixture",
    providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  const fence = toRuntimeAttemptFence(attempt);
  const provider = { providerId: "fixture", baseUrl: "https://provider.invalid/v1", api: "openai-responses", model: "fixture-model" };
  capture = {
    rootRunId: run.id, runId: run.id, sourceFence: fence, currency: "USD", provider, runnerId: "pi",
    budget: { tokenBudget: 100, costBudgetMicros: 100 },
    authority: { schemaVersion: 1, authoritySetId: "root-authority", sourceRevision: "root-policy", workspaceId: DEFAULT_WORKSPACE_ID,
      participantIds: ["engineer"], runnerIds: ["pi"], maxDepth: 2, sandbox: "workspace_write", mayEscalate: false,
      tools: ["read"], toolDecisions: { read: "allow" }, workspaceRoots: [{ path: cwd, access: "write" }],
      providers: [provider], networkScopes: ["provider.invalid"], secretRefs: [] },
    price: { schemaVersion: 1, version: "fixture-price", currency: "USD", scope: provider,
      inputMicrosPerMillionTokens: 1_000_000, cachedInputMicrosPerMillionTokens: 500_000, outputMicrosPerMillionTokens: 2_000_000 },
  };
  const writer = host.writer();
  writer.freezeRootDelegationBudget({ runId: run.id, sourceFence: fence, capture: captureRef, now });
  assert.ok(store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: later, now: later }));
  assert.equal(store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "system", now: later }).ok, true);
  assert.equal(store.transitionRunExecutionStatus({ runId: run.id, sourceFence: fence, expectedStatus: "queued",
    event: "runner_started", actor: "system", now: later }).ok, true);
  const charge = writer.reserveModelInvocation({ runId: run.id, sourceFence: fence, invocationId: "root-provider-call",
    reservedTokens: 20, reservedCostMicros: 30, capture: captureRef, now: later });
  const original = store.getDelegationCompletionEvidence({ rootRunIds: [run.id] });
  assert.equal(original.steps.length, 0);
  assert.equal(original.roots[0]?.charges[0]?.id, charge.id);

  const registry = new RunStoreRegistry(() => store!, { recoverOnOpen: false });
  registry.getStore(cwd);
  const activeRuns = new ActiveRunRegistry();
  server = createServer((request, response) => {
    handleGetRunAssuranceEvidence(response, new URL(request.url!, "http://local"), registry, activeRuns, run.id);
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${run.id}/assurance-evidence`);
  url.searchParams.set("cwd", cwd);
  const read = async () => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return await response.json() as FrameworkAssuranceEvidenceResponse;
  };
  const pending = await read();
  assert.equal(pending.completion.stepCount, 0);
  assert.equal(pending.budget.status, "pending");
  assert.equal(pending.budget.usage.tokens, 20);
  assert.equal(pending.budget.usage.costMicros, 30);
  assert.equal(pending.budget.charges[0]?.chargeId, charge.id);

  const receiptRef = Object.freeze({});
  receipts.set(receiptRef, { kind: "unknown", runId: run.id, attemptId: attempt.id, invocationId: charge.invocationId });
  writer.settleModelInvocation({ chargeId: charge.id, receipt: receiptRef, now: later });
  const unknown = await read();
  assert.equal(unknown.budget.status, "unknown");
  assert.equal(unknown.budget.usage.tokens, null);
  assert.equal(unknown.budget.charges[0]?.state, "unresolved");
  assert.ok(unknown.budget.blockers.includes("delegation.usage_unknown"));
});
