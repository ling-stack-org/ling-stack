import assert from "node:assert/strict";
import test from "node:test";
import {
  createNodeRerunHostAdmissionPlanV1,
  evaluateNodeRerunAdmission,
  NodeRerunValidationError,
  nodeRerunHostAdmissionPlanFingerprintV1,
  parseNodeRerunIntent,
  parseNodeRerunObservedSource,
} from "../src/node-rerun.ts";

const digest = (character: string): string => character.repeat(64);

function validIntent() {
  return {
    schemaVersion: 1,
    kind: "node_rerun_intent",
    intentId: "intent-001",
    source: {
      runId: "run-001",
      attemptId: "attempt-001",
      nodeId: "node-2",
      graphVersionDigest: digest("a"),
      inputArtifact: { artifactId: "input-001", contentSha256: digest("b") },
      dependencyClosure: {
        complete: true,
        upstream: [{
          nodeId: "node-1",
          nodeVersionDigest: digest("c"),
          inputArtifact: { artifactId: "upstream-input-001", contentSha256: digest("d") },
          outputArtifacts: [{ artifactId: "upstream-output-001", contentSha256: digest("e") }],
          permissionFingerprint: digest("f"),
        }],
        downstreamNodeIds: ["node-3"],
      },
      sourceSnapshotDigest: digest("0"),
    },
    target: {
      executionIdentity: "host_minted",
      fence: "host_minted",
      approval: "fresh_current_policy",
      graphMutation: "none",
    },
    requestedBy: "local-user",
    idempotencyKey: "node-rerun:intent-001",
    createdAt: "2026-11-13T00:00:00.000Z",
  };
}

function validObserved() {
  const intent = validIntent();
  return {
    source: intent.source,
    runStatus: "failed",
    runLifecycle: "ended",
    attemptStatus: "failed",
    stopStatus: "not_required",
    leaseStatus: "expired",
    fenceStatus: "released",
    effectStatus: "settled",
    externalEffectStatus: "none",
    sourcePolicyFingerprint: digest("1"),
    currentPolicyFingerprint: digest("1"),
    currentPolicyAvailable: true,
    permissionStatus: "current",
  };
}

test("A17 valid intent is only eligible for Host admission and never authorized", () => {
  const result = evaluateNodeRerunAdmission({ intent: validIntent(), observed: validObserved() });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "node_rerun_admission",
    decision: "eligible_for_host_admission",
    executionAuthorized: false,
    intentId: "intent-001",
    source: { runId: "run-001", attemptId: "attempt-001", nodeId: "node-2" },
    blockers: [],
    nextStep: "host_must_revalidate_and_mint_identity",
  });
});

test("F5-03 creates a deterministic Host plan without execution identities", () => {
  const intent = parseNodeRerunIntent(validIntent());
  const observed = parseNodeRerunObservedSource(validObserved());
  const admission = evaluateNodeRerunAdmission({ intent, observed });
  const first = createNodeRerunHostAdmissionPlanV1({ intent, observed, admission });
  const second = createNodeRerunHostAdmissionPlanV1({
    intent: { ...intent, source: { ...intent.source, dependencyClosure: { ...intent.source.dependencyClosure } } },
    observed: { ...observed, source: { ...observed.source, dependencyClosure: { ...observed.source.dependencyClosure } } },
    admission,
  });

  assert.deepEqual(second, first);
  assert.equal(first.planId, `node_rerun_plan_${first.planFingerprint}`);
  assert.equal(first.actions.workUnit, "host_minted");
  assert.equal(first.actions.run, "host_minted");
  assert.equal(first.actions.attempt, "host_minted");
  assert.equal(first.actions.fence, "host_minted");
  assert.equal(first.actions.approval, "fresh_current_policy");
  assert.equal(first.actions.graphMutation, "none");
  assert.equal(first.actions.providerDispatch, "disabled");
  assert.equal(first.preconditions.revalidateBeforeWrite, true);
  assert.equal(first.preconditions.sourceSnapshotDigest, intent.source.sourceSnapshotDigest);
  assert.equal(first.preconditions.policyFingerprint, observed.currentPolicyFingerprint);

  const changedKey = { ...intent, idempotencyKey: "node-rerun:intent-002" };
  assert.notEqual(
    nodeRerunHostAdmissionPlanFingerprintV1({
      intent,
      source: intent.source,
      sourcePolicyFingerprint: observed.sourcePolicyFingerprint!,
      currentPolicyFingerprint: observed.currentPolicyFingerprint!,
    }),
    nodeRerunHostAdmissionPlanFingerprintV1({
      intent: changedKey,
      source: changedKey.source,
      sourcePolicyFingerprint: observed.sourcePolicyFingerprint!,
      currentPolicyFingerprint: observed.currentPolicyFingerprint!,
    }),
  );
});

test("F5-03 refuses to mint a plan for blocked or policy-drifted admission", () => {
  const intent = parseNodeRerunIntent(validIntent());
  const observed = { ...parseNodeRerunObservedSource(validObserved()), currentPolicyFingerprint: digest("2") };
  const admission = evaluateNodeRerunAdmission({ intent, observed });
  assert.equal(admission.decision, "blocked");
  assert.throws(() => createNodeRerunHostAdmissionPlanV1({ intent, observed, admission }), NodeRerunValidationError);
});

test("F5-03 revalidates the admission envelope before creating a Host plan", () => {
  const intent = parseNodeRerunIntent(validIntent());
  const observed = parseNodeRerunObservedSource(validObserved());
  const admission = evaluateNodeRerunAdmission({ intent, observed });
  assert.equal(admission.decision, "eligible_for_host_admission");

  const invalidAdmissions: readonly unknown[] = [
    { ...admission, schemaVersion: 2 },
    { ...admission, blockers: ["policy_drift"] },
    { ...admission, nextStep: "manual_review_required" },
    { ...admission, source: { ...admission.source!, runId: "run-other" } },
    { ...admission, intentId: "intent-other" },
  ];
  for (const invalidAdmission of invalidAdmissions) {
    assert.throws(() => createNodeRerunHostAdmissionPlanV1({
      intent,
      observed,
      admission: invalidAdmission as typeof admission,
    }), NodeRerunValidationError);
  }

  assert.throws(() => createNodeRerunHostAdmissionPlanV1({
    intent,
    observed: { ...observed, externalEffectStatus: "non_idempotent" },
    admission,
  }), NodeRerunValidationError);
});

test("A17 blocks active work, unknown effects, policy drift and stale permission together", () => {
  const observed = validObserved();
  observed.runStatus = "running";
  observed.runLifecycle = "active";
  observed.attemptStatus = "lost";
  observed.stopStatus = "unconfirmed";
  observed.leaseStatus = "active";
  observed.fenceStatus = "active";
  observed.effectStatus = "unknown";
  observed.externalEffectStatus = "non_idempotent";
  observed.currentPolicyFingerprint = digest("2");
  observed.permissionStatus = "revoked";
  const result = evaluateNodeRerunAdmission({ intent: validIntent(), observed });
  assert.equal(result.decision, "blocked");
  assert.deepEqual(result.blockers, [
    "source_run_not_terminal",
    "source_attempt_not_stopped",
    "source_lease_active",
    "source_fence_active",
    "source_effect_unconfirmed",
    "external_effect_not_replayable",
    "policy_drift",
    "permission_not_current",
  ]);
});

test("A17 requires a complete dependency closure and pinned dependency output evidence", () => {
  const intent = validIntent();
  intent.source.dependencyClosure.complete = false;
  intent.source.dependencyClosure.upstream[0].outputArtifacts = [];
  const observed = validObserved();
  observed.source = intent.source;
  const result = evaluateNodeRerunAdmission({ intent, observed });
  assert.deepEqual(result.blockers, ["dependency_closure_incomplete", "dependency_evidence_missing"]);
});

test("intent and observation identities are compared before admission", () => {
  const observed = validObserved();
  observed.source = { ...observed.source, sourceSnapshotDigest: digest("9") };
  const result = evaluateNodeRerunAdmission({ intent: validIntent(), observed });
  assert.deepEqual(result.blockers, ["source_identity_mismatch"]);
});

test("strict parsing rejects mutable prompt fields, unknown keys and invalid digests", () => {
  assert.throws(() => parseNodeRerunIntent({ ...validIntent(), prompt: "replay this" }), NodeRerunValidationError);
  assert.throws(() => parseNodeRerunIntent({ ...validIntent(), source: { ...validIntent().source, graphVersionDigest: "not-a-digest" } }), NodeRerunValidationError);
  assert.throws(() => parseNodeRerunObservedSource({ ...validObserved(), cwd: "/mutable/workspace" }), NodeRerunValidationError);
});

test("parser does not execute accessors from untrusted intent objects", () => {
  let executed = false;
  const input = validIntent() as Record<string, unknown>;
  Object.defineProperty(input, "prompt", { enumerable: true, get() { executed = true; return "secret"; } });
  assert.throws(() => parseNodeRerunIntent(input), NodeRerunValidationError);
  assert.equal(executed, false);
});

test("invalid input or observation fails closed without exposing a partial execution plan", () => {
  const invalidIntent = evaluateNodeRerunAdmission({ intent: { kind: "node_rerun_intent" }, observed: validObserved() });
  assert.deepEqual(invalidIntent, {
    schemaVersion: 1,
    kind: "node_rerun_admission",
    decision: "blocked",
    executionAuthorized: false,
    intentId: null,
    source: null,
    blockers: ["invalid_intent"],
    nextStep: "manual_review_required",
  });
  const invalidObserved = evaluateNodeRerunAdmission({ intent: validIntent(), observed: { source: validIntent().source } });
  assert.equal(invalidObserved.decision, "blocked");
  assert.deepEqual(invalidObserved.blockers, ["invalid_observation"]);
});

test("malformed admission envelopes fail closed without executing accessors", () => {
  const malformedInputs = [null, undefined];
  for (const input of malformedInputs) {
    const result = evaluateNodeRerunAdmission(input as unknown as Parameters<typeof evaluateNodeRerunAdmission>[0]);
    assert.deepEqual(result.blockers, ["invalid_intent"]);
    assert.equal(result.executionAuthorized, false);
  }

  let executed = false;
  const input = {} as Record<string, unknown>;
  Object.defineProperties(input, {
    intent: { enumerable: true, get() { executed = true; return validIntent(); } },
    observed: { enumerable: true, get() { executed = true; return validObserved(); } },
  });
  const result = evaluateNodeRerunAdmission(input as unknown as Parameters<typeof evaluateNodeRerunAdmission>[0]);
  assert.deepEqual(result.blockers, ["invalid_intent"]);
  assert.equal(result.executionAuthorized, false);
  assert.equal(executed, false);
});
