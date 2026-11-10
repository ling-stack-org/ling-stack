/** Isolated corruption probe: a row is not a Host-issued child/result/budget. */
export function injectUnverifiedRequiredDelegation(store, runId, at) {
  const run = store.getRun(runId);
  let unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  if (!unit) {
    unit = store.createWorkUnit({ workspaceId: "workspace_default", kind: "conversation_run", ownerType: "run", ownerId: runId,
      idempotencyKey: `unverified-delegation:${runId}`, createdByActor: "system", request: {}, now: at });
    store.linkRunToWorkUnit(runId, unit.id, at);
  }
  const attempt = unit.activeAttemptId ? store.getWorkUnitAttempt(unit.activeAttemptId)
    : store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "corruption-probe", runnerId: "pi", now: at });
  const artifact = store.createArtifact({ runId, type: "json", path: "sqlite:unverified-delegation", sealedPayload: {}, createdAt: at });
  const stepId = `unverified-delegation:${runId}`;
  store.database.prepare(`INSERT INTO delegation_steps (id,schema_version,root_run_id,parent_run_id,parent_attempt_id,
    spawn_call_id,objective_artifact_id,required,state,depth,permission_snapshot_artifact_id,tool_allowlist_artifact_id,
    workspace_scope_artifact_id,provider_policy_artifact_id,idempotency_key,revision,created_at,updated_at)
    VALUES (?,1,?,?,?,'corruption-probe',?,1,'spawning',1,?,?,?,?,?,0,?,?)`)
    .run(stepId, runId, runId, attempt.id, artifact.id, artifact.id, artifact.id, artifact.id, artifact.id, stepId, at, at);
  return stepId;
}
