import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { createSqliteWorkflowIntegrationCoordinatorStore, workflowIsolationDigest, workflowIsolationSafetyFingerprint,
  workflowIsolationStepSafetyFingerprint, workflowStepSafetyPlanDigest } from "../dist/index.js";
import { workflowIsolationResultsFixture, now } from "./support/workflow-isolation-results-fixture.mjs";

const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};
const rejected = result => assert.ok(["invalid", "stale", "conflict", "blocked"].includes(result.status), JSON.stringify(result));

async function fixture(t, { terminal = true, result = "confirmed", finishStep = true } = {}) {
  const f = await workflowIsolationResultsFixture(t, { terminal });
  if (terminal && result !== "missing") {
    f.resultIntent();
    if (result !== "pending") f.resultReceipt({ outcome: result,
      ...(result === "confirmed" ? {} : { observedCommit: null }) });
  }
  if (finishStep) f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { status: "succeeded" }, now());
  f.coordinator = () => createSqliteWorkflowIntegrationCoordinatorStore(f.store);
  f.read = (overrides = {}) => f.coordinator().assertAuthority({ roundId: f.roundId, generation: f.plan.generation, now: now(), ...overrides });
  f.authorized = () => { const read = f.read(); assert.equal(read.status, "authorized", JSON.stringify(read)); return read; };
  f.identity = f.gitIdentity(true, f.inputs.integration);
  f.integrationScope = { roundId: f.roundId, stepId: "integration", generation: f.plan.generation,
    worktreeId: f.inputs.integration.worktreeId, executionRoot: f.inputs.integration.executionRoot,
    branchRef: f.inputs.integration.branchRef, baseCommit: f.inputs.baseCommit,
    worktreeRoot: dirname(f.inputs.integration.executionRoot), repository: f.scope.repository };
  f.integrationReceipt = { worktreeId: f.integrationScope.worktreeId, executionRoot: f.integrationScope.executionRoot,
    branchRef: f.integrationScope.branchRef, baseCommit: f.inputs.baseCommit,
    commonDir: f.inputs.repositoryIdentity.commonDir, rootDevice: "1", rootInode: "31" };
  let serial = 0;
  f.advanceInput = (to, overrides = {}) => {
    const authority = f.authorized();
    return { roundId: f.roundId, generation: f.plan.generation, expectedRevision: f.round().revision,
      authorityDigest: authority.authorityDigest, from: f.round().phase, to,
      receiptIds: f.coordinator().listReceipts({ roundId: f.roundId, generation: f.plan.generation })
        .filter(receipt => receipt.outcome === "confirmed").map(receipt => receipt.receiptId), now: now(), ...overrides };
  };
  f.collect = () => value(f.coordinator().advanceRound(f.advanceInput("collecting")));
  f.creationInput = (overrides = {}) => {
    const authority = f.authorized();
    const before = { ...f.identity, exists: false, headCommit: null };
    delete before.tree;
    delete before.cleanStateDigest;
    const payload = { schemaVersion: 1, kind: "workflow_integration_coordinator_effect", roundId: f.roundId,
      generation: f.plan.generation, authorityDigest: authority.authorityDigest, effectKey: "worktree:create",
      effectKind: "integration_create", before, after: f.identity,
      effect: { kind: "workflow_integration_worktree", scope: f.integrationScope } };
    const artifact = f.sealed(`coordinator-effect-${++serial}`, payload);
    return { roundId: f.roundId, generation: f.plan.generation, expectedRevision: f.round().revision,
      authorityDigest: authority.authorityDigest, effectKey: payload.effectKey, kind: payload.effectKind,
      before, after: f.identity, payloadArtifactId: artifact.id, now: now(), ...overrides };
  };
  f.receiptInput = (effect, overrides = {}) => {
    const { outcome = "confirmed", observed = effect.after,
      evidence = { scope: f.integrationScope, receipt: f.integrationReceipt }, ...rest } = overrides;
    const body = { schemaVersion: 1, kind: "workflow_integration_coordinator_receipt", intentId: effect.intentId,
      effectKey: effect.effectKey, outcome, observed, evidence };
    const artifact = f.sealed(`coordinator-observation-${++serial}`, body);
    return { intentId: effect.intentId, expectedRevision: f.round().revision, authorityDigest: effect.authorityDigest,
      outcome, observed, artifactId: artifact.id, now: now(), ...rest };
  };
  f.effects = () => f.coordinator().listEffects({ roundId: f.roundId, generation: f.plan.generation });
  f.receipts = () => f.coordinator().listReceipts({ roundId: f.roundId, generation: f.plan.generation });
  f.snapshotCoordinator = () => {
    const tables = f.store.database.prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND (name LIKE 'workflow_isolation_%' OR name LIKE 'workflow_integration_%'
        OR name IN ('channel_workflows','channel_workflow_steps','state_transition_events',
          'harness_artifact_pins','harness_artifact_pin_events','resource_leases','runtime_semaphore_slots')) ORDER BY name`).all();
    return Object.fromEntries(tables.map(({ name }) => [name, f.store.database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  };
  f.noWrites = action => { const before = f.snapshotCoordinator(), result = action(); assert.deepEqual(f.snapshotCoordinator(), before); return result; };
  return f;
}

test("round authority uses real drained terminal results after release without granting a live writer", async t => {
  const f = await fixture(t); f.release();
  const binding = f.binding(), round = f.round(), authority = f.noWrites(() => f.authorized());
  assert.deepEqual(authority.writer, f.writer);
  assert.equal(authority.participants.length, 1);
  assert.deepEqual(authority.participants[0].binding, binding);
  assert.deepEqual(authority.participants[0].plan, f.isolation.getScopePlan(f.plan.planId));
  assert.equal(authority.participants[0].proofDigest, f.readAuthority().proofDigest);
  assert.deepEqual(authority.participants[0].resultIntent, f.isolation.getTerminalResultIntent(binding.bindingId));
  assert.deepEqual(f.round(), round);
  assert.equal(f.isolation.assertExecutionBinding({ writer: f.writer, now: now() }).status, "stale");
  assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
});

for (const result of ["missing", "pending", "blocked", "effect_unknown"]) {
  test(`round authority rejects ${result} terminal result evidence without changing journals`, async t => {
    const f = await fixture(t, { result });
    rejected(f.noWrites(() => f.read()));
    assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
  });
}

test("a terminal Run is not a semantically closed workflow step", async t => {
  const f = await fixture(t, { finishStep: false });
  assert.equal(f.store.getRun(f.prepared.run.id).status, "succeeded");
  assert.equal(f.current(f.scopeIsolation).status, "running");
  rejected(f.noWrites(() => f.read()));
});

test("step success and status alone never substitute for Host drain or terminal proof", async t => {
  const f = await fixture(t, { terminal: false });
  rejected(f.noWrites(() => f.read()));
  assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
});

for (const generation of [0, 2]) {
  test(`authority rejects noncurrent generation ${generation}`, async t => {
    const f = await fixture(t);
    rejected(f.noWrites(() => f.read({ generation })));
  });
}

const mutations = {
  workflowCancelled: f => f.store.database.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.plan.workflowId),
  workflowFailed: f => f.store.database.prepare("UPDATE channel_workflows SET status='failed' WHERE id=?").run(f.plan.workflowId),
  taskCancelled: f => f.store.database.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(f.generation.task.id),
  runCancelled: f => f.store.database.prepare("UPDATE run_sessions SET status='cancelled' WHERE id=?").run(f.prepared.run.id),
  lateAbort: f => f.store.database.prepare("UPDATE work_unit_attempts SET abort_requested_at=? WHERE id=?").run(now(), f.writer.attemptId),
  currentRunRemoved: f => f.store.database.prepare("UPDATE tasks SET current_run_id=NULL WHERE id=?").run(f.generation.task.id),
  sourceProofChanged: f => f.store.database.prepare("UPDATE run_sessions SET error_message='late source drift' WHERE id=?").run(f.prepared.run.id),
  packetHashChanged: f => f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(f.packetArtifact.id),
  resultReceiptHashChanged: f => {
    const row = f.store.database.prepare("SELECT artifact_id FROM workflow_isolation_result_receipts WHERE outcome='confirmed'").get();
    f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(row.artifact_id);
  },
  pinRemoved: f => {
    const metadata = { ...f.current(f.scopeIsolation).metadata }; delete metadata.isolationScopePlan;
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), f.plan.workflowStepId);
  },
  metadataReplaced: f => f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json='{}' WHERE id=?").run(f.plan.workflowStepId),
  metadataCleared: f => f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=NULL WHERE id=?").run(f.plan.workflowStepId),
  pinChanged: f => {
    const metadata = { ...f.current(f.scopeIsolation).metadata, isolationScopePlan: { planId: f.plan.planId, planDigest: "foreign" } };
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), f.plan.workflowStepId);
  },
  activePostGate: f => {
    const metadata = { ...f.current(f.scopeIsolation).metadata, activeGateStage: "post" };
    f.store.database.prepare("UPDATE channel_workflow_steps SET metadata_json=? WHERE id=?").run(JSON.stringify(metadata), f.plan.workflowStepId);
  },
};

test("listRounds reads all persisted rounds or only the requested workflow without writes", async t => {
  const f = await fixture(t);
  const source = f.store.getChannelWorkflow(f.plan.workflowId), sourceStep = f.current(f.scopeIsolation);
  const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "Other isolated workflow",
    objective: source.objective, status: "ready", createdBy: "system", metadata: source.metadata }, now());
  const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: sourceStep.title, prompt: sourceStep.prompt,
    toParticipantId: sourceStep.toParticipantId, toParticipantLabel: sourceStep.toParticipantLabel }, now());
  const metadata = structuredClone(sourceStep.metadata);
  delete metadata.startOwner;
  delete metadata.isolationScopePlan;
  const safetyPlan = { ...metadata.safetyPlan, workflowId: workflow.id, workflowStepId: step.id,
    executionRoot: `${f.root}/isolated-step-2`, writeRoots: [`${f.root}/isolated-step-2`] };
  delete safetyPlan.digest;
  metadata.safetyPlan = { ...safetyPlan, digest: workflowStepSafetyPlanDigest(safetyPlan) };
  const plannedStep = f.store.updateChannelWorkflowStep(step.id, { metadata }, now());
  const safetyPins = [{ workflowStepId: step.id, fingerprint: workflowIsolationStepSafetyFingerprint(plannedStep) }];
  const otherRound = value(f.isolation.createIntegrationRound({ roundId: "isolation-round-0", now: now(), inputs: {
    ...f.inputs, workflowId: workflow.id, safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins),
    participants: [{ workflowStepId: step.id, position: step.position, required: true }], mergeOrder: [step.id],
    integration: { executionRoot: `${f.root}/isolated-integration-2`, worktreeId: "integration-worktree-2",
      branchRef: "refs/heads/ling/integration-2" },
  } }));
  const empty = f.store.createChannelWorkflow({ channelId: f.channel.id, title: "No isolated round",
    objective: "No isolation planned", status: "ready", createdBy: "system" }, now());
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds()), [otherRound, f.round()]);
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds(f.plan.workflowId)), [f.round()]);
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds(workflow.id)), [otherRound]);
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds(empty.id)), []);
});

test("listRounds retains durable accepted rounds after pin removal and SQLite reopen", async t => {
  const f = await fixture(t), round = f.round();
  mutations.pinRemoved(f);
  assert.equal(f.current(f.scopeIsolation).metadata.isolationScopePlan, undefined);
  const before = f.snapshotCoordinator();
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds()), [round]);
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds(f.plan.workflowId)), [round]);
  f.reopenIsolation();
  assert.equal(f.current(f.scopeIsolation).metadata.isolationScopePlan, undefined);
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds()), [round]);
  assert.deepEqual(f.noWrites(() => f.coordinator().listRounds(f.plan.workflowId)), [round]);
  assert.deepEqual(f.snapshotCoordinator(), before);
});

test("startup recovery does not promote a sealed terminal Run to semantic step or workflow success", async t => {
  const f = await fixture(t, { finishStep: false }); f.release();
  assert.equal(f.store.getRun(f.prepared.run.id).status, "succeeded");
  assert.equal(f.isolation.getTerminalResultIntent(f.writer.bindingId).status, "confirmed");
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).metadata?.requiredParticipantManifest, undefined);
  for (const reopen of [false, true]) {
    if (reopen) f.reopenIsolation();
    const before = f.snapshot();
    assert.equal(f.noWrites(() => f.store.recoverStaleChannelWorkflows(now())), 0);
    assert.equal(f.current(f.scopeIsolation).status, "running");
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "running");
    assert.deepEqual(f.snapshot(), before);
  }
});

for (const removePin of [false, true]) {
  test(`startup recovery leaves semantic success awaiting a candidate without throwing (pin ${removePin ? "removed" : "present"})`, async t => {
    const f = await fixture(t); f.release();
    if (removePin) mutations.pinRemoved(f);
    assert.equal(f.round().candidate, undefined);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).metadata?.requiredParticipantManifest, undefined);
    assert.ok(f.store.listChannelWorkflowSteps({ workflowId: f.plan.workflowId, complete: true })
      .every(step => step.status === "succeeded" || step.status === "skipped"));
    for (const reopen of [false, true]) {
      if (reopen) f.reopenIsolation();
      const before = f.snapshot();
      assert.doesNotThrow(() => assert.equal(f.noWrites(() => f.store.recoverStaleChannelWorkflows(now())), 0));
      assert.equal(f.current(f.scopeIsolation).status, "succeeded");
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, "running");
      assert.equal(f.round().candidate, undefined);
      assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
      assert.deepEqual(f.snapshot(), before);
    }
  });
}

for (const [name, mutate] of Object.entries(mutations)) {
  test(`terminal round authority and completion fail closed on ${name}`, async t => {
    const f = await fixture(t); f.authorized(); mutate(f);
    rejected(f.noWrites(() => f.read()));
    assert.equal(typeof f.noWrites(() => f.coordinator().readCompletionBlocker(f.plan.workflowId)), "string");
    if (!["workflowCancelled", "workflowFailed"].includes(name)) {
      const before = f.snapshotCoordinator();
      assert.throws(() => f.store.updateChannelWorkflow(f.plan.workflowId, { status: "succeeded" }, now()), /workflow_isolation|workflow_integration/);
      assert.deepEqual(f.snapshotCoordinator(), before);
      assert.notEqual(f.store.getChannelWorkflow(f.plan.workflowId).status, "succeeded");
    }
  });
}

test("accepted durable scopes still block raw and transition success after all visible pins disappear", async t => {
  const f = await fixture(t); mutations.pinRemoved(f);
  assert.equal(f.store.listChannelWorkflowSteps({ workflowId: f.plan.workflowId, complete: true }).some(step => step.metadata?.isolationScopePlan), false);
  assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM workflow_isolation_scope_plans WHERE workflow_id=?").get(f.plan.workflowId).n, 1);
  assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
  const before = f.snapshotCoordinator();
  assert.throws(() => f.store.updateChannelWorkflow(f.plan.workflowId, { status: "succeeded" }, now()), /workflow_isolation|workflow_integration/);
  assert.throws(() => f.store.transitionChannelWorkflowStatus({ workflowId: f.plan.workflowId, expectedStatus: "running",
    event: "all_steps_succeeded", actor: "system", now: now() }), /workflow_isolation|workflow_integration/);
  assert.deepEqual(f.snapshotCoordinator(), before);
});

test("authority digest stays stable across own round phases and linked effects while public capture stays strict", async t => {
  const f = await fixture(t); f.release();
  const binding = f.binding(), original = f.authorized();
  f.collect();
  assert.equal(f.authorized().authorityDigest, original.authorityDigest);
  const intent = value(f.coordinator().recordIntent(f.creationInput()));
  assert.equal(f.round().openIntentId, intent.intentId);
  assert.notEqual(f.readAuthority().status, "authorized");
  assert.equal(f.authorized().authorityDigest, original.authorityDigest);
  assert.equal(f.authorized().participants[0].proofDigest, original.participants[0].proofDigest);
  const receipt = value(f.coordinator().recordReceipt(f.receiptInput(intent)));
  assert.equal(receipt.intentId, intent.intentId);
  assert.equal(f.authorized().authorityDigest, original.authorityDigest);
  assert.equal(f.readAuthority().status, "authorized");
  value(f.coordinator().advanceRound(f.advanceInput("integrating")));
  assert.equal(f.authorized().authorityDigest, original.authorityDigest);
  assert.deepEqual(f.binding(), binding);
});

test("effectKey duplicate and receipt duplicate retain one immutable physical-operation authorization", async t => {
  const f = await fixture(t); f.collect();
  const input = f.creationInput(), created = f.coordinator().recordIntent(input);
  assert.equal(created.status, "created", JSON.stringify(created));
  const duplicate = f.noWrites(() => f.coordinator().recordIntent(input));
  assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));
  assert.deepEqual(duplicate.value, created.value);
  assert.equal(f.effects().length, 1);
  const observation = f.receiptInput(created.value), confirmed = f.coordinator().recordReceipt(observation);
  assert.equal(confirmed.status, "created", JSON.stringify(confirmed));
  const repeated = f.noWrites(() => f.coordinator().recordReceipt(observation));
  assert.equal(repeated.status, "duplicate", JSON.stringify(repeated));
  assert.deepEqual(repeated.value, confirmed.value);
  assert.deepEqual(f.receipts(), [confirmed.value]);
  assert.deepEqual(f.isolation.getReceipt(confirmed.value.receiptId), confirmed.value);
});

test("round and observation CAS reject stale revisions on independent SQLite connections", async t => {
  const f = await fixture(t); f.collect();
  const staleIntent = f.creationInput({ expectedRevision: f.round().revision + 1 });
  assert.equal(f.noWrites(() => f.coordinator().recordIntent(staleIntent)).status, "stale");
  const input = f.creationInput(), intent = value(f.coordinator().recordIntent(input));
  const peer = createSqliteWorkflowIntegrationCoordinatorStore(f.peer);
  const duplicate = peer.recordIntent(input);
  assert.equal(duplicate.status, "duplicate", JSON.stringify(duplicate));
  const receiptInput = f.receiptInput(intent);
  assert.equal(f.noWrites(() => peer.recordReceipt({ ...receiptInput, expectedRevision: receiptInput.expectedRevision - 1 })).status, "stale");
  const receipt = value(f.coordinator().recordReceipt(receiptInput));
  assert.equal(receipt.outcome, "confirmed");
  const advance = f.advanceInput("integrating");
  assert.equal(f.noWrites(() => peer.advanceRound({ ...advance, expectedRevision: advance.expectedRevision - 1 })).status, "stale");
  value(f.coordinator().advanceRound(advance));
  assert.equal(f.round().phase, "integrating");
});

for (const outcome of ["blocked", "effect_unknown"]) {
  test(`${outcome} observation is retained and only a new exact observation CAS may confirm`, async t => {
    const f = await fixture(t); f.collect();
    const input = f.creationInput(), intent = value(f.coordinator().recordIntent(input));
    const first = value(f.coordinator().recordReceipt(f.receiptInput(intent, { outcome, observed: intent.before,
      evidence: { code: "physical_effect_not_verified" } })));
    assert.equal(first.outcome, outcome);
    assert.equal(f.effects()[0].status, outcome);
    assert.equal(f.coordinator().recordIntent(input).status, "duplicate");
    const confirmed = value(f.coordinator().recordReceipt(f.receiptInput(intent)));
    assert.equal(confirmed.outcome, "confirmed");
    assert.deepEqual(f.receipts(), [first, confirmed]);
    assert.equal(f.effects()[0].status, "confirmed");
    assert.equal(f.effects().length, 1);
  });
}

for (const name of ["workflowCancelled", "lateAbort", "pinRemoved", "packetHashChanged"]) {
  test(`late ${name} blocks pending effect confirmation and new effects`, async t => {
    const f = await fixture(t); f.collect();
    const intentInput = f.creationInput(), intent = value(f.coordinator().recordIntent(intentInput));
    const receiptInput = f.receiptInput(intent); mutations[name](f);
    rejected(f.noWrites(() => f.coordinator().recordReceipt(receiptInput)));
    rejected(f.noWrites(() => f.coordinator().recordIntent(intentInput)));
    assert.equal(f.effects()[0].status, "pending");
  });
}

test("late cancellation retains effect_unknown diagnostics without permitting confirmation or replay", async t => {
  const f = await fixture(t); f.collect();
  const intentInput = f.creationInput(), intent = value(f.coordinator().recordIntent(intentInput));
  const binding = f.binding(), round = f.round();
  mutations.workflowCancelled(f);
  const diagnosticInput = f.receiptInput(intent, { outcome: "effect_unknown", observed: intent.before,
    evidence: { code: "cancelled_after_effect_started" } });
  const diagnostic = f.coordinator().recordReceipt(diagnosticInput);
  assert.equal(diagnostic.status, "created", JSON.stringify(diagnostic));
  assert.equal(diagnostic.value.outcome, "effect_unknown");
  assert.equal(diagnostic.value.intentId, intent.intentId);
  assert.deepEqual(diagnostic.value.observed, intent.before);
  assert.deepEqual(f.receipts(), [diagnostic.value]);
  assert.equal(f.effects()[0].status, "effect_unknown");
  assert.equal(f.round().openIntentId, intent.intentId);
  assert.equal(f.round().phase, round.phase);
  assert.equal(f.round().revision, round.revision + 1);
  assert.deepEqual(f.binding(), binding);
  const repeated = f.noWrites(() => f.coordinator().recordReceipt(diagnosticInput));
  assert.equal(repeated.status, "duplicate", JSON.stringify(repeated));
  assert.deepEqual(repeated.value, diagnostic.value);
  const confirmation = f.receiptInput(intent);
  rejected(f.noWrites(() => f.coordinator().recordReceipt(confirmation)));
  rejected(f.noWrites(() => f.coordinator().recordIntent(intentInput)));
  rejected(f.noWrites(() => f.read()));
  assert.deepEqual(f.receipts(), [diagnostic.value]);
  assert.equal(f.effects()[0].status, "effect_unknown");
  assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
});

test("receipt confirmation requires its exact retained effect, observation and artifact owner", async t => {
  const f = await fixture(t); f.collect();
  const intent = value(f.coordinator().recordIntent(f.creationInput()));
  const input = f.receiptInput(intent);
  rejected(f.noWrites(() => f.coordinator().recordReceipt({ ...input, observed: intent.before })));
  rejected(f.noWrites(() => f.coordinator().recordReceipt({ ...input, authorityDigest: workflowIsolationDigest("foreign") })));
  const body = f.store.getArtifact(input.artifactId).sealedPayload;
  const foreign = f.sealed("coordinator-forged-observation", { ...body, effectKey: "foreign" });
  rejected(f.noWrites(() => f.coordinator().recordReceipt({ ...input, artifactId: foreign.id })));
  value(f.coordinator().recordReceipt(input));
});

test("effect payload hash drift is rejected by read-side evidence inventory", async t => {
  const f = await fixture(t); f.collect();
  const intent = value(f.coordinator().recordIntent(f.creationInput()));
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(intent.payloadArtifactId);
  rejected(f.noWrites(() => f.read()));
  assert.throws(() => f.effects(), /artifact|digest|payload|evidence|corrupt/);
});

test("receipt payload hash drift cannot be hidden by a confirmed generic status", async t => {
  const f = await fixture(t); f.collect();
  const intent = value(f.coordinator().recordIntent(f.creationInput()));
  const receipt = value(f.coordinator().recordReceipt(f.receiptInput(intent)));
  f.store.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id=?").run(receipt.artifactId);
  rejected(f.noWrites(() => f.read()));
  assert.throws(() => f.receipts(), /artifact|digest|payload|evidence|corrupt/);
});

test("a confirmed effect without a receipt cannot authorize new coordination", async t => {
  const f = await fixture(t); f.collect();
  const effect = value(f.coordinator().recordIntent(f.creationInput()));
  f.store.database.prepare("UPDATE workflow_isolation_intents SET status='confirmed' WHERE intent_id=?").run(effect.intentId);
  f.store.database.prepare(`UPDATE workflow_integration_generations SET open_intent_id=NULL,revision=revision+1
    WHERE round_id=? AND generation=?`).run(f.roundId, f.plan.generation);
  rejected(f.noWrites(() => f.read()));
  assert.equal(typeof f.coordinator().readPublicationBlocker(f.plan.workflowId), "string");
});

test("a pending effect cannot be hidden by clearing its round open-intent marker", async t => {
  const f = await fixture(t); f.collect();
  value(f.coordinator().recordIntent(f.creationInput()));
  f.store.database.prepare(`UPDATE workflow_integration_generations SET open_intent_id=NULL,revision=revision+1
    WHERE round_id=? AND generation=?`).run(f.roundId, f.plan.generation);
  rejected(f.noWrites(() => f.read()));
  assert.equal(typeof f.coordinator().readPublicationBlocker(f.plan.workflowId), "string");
});

test("publication inventory observes a binding preparation effect after workflow cancellation", async t => {
  const f = await fixture(t);
  assert.equal(f.coordinator().readPublicationBlocker(f.plan.workflowId), undefined);
  const creation = f.store.database.prepare(`SELECT * FROM workflow_isolation_intents
    WHERE scope_type='binding' AND writer_binding_id=?`).get(f.writer.bindingId);
  f.store.database.prepare(`INSERT INTO workflow_isolation_intents(intent_id,command_id,intent_digest,scope_type,scope_binding_id,
    scope_revision,writer_binding_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,kind,before_json,after_json,status,created_at)
    VALUES (?,?,?,'binding',?,?,?,?,?,?,?,?,?,?,'pending',?)`).run("pending-preparation", "pending-preparation", "unconfirmed",
      f.writer.bindingId, f.binding().revision, f.writer.bindingId, f.writer.workUnitId, f.writer.attemptId,
      f.writer.runtimeInstanceId, f.writer.fencingToken, creation.kind, creation.before_json, creation.after_json, now());
  f.store.database.prepare(`UPDATE workflow_isolation_bindings SET open_intent_id='pending-preparation',revision=revision+1
    WHERE binding_id=?`).run(f.writer.bindingId);
  mutations.workflowCancelled(f);
  assert.equal(f.noWrites(() => f.coordinator().readPublicationBlocker(f.plan.workflowId)),
    "workflow_isolation.preparation_effect_unconfirmed");
});

test("publication inventory rejects changed retained result evidence even after cancellation", async t => {
  const f = await fixture(t);
  assert.equal(f.coordinator().readPublicationBlocker(f.plan.workflowId), undefined);
  mutations.workflowCancelled(f);
  mutations.resultReceiptHashChanged(f);
  assert.equal(typeof f.noWrites(() => f.coordinator().readPublicationBlocker(f.plan.workflowId)), "string");
});

for (const [table, operation] of [["workflow_integration_effect_links", "intent"], ["workflow_integration_receipt_links", "receipt"]]) {
  test(`${operation} evidence-link failure rolls back generic journal, round CAS and pins`, async t => {
    const f = await fixture(t); f.collect();
    let input, write;
    if (operation === "intent") { input = f.creationInput(); write = () => f.coordinator().recordIntent(input); }
    else { const intent = value(f.coordinator().recordIntent(f.creationInput())); input = f.receiptInput(intent); write = () => f.coordinator().recordReceipt(input); }
    f.store.database.exec(`CREATE TEMP TRIGGER coordinator_link_fault BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT,'coordinator_link_fault'); END`);
    const before = f.snapshotCoordinator();
    assert.throws(write, /coordinator_link_fault/);
    assert.deepEqual(f.snapshotCoordinator(), before);
  });
}

test("coordinator never adopts or rolls back the caller transaction", async t => {
  const f = await fixture(t); f.collect();
  const input = f.creationInput();
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    f.store.database.prepare("UPDATE channels SET name='caller-owned' WHERE id=?").run(f.channel.id);
    assert.throws(() => f.coordinator().recordIntent(input), /transaction/);
    assert.equal(f.store.database.isTransaction, true);
    assert.equal(f.store.getChannel(f.channel.id).name, "caller-owned");
  } finally { f.store.database.exec("ROLLBACK"); }
  assert.equal(f.effects().length, 0);
});

test("durable effect, receipt and stable authority survive reopen without creating new execution", async t => {
  const f = await fixture(t); f.release(); f.collect();
  const authority = f.authorized(), binding = f.binding();
  const intentInput = f.creationInput(), intent = value(f.coordinator().recordIntent(intentInput));
  const receipt = value(f.coordinator().recordReceipt(f.receiptInput(intent)));
  const before = f.snapshotCoordinator();
  f.reopenIsolation();
  assert.equal(f.authorized().authorityDigest, authority.authorityDigest);
  assert.deepEqual(f.effects(), [{ ...intent, status: "confirmed" }]);
  assert.deepEqual(f.receipts(), [receipt]);
  assert.deepEqual(f.binding(), binding);
  assert.deepEqual(f.snapshotCoordinator(), before);
  assert.equal(f.noWrites(() => f.coordinator().recordIntent(intentInput)).status, "duplicate");
});

test("semantic success before candidate verification never commits workflow success", async t => {
  const f = await fixture(t); f.collect();
  const intent = value(f.coordinator().recordIntent(f.creationInput()));
  value(f.coordinator().recordReceipt(f.receiptInput(intent)));
  value(f.coordinator().advanceRound(f.advanceInput("integrating")));
  assert.equal(f.current(f.scopeIsolation).status, "succeeded");
  assert.equal(typeof f.coordinator().readCompletionBlocker(f.plan.workflowId), "string");
  const before = f.snapshotCoordinator();
  assert.throws(() => f.store.updateChannelWorkflow(f.plan.workflowId, { status: "succeeded" }, now()), /workflow_isolation|workflow_integration/);
  assert.deepEqual(f.snapshotCoordinator(), before);
});

test("terminal round authority and effects cannot grant target apply or a merge permit", async t => {
  const f = await fixture(t); f.collect();
  for (const to of ["applying", "applied"]) {
    const result = f.noWrites(() => f.coordinator().advanceRound(f.advanceInput(to)));
    rejected(result);
    assert.match(result.code, /merge_permit_not_implemented/);
  }
});
