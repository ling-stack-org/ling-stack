import {
  LING_APP_SERVER_DECISION_MATERIALITIES,
  LING_APP_SERVER_DELIBERATION_CHECKPOINTS,
  LING_APP_SERVER_DELIBERATION_DECISION_KINDS,
  LING_APP_SERVER_DELIBERATION_OUTCOMES,
  LING_APP_SERVER_METHODS,
  LING_APP_SERVER_NOTIFICATION_METHODS,
  LING_APP_SERVER_PROTOCOL_VERSION,
  LING_APP_SERVER_SERVER_REQUEST_METHODS,
  isLingAppServerMethod,
  isLingAppServerNotificationMethod,
  type LingAppServerMethod,
  type LingAppServerNotificationMethod,
  type LingAppServerServerRequestMethod,
} from "./app-server.js";

/** The subset of JSON Schema used by the App Server contract registry. */
export interface LingAppServerJsonSchema {
  readonly $schema?: string;
  readonly title?: string;
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, LingAppServerJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: LingAppServerJsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly oneOf?: readonly LingAppServerJsonSchema[];
  readonly description?: string;
}

export interface LingAppServerMethodSchema {
  readonly params: LingAppServerJsonSchema;
  readonly result: LingAppServerJsonSchema;
}

export interface LingAppServerSchemaDocument {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly title: "Ling App Server protocol";
  readonly protocolVersion: "ling-app-server/1";
  readonly methods: Readonly<Record<LingAppServerMethod, LingAppServerMethodSchema>>;
  readonly notifications: Readonly<Record<LingAppServerNotificationMethod, LingAppServerJsonSchema>>;
  readonly serverRequests: Readonly<Record<LingAppServerServerRequestMethod, LingAppServerJsonSchema>>;
}

export interface LingAppServerValidationResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly message?: string;
}

const objectSchema: LingAppServerJsonSchema = { type: "object", additionalProperties: true };
const stringSchema: LingAppServerJsonSchema = { type: "string" };
const integerSchema: LingAppServerJsonSchema = { type: "integer" };
const booleanSchema: LingAppServerJsonSchema = { type: "boolean" };
const arraySchema: LingAppServerJsonSchema = { type: "array" };
const stringArraySchema: LingAppServerJsonSchema = { type: "array", items: stringSchema };

const clientInfo = objectWith({ name: stringSchema, version: stringSchema }, ["name", "version"]);
const handshakeLimits = objectWith({ maxInboundFrameBytes: integerSchema, maxOutboundFrameBytes: integerSchema,
  maxPendingRequests: integerSchema, maxSubscriptions: integerSchema, maxBufferedBytes: integerSchema },
["maxInboundFrameBytes", "maxOutboundFrameBytes"]);
const pingResult = objectWith({ ok: { enum: [true] }, connectionId: stringSchema, serverTime: stringSchema },
  ["ok", "connectionId", "serverTime"]);
const threadTarget = { threadId: stringSchema };
const workItemTarget = { workItemId: stringSchema };
const deliberationCheckpoint = { enum: LING_APP_SERVER_DELIBERATION_CHECKPOINTS } as const;
const deliberationSubject = { oneOf: [
  objectWith({ kind: { enum: ["draft_plan"] }, planId: stringSchema, planRevision: integerSchema }, ["kind", "planId", "planRevision"]),
  objectWith({ kind: { enum: ["workflow_stage"] }, workflowStepId: stringSchema, planRevision: stringSchema }, ["kind", "workflowStepId", "planRevision"]),
] };
const deliberationEvaluationFields = {
  evaluationId: stringSchema, decisionId: stringSchema, decisionRevision: stringSchema, subjectRevision: stringSchema,
  policyRevision: stringSchema, checkpoint: deliberationCheckpoint, checkpointRef: stringSchema,
  outcome: { enum: LING_APP_SERVER_DELIBERATION_OUTCOMES }, reasonCode: stringSchema,
  optionRefs: stringArraySchema, evidenceRefs: stringArraySchema, participantIds: stringArraySchema,
  expiresAt: stringSchema, evaluatedAt: stringSchema,
};
const deliberationWorkflowProgressFields = {
  roundId: stringSchema, workflowId: stringSchema,
  status: { enum: ["draft", "ready", "running", "waiting_for_approval", "waiting_for_input", "blocked", "succeeded", "failed", "cancelled"] },
  deadlineAt: stringSchema, proposalsCompleted: integerSchema, challengesCompleted: integerSchema, participants: integerSchema,
};
const deliberationWorkflowOutcome = objectWith({
  status: { enum: ["waiting", "voting", "consensus", "verify_required", "insufficient_evidence", "tallied"] },
  summary: objectSchema, recommendation: stringSchema,
}, ["status"]);
const planTarget = { ...threadTarget, planId: stringSchema, expectedRevision: integerSchema };
const planActionResult = objectWith({ cwd: stringSchema, threadId: stringSchema, plan: objectSchema, taskId: stringSchema,
  workflowId: stringSchema, workflowStepId: stringSchema, runId: stringSchema }, ["cwd", "threadId", "plan"]);
const recoveryVerification = objectWith({ checkId: stringSchema, verifierBasisRef: stringSchema, coverageDigest: stringSchema },
  ["checkId", "verifierBasisRef", "coverageDigest"]);
const recoveryReview = objectWith({ providerPresetId: stringSchema }, ["providerPresetId"]);
const planWorkflowStep = objectWith({ title: stringSchema, stageId: stringSchema, dependsOnStageIds: stringArraySchema,
  handoffFromStageIds: stringArraySchema, recoveryVerification, recoveryReview,
  ownerId: stringSchema, ownerLabel: stringSchema, requiredTools: stringArraySchema,
  requiredDecision: objectWith({ question: stringSchema, options: stringArraySchema, trigger: { enum: ["when_ready"] },
    receiptSource: { enum: ["checkpoint"] },
    ballot: objectWith({ voterStageIds: stringArraySchema, quorum: integerSchema }, ["voterStageIds", "quorum"]) }, ["question", "options"]) }, ["title"]);
const journalFields = { id: stringSchema, recordedAt: stringSchema, pending: booleanSchema };
const journalRequired = ["id", "kind", "recordedAt", "pending"];
const journalEntry = { oneOf: [
  objectWith({ ...journalFields, kind: { enum: ["grant_revocation"] } }, journalRequired),
  objectWith({ ...journalFields, ...workItemTarget, kind: { enum: ["external_agent_dispatch"] }, taskId: stringSchema, completedAt: stringSchema },
    [...journalRequired, "workItemId", "taskId"]),
  objectWith({ ...journalFields, ...workItemTarget, kind: { enum: ["github_delivery"] }, mergedCommit: stringSchema },
    [...journalRequired, "workItemId", "mergedCommit"]),
  objectWith({ ...journalFields, ...workItemTarget, kind: { enum: ["github_queue_enqueue"] }, repositoryId: stringSchema,
    pullRequestNumber: integerSchema, headSha: stringSchema, completedAt: stringSchema },
  [...journalRequired, "workItemId", "repositoryId", "pullRequestNumber", "headSha"]),
] };
const serverRecoveryResult = objectWith({ cwd: stringSchema, revision: integerSchema, status: { enum: ["ready", "reconciliation_required"] },
  preparedAt: stringSchema, reconciledAt: stringSchema, pendingCount: integerSchema, entries: { type: "array", items: journalEntry } },
["cwd", "revision", "status", "pendingCount", "entries"]);
const candidate = objectWith({ workspaceId: stringSchema, candidateDigest: stringSchema, worktreeId: stringSchema,
  baseCommit: stringSchema, headCommit: stringSchema, filePaths: stringArraySchema }, ["workspaceId", "candidateDigest"]);
const verifierBasis = { verifierBasisRef: stringSchema, coverageDigest: stringSchema, producerRefs: stringArraySchema };
const verifyCheckPlan = objectWith({
  checkId: stringSchema, kind: { enum: ["command", "test", "typecheck", "browser", "platform"] }, label: stringSchema,
  required: booleanSchema, command: stringSchema, recipeDigest: stringSchema, estimatedDurationMs: integerSchema, ...verifierBasis,
}, ["checkId", "kind", "label", "required", "recipeDigest"]);
const verifyPlanResult = objectWith({ planId: stringSchema, planRevision: stringSchema, candidate,
  ...threadTarget, ...workItemTarget, acceptedPlanRevision: stringSchema, checks: { type: "array", items: verifyCheckPlan },
  rationale: stringArraySchema, requiredApproval: stringSchema, environmentRequirements: stringArraySchema,
}, ["planId", "planRevision", "candidate", "checks", "rationale", "environmentRequirements"]);
const verifyExecutionFields = {
  startedAt: stringSchema, endedAt: stringSchema, exitCode: { oneOf: [integerSchema, { type: "null" }] },
  timedOut: booleanSchema, output: stringSchema, outputTruncated: booleanSchema,
} satisfies Record<string, LingAppServerJsonSchema>;
const verifyCheckEvidence = objectWith({
  checkId: stringSchema, candidateDigest: stringSchema, planRevision: stringSchema, recipeDigest: stringSchema, environmentDigest: stringSchema,
  ...verifierBasis, attemptId: stringSchema, evidenceRefs: stringArraySchema,
  status: { enum: ["pending", "running", "passed", "failed", "not_run", "blocked", "cancelled", "unknown"] },
  execution: objectWith(verifyExecutionFields, Object.keys(verifyExecutionFields)),
}, ["checkId", "candidateDigest", "planRevision", "recipeDigest", "environmentDigest", "producerRefs", "attemptId", "status", "evidenceRefs"]);
const verifyOperationResult = objectWith({
  operationId: stringSchema, planId: stringSchema, revision: stringSchema, ...threadTarget, ...workItemTarget, candidateDigest: stringSchema,
  status: { enum: ["queued", "running", "passed", "failed", "blocked", "cancelled", "unknown"] },
  checks: { type: "array", items: verifyCheckEvidence }, startedAt: stringSchema, completedAt: stringSchema, blocker: stringSchema,
}, ["operationId", "planId", "candidateDigest", "status", "checks"]);
const operationResult = objectWith({ operationId: stringSchema, candidateDigest: stringSchema, status: stringSchema },
  ["operationId", "candidateDigest", "status"]);
const nativeIntakeReceiptSchema = objectWith({
  receiptId: stringSchema, workspaceId: stringSchema, policyId: stringSchema, policyRevision: stringSchema,
  sourceKind: { enum: ["channel_task", "automation_run"] }, sourceScope: stringSchema, sourceEventId: stringSchema,
  sourceRevision: stringSchema, executionId: stringSchema, evaluatedAt: stringSchema, reasonCode: stringSchema,
  previousReceiptId: stringSchema, workItemId: stringSchema,
  outcome: { enum: ["manual", "suggested", "accepted", "suppressed", "paused", "deduplicated"] },
  dispatch: objectWith({ status: { enum: ["pending", "admitted", "held"] }, runId: stringSchema, reasonCode: stringSchema }, ["status"]),
}, ["receiptId", "workspaceId", "policyId", "policyRevision", "sourceKind", "sourceScope", "sourceEventId",
  "sourceRevision", "executionId", "evaluatedAt", "reasonCode", "outcome"]);
const subscriptionResult = objectWith({ disposition: { enum: ["complete", "snapshot_required"] },
  subscriptionId: stringSchema, cursor: stringSchema, window: objectSchema }, ["disposition"]);
const collaborationAppend = { ...workItemTarget, idempotencyKey: stringSchema, actorId: stringSchema,
  expectedWorkItemRevision: integerSchema, expectedCollaborationRevision: integerSchema, parentRecordId: stringSchema,
  sourceRefs: arraySchema, payload: {} };
const deliberationSettlement = { ...workItemTarget, roundId: stringSchema, expectedRoundRevision: integerSchema,
  expectedWorkItemRevision: integerSchema, idempotencyKey: stringSchema, reason: stringSchema };
const deliberationSettlementFields = ["workItemId", "roundId", "expectedRoundRevision", "expectedWorkItemRevision", "idempotencyKey", "reason"];
const deviceBindingFields = {
  bindingId: stringSchema, workItemId: stringSchema, graphId: stringSchema, graphNodeId: stringSchema, graphRevision: integerSchema,
  ownerHostId: stringSchema, ownerRouteGeneration: integerSchema, workUnitId: stringSchema, attemptId: stringSchema,
  status: { enum: ["bound", "queued", "running", "succeeded", "failed", "cancelled", "unknown"] },
  revision: integerSchema, boundAt: stringSchema, updatedAt: stringSchema, receipt: objectSchema,
};
const deviceBinding = objectWith(deviceBindingFields, ["bindingId", "workItemId", "graphId", "graphNodeId", "graphRevision",
  "ownerHostId", "ownerRouteGeneration", "workUnitId", "status", "revision", "boundAt", "updatedAt"]);
const deviceReceiptParams = {
  ...workItemTarget, bindingId: stringSchema, expectedBindingRevision: integerSchema, expectedWorkItemRevision: integerSchema,
  ownerHostId: stringSchema, ownerRouteGeneration: integerSchema, workUnitId: stringSchema, attemptId: stringSchema,
  status: { enum: ["succeeded", "failed", "cancelled", "unknown"] }, resultRef: stringSchema,
  reconciled: booleanSchema, idempotencyKey: stringSchema,
};
const reviewResultFields = ["operationId", "assessmentId", "candidateDigest", "status"];
const reviewResult = {
  operationId: stringSchema, assessmentId: stringSchema, candidateDigest: stringSchema,
  status: { enum: ["queued", "running", "completed", "partial", "failed", "cancelled"] },
  workItem: objectWith({ ...workItemTarget, acceptedPlanRevision: stringSchema, controlGeneration: integerSchema },
    ["workItemId", "controlGeneration"]),
};
const worktreeTarget = { ownerKind: { enum: ["channel", "teammate"] }, ownerId: stringSchema };
const changeWorktree = objectWith(worktreeTarget, ["ownerKind", "ownerId"]);
const changeSource = { cwd: stringSchema, sourceWorktree: changeWorktree };
const candidateResult = { cwd: stringSchema, candidate, coverage: { enum: ["complete", "partial"] }, headCommit: stringSchema };
const candidateResultFields = ["cwd", "candidate", "coverage", "headCommit"];
const recoveryAction = { enum: ["undo", "reapply"] };
const transferAction = { enum: ["apply"] };
const recoveryTarget = { cwd: stringSchema, ...threadTarget, turnId: stringSchema, action: recoveryAction };
const transferTarget = {
  ...changeSource, action: transferAction, targetWorktree: changeWorktree, candidateDigest: stringSchema, hunkIds: stringArraySchema,
};
const confirmation = { expectedRevision: stringSchema, idempotencyKey: stringSchema, confirmed: { enum: [true] } };
const recoveryFields = ["action", "threadId", "turnId"];
const transferFields = ["action", "targetWorktree", "candidateDigest", "hunkIds"];
const confirmationFields = ["expectedRevision", "idempotencyKey", "confirmed"];
const gitHubTarget = { kind: { enum: ["issue", "pull_request"] }, number: integerSchema };
const gitHubSubject = objectWith({
  ...gitHubTarget, repository: stringSchema, githubInstanceId: { enum: ["github.com"] }, repositoryId: stringSchema,
  title: stringSchema, labels: stringArraySchema, state: { enum: ["open", "closed"] }, sourceRevision: stringSchema,
  baseRef: stringSchema, baseSha: stringSchema, headSha: stringSchema, mergeSha: stringSchema, merged: booleanSchema,
}, ["kind", "number", "repository", "githubInstanceId", "repositoryId", "title", "state", "sourceRevision"]);
const gitHubRequiredCheck = objectWith({
  name: stringSchema, appId: integerSchema, workflowId: integerSchema, workflowPath: stringSchema, workflowSha256: stringSchema,
  basis: { enum: ["head", "integration", "merge_group"] }, coverageRefs: stringArraySchema,
}, ["name", "appId", "workflowId", "workflowPath", "workflowSha256", "basis", "coverageRefs"]);
const gitHubCheckEvidence = objectWith({
  check: gitHubRequiredCheck, testedCommit: stringSchema, checkRunId: integerSchema, runId: integerSchema,
  runAttempt: integerSchema, jobId: integerSchema, outcome: { enum: ["passed", "failed", "pending", "unavailable"] },
  reason: { enum: ["applicable_check_missing", "current_attempt_pending", "integration_unavailable",
    "merge_group_membership_unavailable", "ambiguous_run", "observation_window_exceeded", "workflow_source_changed"] },
}, ["check", "outcome"]);
const gitHubQueueResult = objectWith({
  cwd: stringSchema,
  receipt: objectWith({
    ...workItemTarget, queueReceiptId: stringSchema, deliveryId: stringSchema, repository: stringSchema,
    repositoryId: stringSchema, pullRequestNumber: integerSchema, headSha: stringSchema,
    status: { enum: ["pending", "enqueued", "merged", "rejected", "unknown"] }, rejectedHttpStatus: { enum: [401, 429] },
    queueEntryId: stringSchema, mergedCommit: stringSchema, createdAt: stringSchema,
  }, ["workItemId", "queueReceiptId", "deliveryId", "repository", "repositoryId", "pullRequestNumber", "headSha", "status", "createdAt"]),
}, ["cwd", "receipt"]);
const queueEvidence = objectWith({
  queueEntryId: stringSchema, baseCommit: stringSchema, testedCommit: stringSchema, testedTree: stringSchema, membershipProofRef: stringSchema,
}, ["queueEntryId", "baseCommit", "testedCommit", "membershipProofRef"]);
const deliveryResult = objectWith({
  cwd: stringSchema,
  delivery: objectWith({ deliveryId: stringSchema, workItemId: stringSchema, acceptanceId: stringSchema, threadId: stringSchema,
    candidateDigest: stringSchema, policyRevision: stringSchema, subject: gitHubSubject, baseCommit: stringSchema,
    checks: { type: "array", items: gitHubCheckEvidence },
    mergeGroup: queueEvidence, status: { enum: ["ci_pending", "ci_failed", "delivery_pending", "delivered"] },
    mergedCommit: stringSchema, observedAt: stringSchema },
  ["deliveryId", "workItemId", "acceptanceId", "threadId", "candidateDigest", "policyRevision", "subject", "baseCommit", "checks", "status", "observedAt"]),
}, ["cwd", "delivery"]);

function objectWith(
  properties: Readonly<Record<string, LingAppServerJsonSchema>>,
  required: readonly string[] = [],
): LingAppServerJsonSchema {
  return { type: "object", properties, required, additionalProperties: true };
}

function schemaFor(method: LingAppServerMethod): LingAppServerMethodSchema {
  const result = objectSchema;
  switch (method) {
    case "initialize":
      return {
        params: objectWith({ protocolVersions: stringArraySchema,
          clientInfo,
          requiredCapabilities: stringArraySchema, optionalCapabilities: stringArraySchema, workspaceScope: stringArraySchema }, ["protocolVersions"]),
        result: objectWith({ protocolVersion: { enum: [LING_APP_SERVER_PROTOCOL_VERSION] }, connectionId: stringSchema,
          serverInfo: clientInfo, effectiveScopes: stringArraySchema, capabilities: stringArraySchema, limits: handshakeLimits,
          serverInstanceId: stringSchema, storeIncarnation: stringSchema, authorizationEpoch: stringSchema },
        ["protocolVersion", "connectionId", "serverInfo", "effectiveScopes", "capabilities", "limits"]),
      };
    case "server/ping":
      return { params: objectSchema, result: pingResult };
    case "server/recovery/read":
      return { params: objectWith({ cwd: stringSchema }), result: serverRecoveryResult };
    case "server/recovery/prepare":
      return { params: objectWith({ cwd: stringSchema, expectedRevision: integerSchema, idempotencyKey: stringSchema },
        ["expectedRevision", "idempotencyKey"]), result: serverRecoveryResult };
    case "server/recovery/reconcile":
      return { params: objectWith({ cwd: stringSchema, expectedRevision: integerSchema }, ["expectedRevision"]), result: serverRecoveryResult };
    case "server/capabilities":
      return { params: objectSchema, result: objectWith({ protocolVersion: { enum: [LING_APP_SERVER_PROTOCOL_VERSION] },
        capabilities: stringArraySchema, methods: stringArraySchema, notifications: stringArraySchema },
      ["protocolVersion", "capabilities", "methods", "notifications"]) };
    case "workspace/list":
      return { params: objectSchema, result: objectWith({ workspaces: arraySchema }, ["workspaces"]) };
    case "workspace/read":
      return { params: objectWith({ workspaceId: stringSchema }), result: objectWith({ cwd: stringSchema, workspaceId: stringSchema }, ["cwd", "workspaceId"]) };
    case "provider/list":
    case "skill/list":
      return { params: objectSchema, result: objectWith({ snapshot: objectSchema, domain: stringSchema }, ["domain"]) };
    case "model/list":
      return { params: objectWith({ offset: integerSchema }), result: objectWith({ models: arraySchema }, ["models"]) };
    case "skill/read":
      return { params: objectWith({ skillId: stringSchema }, ["skillId"]), result: objectWith({ skill: objectSchema }, ["skill"]) };
    case "permissionProfile/list":
      return { params: objectSchema, result: objectWith({ profiles: arraySchema }, ["profiles"]) };
    case "server/grants/list":
      return { params: objectSchema, result: objectWith({ grants: arraySchema }, ["grants"]) };
    case "server/grants/create":
      return { params: objectWith({ label: stringSchema, subject: objectSchema, scopes: stringArraySchema, expiresAt: stringSchema,
        credentialSha256: stringSchema, idempotencyKey: stringSchema,
        stageExecution: objectWith({ runId: stringSchema, attemptId: stringSchema }, ["runId", "attemptId"]),
      }, ["label", "subject", "scopes", "expiresAt", "credentialSha256", "idempotencyKey"]),
      result: objectWith({ grant: objectSchema }, ["grant"]) };
    case "server/grants/revoke":
      return { params: objectWith({ grantId: stringSchema, expectedRevision: integerSchema, revision: integerSchema }, ["grantId"]),
        result: objectWith({ grant: objectSchema }, ["grant"]) };
    case "worktree/list":
      return { params: objectSchema, result };
    case "worktree/create":
      return { params: objectWith({ ...worktreeTarget, baseBranch: stringSchema }, ["ownerKind", "ownerId"]), result };
    case "worktree/refresh":
    case "worktree/cleanup/preview":
    case "worktree/cleanup":
      return { params: objectWith({ ...worktreeTarget, expectedRevision: stringSchema, confirmed: booleanSchema }, ["ownerKind", "ownerId"]), result };
    case "thread/start":
      return { params: objectWith({ ...threadTarget, title: stringSchema, objective: stringSchema, kind: stringSchema }),
        result: objectWith({ thread: objectSchema }, ["thread"]) };
    case "thread/list":
      return { params: objectWith({ limit: integerSchema }), result: objectWith({ threads: arraySchema }, ["threads"]) };
    case "thread/name/set":
      return { params: objectWith({ ...threadTarget, title: stringSchema }, ["threadId", "title"]), result };
    case "thread/archive":
    case "thread/unarchive":
    case "thread/delete":
    case "thread/delete/preview":
      return { params: objectWith({ ...threadTarget, expectedRevision: stringSchema, reason: stringSchema }, ["threadId"]), result };
    case "thread/read":
    case "thread/goal/get":
    case "thread/mode/get":
    case "thread/turns/list":
    case "thread/items/list":
    case "thread/events/read":
      return { params: objectWith({ ...threadTarget, limit: integerSchema, beforeSequence: integerSchema, cursor: stringSchema }, ["threadId"]), result };
    case "thread/mode/set":
      return { params: objectWith({ ...threadTarget, mode: { enum: ["default", "plan"] } }, ["threadId", "mode"]), result };
    case "thread/goal/set":
    case "thread/goal/pause":
    case "thread/goal/resume":
    case "thread/goal/clear":
    case "thread/goal/complete":
      return { params: objectWith({ ...threadTarget, expectedGoalRevision: stringSchema }, ["threadId"]), result };
    case "plan/read":
      return { params: objectWith({ ...threadTarget, planId: stringSchema, limit: integerSchema }), result };
    case "plan/accept":
      return { params: objectWith({ ...planTarget, mode: { enum: ["workflow"] }, workflowTitle: stringSchema,
        workflowStepPreviews: { type: "array", items: planWorkflowStep } }, ["threadId", "planId"]), result: planActionResult };
    case "plan/refine":
      return { params: objectWith({ ...planTarget, draft: objectWith({ title: stringSchema, bodyMarkdown: stringSchema }, ["title", "bodyMarkdown"]) },
        ["threadId", "planId", "expectedRevision"]), result: planActionResult };
    case "item/read":
      return { params: objectWith({ ...threadTarget, itemId: stringSchema }, ["threadId", "itemId"]), result };
    case "context/inspect":
      return { params: objectWith({ ...threadTarget, turnId: stringSchema }, ["threadId", "turnId"]), result };
    case "submission/read":
      return { params: objectWith({ ...threadTarget, idempotencyKey: stringSchema }, ["idempotencyKey"]), result };
    case "thread/resume":
    case "thread/snapshot":
      return { params: objectWith({ threadId: stringSchema }, ["threadId"]), result: objectWith({ cwd: stringSchema, thread: objectSchema,
        cursor: stringSchema, pendingApprovals: arraySchema, pendingInputs: arraySchema }, ["cwd", "thread", "cursor", "pendingApprovals", "pendingInputs"]) };
    case "thread/subscribe":
      return { params: objectWith({ ...threadTarget, cursor: stringSchema }), result: subscriptionResult };
    case "workItem/subscribe":
      return { params: objectWith({ ...workItemTarget, cursor: stringSchema }, ["workItemId"]), result: subscriptionResult };
    case "thread/unsubscribe":
    case "workItem/unsubscribe":
      return { params: objectWith({ subscriptionId: stringSchema }, ["subscriptionId"]), result };
    case "workItem/deliberation/read":
      return { params: objectWith({ ...workItemTarget, afterRevision: integerSchema, limit: integerSchema }, ["workItemId"]),
        result: objectWith({ workItemId: stringSchema, records: arraySchema, nextAfterRevision: integerSchema, ballots: arraySchema,
          deliberationWorkflows: { type: "array", items: objectWith({ ...deliberationWorkflowProgressFields, blocker: stringSchema,
            outcome: deliberationWorkflowOutcome },
            Object.keys(deliberationWorkflowProgressFields)) },
        }, ["workItemId", "records", "nextAfterRevision"]) };
    case "workItem/read":
    case "workItem/clarify":
    case "workItem/evidence/read":
    case "workItem/collaboration/read":
    case "workItem/stage/read":
    case "workItem/stage/brief/read":
    case "workItem/coordination/read":
    case "workItem/message/read":
    case "workItem/message/list":
    case "workItem/question/read":
    case "workItem/handoff/read":
      return { params: objectWith({ ...workItemTarget, afterRevision: integerSchema, afterSequence: integerSchema,
        offset: integerSchema, limit: integerSchema }, ["workItemId"]), result };
    case "workItem/device/read":
      return { params: objectWith({ ...workItemTarget }, ["workItemId"]),
        result: objectWith({ cwd: stringSchema, workItemId: stringSchema, bindings: { type: "array", items: deviceBinding } }, ["cwd", "workItemId", "bindings"]) };
    case "workItem/device/bind":
      return { params: objectWith({ ...workItemTarget, graphId: stringSchema, graphNodeId: stringSchema, graphRevision: integerSchema,
        ownerHostId: stringSchema, ownerRouteGeneration: integerSchema, workUnitId: stringSchema, attemptId: stringSchema,
        expectedWorkItemRevision: integerSchema, idempotencyKey: stringSchema },
      ["workItemId", "graphId", "graphNodeId", "graphRevision", "ownerHostId", "ownerRouteGeneration", "workUnitId",
        "expectedWorkItemRevision", "idempotencyKey"]),
      result: objectWith({ cwd: stringSchema, binding: deviceBinding, replayed: booleanSchema }, ["cwd", "binding", "replayed"]) };
    case "workItem/device/receipt":
      return { params: objectWith(deviceReceiptParams,
        ["workItemId", "bindingId", "expectedBindingRevision", "expectedWorkItemRevision", "ownerHostId",
          "ownerRouteGeneration", "workUnitId", "status", "resultRef", "idempotencyKey"]),
      result: objectWith({ cwd: stringSchema, binding: deviceBinding, replayed: booleanSchema }, ["cwd", "binding", "replayed"]) };
    case "workItem/list":
      return { params: objectWith({ status: stringSchema, channelId: stringSchema, limit: integerSchema }), result };
    case "workItem/create":
      return { params: objectWith({ ...workItemTarget, sourceId: stringSchema, title: stringSchema, gitHubSubject: objectSchema,
        sourceType: stringSchema, linkExistingExecution: booleanSchema, idempotencyKey: stringSchema }, ["sourceId", "title"]), result };
    case "workItem/workflow/bind": {
      const resultSource = { sourceStepId: stringSchema, expectedSourceRevision: stringSchema, targetStepId: stringSchema };
      return { params: objectWith({ ...workItemTarget, planId: stringSchema, expectedWorkItemRevision: integerSchema,
        expectedPlanRevision: integerSchema, idempotencyKey: stringSchema, previousWorkflowId: stringSchema, resolvedPlanChangeIds: stringArraySchema,
        retainStageResults: { type: "array", items: objectWith(resultSource, Object.keys(resultSource)) },
        retainStageExecutions: { type: "array", items: objectWith({ ...resultSource, sourceRunId: stringSchema }, [...Object.keys(resultSource), "sourceRunId"]) } },
      ["workItemId", "planId", "expectedWorkItemRevision", "expectedPlanRevision", "idempotencyKey"]),
      result: objectWith({ cwd: stringSchema, workItem: objectSchema, replayed: booleanSchema,
        binding: objectWith({ ...workItemTarget, ...threadTarget, workflowId: stringSchema, planId: stringSchema,
          planRevision: integerSchema, linkedAt: stringSchema, previousWorkflowId: stringSchema,
          retainedStageResults: arraySchema, retainedStageExecutions: arraySchema },
        ["workItemId", "threadId", "workflowId", "planId", "planRevision", "linkedAt"]) }, ["cwd", "workItem", "binding", "replayed"]) };
    }
    case "workItem/plan/change/request":
    case "workItem/plan/change/withdraw": {
      const change: Record<string, LingAppServerJsonSchema> = method === "workItem/plan/change/request"
        ? { affectedStageIds: stringArraySchema, reason: stringSchema } : { changeId: stringSchema };
      return {
        params: objectWith({ ...workItemTarget, planRevision: stringSchema,
          expectedWorkItemRevision: integerSchema, idempotencyKey: stringSchema, ...change },
        ["workItemId", "planRevision", "expectedWorkItemRevision", "idempotencyKey", ...Object.keys(change)]),
        result: objectWith({ cwd: stringSchema, workItem: objectSchema, replayed: booleanSchema,
          receipt: objectWith({ changeId: stringSchema, status: { enum: ["pending", "withdrawn"] },
            planRevision: stringSchema, affectedStepIds: stringArraySchema }, ["changeId", "status", "planRevision", "affectedStepIds"]),
        }, ["cwd", "workItem", "replayed", "receipt"]),
      };
    }
    case "workItem/stage/recover": {
      const subject = { workflowStepId: stringSchema, blockerId: stringSchema, failureEventId: stringSchema, operationId: stringSchema };
      return {
        params: objectWith({ ...workItemTarget, ...subject, planRevision: stringSchema, expectedWorkItemRevision: integerSchema,
          evidenceKind: { enum: ["verification", "review"] }, idempotencyKey: stringSchema },
          ["workItemId", ...Object.keys(subject), "planRevision", "expectedWorkItemRevision", "idempotencyKey"]),
        result: objectWith({ cwd: stringSchema, workItemRevision: integerSchema, replayed: booleanSchema,
          receipt: objectWith({ id: stringSchema, ...subject, failedRunId: stringSchema, failedAt: stringSchema,
            candidateDigest: stringSchema, committedAt: stringSchema, reviewRevision: stringSchema },
          ["id", ...Object.keys(subject), "failedRunId", "failedAt", "candidateDigest", "committedAt"]),
        }, ["cwd", "workItemRevision", "replayed", "receipt"]),
      };
    }
    case "workItem/intake/list":
      return { params: objectWith({ sourceKind: { enum: ["channel_task", "automation_run"] }, sourceScope: stringSchema,
        limit: integerSchema }, ["sourceKind"]), result: objectWith({ cwd: stringSchema,
        receipts: { type: "array", items: nativeIntakeReceiptSchema } }, ["cwd", "receipts"]) };
    case "workItem/intake/accept":
    case "workItem/intake/retry":
      return { params: objectWith({ receiptId: stringSchema, idempotencyKey: stringSchema },
        method === "workItem/intake/accept" ? ["receiptId"] : ["receiptId", "idempotencyKey"]),
      result: objectWith({ cwd: stringSchema, receipt: nativeIntakeReceiptSchema }, ["cwd", "receipt"]) };
    case "workItem/evidence/append":
      return { params: objectWith({ ...workItemTarget, actorId: stringSchema, kind: stringSchema, subjectRevision: stringSchema,
        content: stringSchema, idempotencyKey: stringSchema, sourceRefs: arraySchema, optionId: stringSchema },
      ["workItemId", "actorId", "kind", "subjectRevision", "content", "idempotencyKey"]), result };
    case "workItem/collaboration/append":
      return { params: objectWith({ ...collaborationAppend, kind: stringSchema, action: stringSchema }, ["workItemId", "kind", "action"]), result };
    case "workItem/deliberation/start":
      return { params: objectWith({ ...collaborationAppend, workflowStepId: stringSchema }, ["workItemId"]), result };
    case "workItem/deliberation/evaluate":
      return {
        params: objectWith({ ...workItemTarget, expectedWorkItemRevision: integerSchema, idempotencyKey: stringSchema,
          decisionKey: stringSchema, subject: deliberationSubject, checkpoint: deliberationCheckpoint, checkpointRef: stringSchema,
          decisionKind: { enum: LING_APP_SERVER_DELIBERATION_DECISION_KINDS }, materiality: { enum: LING_APP_SERVER_DECISION_MATERIALITIES },
          question: stringSchema, participantIds: stringArraySchema, optionRefs: stringArraySchema, evidenceRefs: stringArraySchema,
          candidateDigest: stringSchema, decisionStepId: stringSchema, unresolved: { enum: ["intent", "fact", "handoff"] },
        }, ["workItemId", "expectedWorkItemRevision", "idempotencyKey", "decisionKey", "subject", "checkpoint", "checkpointRef",
          "decisionKind", "materiality", "question", "participantIds", "optionRefs", "evidenceRefs"]),
        result: objectWith({ cwd: stringSchema, workItemRevision: integerSchema, replayed: booleanSchema,
          evaluation: objectWith({ ...deliberationEvaluationFields, candidateDigest: stringSchema, decisionStepId: stringSchema },
            Object.keys(deliberationEvaluationFields)),
        }, ["cwd", "workItemRevision", "replayed", "evaluation"]),
      };
    case "workItem/deliberation/open":
      return { params: objectWith({ ...workItemTarget, evaluationId: stringSchema, expectedWorkItemRevision: integerSchema,
        idempotencyKey: stringSchema, execution: { enum: ["read_only_workflow"] }, ballotMode: { enum: ["when_unresolved"] } },
      ["workItemId", "evaluationId", "expectedWorkItemRevision", "idempotencyKey"]), result };
    case "workItem/deliberation/cancel":
      return { params: objectWith(deliberationSettlement, deliberationSettlementFields), result };
    case "workItem/deliberation/decide":
      return { params: objectWith({ ...deliberationSettlement, decision: { oneOf: [
        objectWith({ disposition: { enum: ["selected"] }, option: stringSchema }, ["disposition", "option"]),
        objectWith({ disposition: { enum: ["deferred", "replan_required"] } }, ["disposition"]),
      ] } }, [...deliberationSettlementFields, "decision"]), result: objectWith({
        status: { enum: ["appended", "replayed"] }, record: objectSchema, workItemRevision: integerSchema,
        appliedTo: objectWith({ workflowId: stringSchema, workflowStepId: stringSchema, planRevision: stringSchema,
          option: stringSchema, candidateDigest: stringSchema }, ["workflowId", "workflowStepId", "planRevision", "option", "candidateDigest"]),
      }, ["status", "record", "workItemRevision"]) };
    case "workItem/coordination/start":
    case "workItem/coordination/close":
      return { params: objectWith(collaborationAppend, ["workItemId"]), result };
    case "workItem/question/ask":
      return { params: objectWith({ ...collaborationAppend, planRevision: stringSchema, waitingStepId: stringSchema,
        respondentStepId: stringSchema, question: stringSchema, deadlineAt: stringSchema, answerFromStageResult: booleanSchema,
        predecessorQuestion: objectWith({ id: stringSchema, revision: integerSchema }, ["id", "revision"]) }, ["workItemId"]), result };
    case "workItem/question/reply":
      return { params: objectWith({ ...collaborationAppend, questionId: stringSchema, expectedQuestionRevision: integerSchema,
        answer: stringSchema }, ["workItemId"]), result };
    case "workItem/message/send":
      return { params: objectWith({ ...collaborationAppend, planRevision: stringSchema, targetStepId: stringSchema,
        expectedTargetRevision: stringSchema, body: stringSchema,
        expectedExecution: objectWith({ runId: stringSchema, attemptId: stringSchema }, ["runId", "attemptId"]) }, ["workItemId"]), result };
    case "workItem/handoff/accept":
    case "workItem/handoff/return":
      return { params: objectWith({ ...collaborationAppend, planRevision: stringSchema, sourceStepId: stringSchema, targetStepId: stringSchema,
        expectedSourceRevision: stringSchema, expectedTargetRevision: stringSchema, expectedCandidateDigest: stringSchema,
        previousHandoffId: stringSchema, verification: objectWith({ operationId: stringSchema, checkId: stringSchema }, ["operationId", "checkId"]),
        reason: stringSchema, detail: stringSchema }, ["workItemId"]), result };
    case "workItem/feedback/add":
      return { params: objectWith({ ...collaborationAppend, sourceRunId: stringSchema, providerPresetId: stringSchema }, ["workItemId"]),
        result: { oneOf: [
          objectWith({ cwd: stringSchema, job: objectSchema, replayed: booleanSchema }, ["cwd", "job", "replayed"]),
          objectWith({ status: { enum: ["appended", "replayed"] }, record: objectSchema, workItemRevision: integerSchema },
            ["status", "record", "workItemRevision"]),
        ] },
      };
    case "workItem/coordination/schedule/read":
    case "workItem/coordination/schedule/set":
      return { params: objectWith({ ...workItemTarget, automationId: stringSchema, expectedRevision: integerSchema,
        enabled: booleanSchema, kind: { enum: ["checkpoint", "retrospective"] }, durationMs: integerSchema }, ["workItemId", "automationId"]), result };
    case "turn/start":
      return { params: objectWith({ ...threadTarget, turnId: stringSchema, idempotencyKey: stringSchema, message: stringSchema,
        userInstruction: stringSchema, providerPresetId: stringSchema, executionBinding: objectSchema, attachmentIds: stringArraySchema }, ["threadId"]), result };
    case "turn/queue":
      return { params: objectWith({ threadId: stringSchema, expectedTurnId: stringSchema,
        expectedTurnRevision: stringSchema, message: stringSchema, userInstruction: stringSchema, idempotencyKey: stringSchema },
      ["threadId", "expectedTurnId", "expectedTurnRevision", "idempotencyKey"]), result };
    case "turn/interrupt":
      return { params: objectWith({ turnId: stringSchema, expectedTurnId: stringSchema }), result };
    case "turn/resume":
      return { params: objectWith({ ...threadTarget, turnId: stringSchema, expectedTurnRevision: stringSchema,
        sourceRunId: stringSchema, idempotencyKey: stringSchema, instruction: stringSchema }, ["turnId"]), result };
    case "thread/fork":
      return { params: objectWith({ ...threadTarget, turnId: stringSchema, sourceRunId: stringSchema, idempotencyKey: stringSchema }, ["threadId"]), result };
    case "approval/respond":
      return { params: objectWith({ approvalId: stringSchema, decision: { enum: ["approve", "deny"] }, expectedRevision: stringSchema,
        runId: stringSchema, threadId: stringSchema, turnId: stringSchema, reason: stringSchema, decisionKind: { enum: ["approve_once"] } },
      ["approvalId", "decision"]), result: objectWith({ cwd: stringSchema, approval: objectSchema }, ["cwd", "approval"]) };
    case "input/respond":
      return { params: objectWith({ schemaVersion: { enum: [1] }, authority: objectSchema, answers: arraySchema, idempotencyKey: stringSchema },
        ["schemaVersion", "authority", "answers", "idempotencyKey"]),
      result: objectWith({ cwd: stringSchema, receipt: objectSchema }, ["cwd", "receipt"]) };
    case "workItem/accept":
      return { params: objectWith({ workItemId: stringSchema, expectedWorkItemRevision: integerSchema, idempotencyKey: stringSchema },
        ["workItemId", "expectedWorkItemRevision", "idempotencyKey"]), result };
    case "workItem/pause":
    case "workItem/resume":
    case "workItem/cancel":
      return { params: objectWith({ workItemId: stringSchema, expectedWorkItemRevision: integerSchema,
        expectedControlGeneration: integerSchema, expectedRevision: integerSchema, controlGeneration: integerSchema, idempotencyKey: stringSchema },
        ["workItemId", "idempotencyKey"]), result };
    case "externalAgent/task/start":
      return { params: objectWith({ registrationId: stringSchema, submission: objectSchema }, ["registrationId", "submission"]), result };
    case "externalAgent/task/reconnect":
      return { params: objectWith({ registrationId: stringSchema, taskId: stringSchema, submissionId: stringSchema },
        ["registrationId", "taskId", "submissionId"]), result };
    case "externalAgent/task/cancel":
      return { params: objectWith({ registrationId: stringSchema, taskId: stringSchema, idempotencyKey: stringSchema },
        ["registrationId", "taskId", "idempotencyKey"]), result };
    case "externalAgent/register":
      return { params: objectWith({ registration: objectSchema, idempotencyKey: stringSchema }, ["registration", "idempotencyKey"]), result };
    case "externalAgent/capabilities/read":
      return { params: objectWith({ registrationId: stringSchema }, ["registrationId"]), result };
    case "changes/capture":
      return { params: objectWith({ ...changeSource, scope: { enum: ["working_tree", "head"] } }),
        result: objectWith(candidateResult, candidateResultFields) };
    case "changes/read":
      return { params: objectWith({ ...changeSource, candidateDigest: stringSchema, offset: integerSchema, limit: integerSchema }, ["candidateDigest"]),
        result: objectWith({ ...candidateResult, files: arraySchema, exclusions: arraySchema, exclusionCount: integerSchema,
          totalFileCount: integerSchema, nextOffset: integerSchema }, [...candidateResultFields, "files", "exclusions", "exclusionCount", "totalFileCount"]) };
    case "changes/apply/preview":
      return {
        params: { oneOf: [objectWith(recoveryTarget, recoveryFields), objectWith(transferTarget, transferFields)] },
        result: { oneOf: [
          objectWith({ ...candidateResult, action: recoveryAction, expectedRevision: stringSchema, changes: objectSchema },
            [...candidateResultFields, "action", "expectedRevision", "changes"]),
          objectWith({ ...candidateResult, action: transferAction, expectedRevision: stringSchema, targetWorktree: changeWorktree,
            targetCandidateDigest: stringSchema, targetHeadCommit: stringSchema, selection: arraySchema },
          [...candidateResultFields, "action", "expectedRevision", "targetWorktree", "targetCandidateDigest", "targetHeadCommit", "selection"]),
        ] },
      };
    case "changes/apply":
      return {
        params: { oneOf: [
          objectWith({ ...recoveryTarget, ...confirmation }, [...recoveryFields, ...confirmationFields]),
          objectWith({ ...transferTarget, ...confirmation }, [...transferFields, ...confirmationFields]),
        ] },
        result: { oneOf: [
          objectWith({ cwd: stringSchema, action: recoveryAction, turnId: stringSchema, receiptId: stringSchema, state: stringSchema },
            ["cwd", "action", "turnId", "receiptId", "state"]),
          objectWith({ cwd: stringSchema, action: transferAction, targetWorktree: changeWorktree, receiptId: stringSchema,
            state: { enum: ["applied", "not_applied", "unknown"] }, paths: stringArraySchema },
          ["cwd", "action", "targetWorktree", "receiptId", "state", "paths"]),
        ] },
      };
    case "artifact/read":
      return { params: objectWith({ artifactId: stringSchema, ...threadTarget, ...workItemTarget, runId: stringSchema,
        offset: integerSchema, limit: integerSchema }, ["artifactId"]), result };
    case "verify/plan":
      return { params: objectWith({ candidate, ...threadTarget, ...workItemTarget, requestedChecks: stringArraySchema,
        idempotencyKey: stringSchema, planRevision: stringSchema }, ["candidate"]), result: verifyPlanResult };
    case "verify/start":
      return { params: objectWith({ planId: stringSchema, planRevision: stringSchema, candidateDigest: stringSchema, idempotencyKey: stringSchema },
        ["planId", "planRevision", "candidateDigest", "idempotencyKey"]), result: verifyOperationResult };
    case "verify/status":
      return { params: objectWith({ operationId: stringSchema }, ["operationId"]),
        result: objectWith({ operation: verifyOperationResult }, ["operation"]) };
    case "verify/cancel":
      return { params: objectWith({ operationId: stringSchema, expectedRevision: stringSchema, idempotencyKey: stringSchema },
        ["operationId", "idempotencyKey"]),
        result: objectWith({ operationId: stringSchema, status: { enum: ["cancel_requested", "cancelled", "already_terminal", "unknown"] } },
          ["operationId", "status"]) };
    case "review/start":
      return { params: objectWith({ candidate, ...workItemTarget, idempotencyKey: stringSchema, reviewRulesRefs: stringArraySchema,
        providerPresetId: stringSchema, baseInstructions: stringSchema, planRevision: stringSchema }, ["candidate", "idempotencyKey"]),
        result: objectWith(reviewResult, reviewResultFields) };
    case "review/status":
      return { params: objectWith({ assessmentId: stringSchema, operationId: stringSchema }),
        result: objectWith({ ...reviewResult, revision: stringSchema, findingIds: stringArraySchema,
          summary: stringSchema, errorMessage: stringSchema, reviewRules: objectSchema }, [...reviewResultFields, "revision", "findingIds"]) };
    case "review/finding/update":
      return { params: objectWith({ assessmentId: stringSchema, findingId: stringSchema, disposition: { enum: ["open", "acknowledged", "resolved", "dismissed"] },
        expectedRevision: stringSchema, idempotencyKey: stringSchema }, ["assessmentId", "findingId", "disposition", "idempotencyKey"]), result };
    case "simplify/status":
      return { params: objectWith({ operationId: stringSchema, offset: integerSchema }, ["operationId"]), result: operationResult };
    case "simplify/start":
      return { params: objectWith({ candidate, ...workItemTarget, idempotencyKey: stringSchema, providerPresetId: stringSchema },
      ["candidate", "idempotencyKey"]), result: operationResult };
    case "doctor/run":
      return { params: objectWith({ includeLogTail: booleanSchema, scope: { enum: ["workspace", "project", "candidate"] } }), result };
    case "instructions/init":
      return { params: objectWith({ mode: { enum: ["preview", "apply"] }, idempotencyKey: stringSchema }, ["idempotencyKey"]), result };
    case "handoff/create":
      return { params: objectWith({ ...threadTarget, turnId: stringSchema, idempotencyKey: stringSchema, nextInstruction: stringSchema },
      ["threadId", "turnId", "idempotencyKey", "nextInstruction"]), result };
    case "handoff/read":
      return { params: objectWith({ handoffId: stringSchema }, ["handoffId"]), result };
    case "handoff/resume":
      return { params: objectWith({ handoffId: stringSchema, providerPresetId: stringSchema }, ["handoffId", "providerPresetId"]),
      result: objectWith({ cwd: stringSchema, handoffId: stringSchema, thread: objectSchema, replayed: booleanSchema,
        goalTransfer: objectWith({ goalId: stringSchema, sourceThreadId: stringSchema, threadId: stringSchema,
          sourceGoalRevision: stringSchema, transferredAt: stringSchema },
        ["goalId", "sourceThreadId", "threadId", "sourceGoalRevision", "transferredAt"]) }, ["cwd", "handoffId", "thread", "replayed"]) };
    case "github/intake/policy/list":
      return { params: objectSchema, result };
    case "github/intake/read":
      return { params: objectWith({ receiptId: stringSchema }, ["receiptId"]), result };
    case "github/intake/poll":
      return { params: objectWith({ repository: stringSchema, page: integerSchema }, ["repository"]), result };
    case "github/subject/read":
      return { params: objectWith({ repository: stringSchema, ...gitHubTarget }, ["repository", "kind", "number"]),
        result: objectWith({ cwd: stringSchema, subject: gitHubSubject }, ["cwd", "subject"]) };
    case "github/delivery/reconcile":
      return { params: objectWith({ ...threadTarget, ...workItemTarget, repository: stringSchema, pullRequestNumber: integerSchema,
        candidateDigest: stringSchema, expectedWorkItemRevision: integerSchema, expectedRevision: integerSchema },
      ["threadId", "workItemId", "repository", "pullRequestNumber", "candidateDigest"]), result: deliveryResult };
    case "workItem/delivery/read":
      return { params: objectWith(workItemTarget, ["workItemId"]), result: deliveryResult };
    case "github/delivery/enqueue":
      return { params: objectWith({ ...workItemTarget, deliveryId: stringSchema, expectedWorkItemRevision: integerSchema,
        idempotencyKey: stringSchema, confirmed: { enum: [true] } },
      ["workItemId", "deliveryId", "expectedWorkItemRevision", "idempotencyKey", "confirmed"]), result: gitHubQueueResult };
    case "github/delivery/queue/read":
      return { params: objectWith({ ...workItemTarget, queueReceiptId: stringSchema }, ["workItemId", "queueReceiptId"]),
        result: gitHubQueueResult };
    case "delivery/read":
      return { params: objectWith({ ...workItemTarget, deliveryId: stringSchema }, ["workItemId", "deliveryId"]), result: deliveryResult };
    case "turn/retry":
    case "turn/steer":
    case "thread/compact/start":
    case "thread/revert":
      return { params: objectSchema, result };
  }
}

const controlPlaneEvent = objectWith({
  seq: integerSchema, workspaceId: stringSchema, cwd: stringSchema, ts: stringSchema, domain: stringSchema,
  entityType: stringSchema, entityId: stringSchema, action: stringSchema, data: objectSchema, idempotencyKey: stringSchema,
}, ["seq", "workspaceId", "cwd", "ts", "domain", "entityType", "entityId", "action", "data"]);
const eventSubject = { kind: { enum: ["thread", "workItem"] }, ...threadTarget, ...workItemTarget, turnId: stringSchema };
const noticeCursor = { subscriptionId: stringSchema, cursor: stringSchema };
const durableNotice = objectWith({
  ...noticeCursor, workspaceId: stringSchema, eventId: stringSchema, subject: objectWith(eventSubject, ["kind"]),
  revision: stringSchema, ...threadTarget, runId: stringSchema, turnId: stringSchema, itemId: stringSchema,
  event: controlPlaneEvent, payload: objectSchema,
}, ["subscriptionId", "cursor", "workspaceId", "eventId", "subject", "revision", "event", "payload"]);
const directNotice = { cwd: stringSchema, ...workItemTarget, cursor: stringSchema, eventId: stringSchema };
const replayWindow = objectWith({
  disposition: { enum: ["complete", "snapshot_required"] },
  requestedAfterSeq: integerSchema, replayFloorSeq: integerSchema, upperBoundSeq: integerSchema, nextAfterSeq: integerSchema,
  reason: { enum: ["cursor_unavailable", "retention_gap", "window_exceeded"] },
}, ["disposition", "requestedAfterSeq", "replayFloorSeq", "upperBoundSeq", "nextAfterSeq"]);
const taskNotice = objectWith({ taskId: stringSchema, cursor: stringSchema, eventType: stringSchema,
  createdAt: stringSchema, payload: {} }, ["taskId", "cursor", "eventType", "createdAt"]);

function notificationSchemaFor(method: LingAppServerNotificationMethod): LingAppServerJsonSchema {
  switch (method) {
    case "initialized":
      return objectSchema;
    case "server/draining":
      return objectWith({ drainId: stringSchema, startedAt: stringSchema }, ["drainId", "startedAt"]);
    case "server/restarted":
      return objectWith({ previousServerInstanceId: stringSchema, serverInstanceId: stringSchema,
        storeIncarnation: stringSchema, authorizationEpoch: stringSchema }, ["previousServerInstanceId", "serverInstanceId"]);
    case "server/warning":
      return objectWith({ code: stringSchema, message: stringSchema }, ["message"]);
    case "server/pong":
      return pingResult;
    case "thread/replay/ready":
    case "workItem/replay/ready":
      return objectWith({ ...noticeCursor, window: replayWindow }, ["subscriptionId", "cursor", "window"]);
    case "thread/resync/required":
    case "workItem/resync/required":
      return { oneOf: [
        objectWith({ ...threadTarget, ...workItemTarget, workspaceId: stringSchema, reason: { enum: ["authorization_changed"] } }, ["reason"]),
        objectWith({ ...threadTarget, ...workItemTarget, workspaceId: stringSchema, disposition: { enum: ["snapshot_required"] },
          window: replayWindow, reason: { enum: ["cursor_unavailable", "retention_gap", "window_exceeded"] } }, ["disposition"]),
      ] };
    case "item/delta":
      return objectWith({ subscriptionId: stringSchema, workspaceId: stringSchema, subject: objectWith({ kind: { enum: ["thread"] },
        ...threadTarget, turnId: stringSchema }, ["kind", "threadId", "turnId"]), runId: stringSchema, itemId: stringSchema,
        streamEpoch: stringSchema, offset: integerSchema, text: stringSchema, truncated: { enum: [true] },
      }, ["subscriptionId", "workspaceId", "subject", "runId", "itemId", "streamEpoch", "offset", "text"]);
    case "workItem/control/updated":
      return { oneOf: [durableNotice, objectWith({ ...directNotice, workItem: objectSchema }, [...Object.keys(directNotice), "workItem"])] };
    case "workItem/deliberation/updated":
    case "workItem/stage/updated":
    case "workItem/brief/updated":
    case "workItem/coordination/updated":
    case "workItem/message/updated":
    case "workItem/question/updated":
    case "workItem/handoff/updated":
    case "workItem/device/updated":
      return { oneOf: [durableNotice, objectWith({ ...directNotice, record: objectSchema }, [...Object.keys(directNotice), "record"])] };
    case "externalAgent/registered":
      return objectWith({ registrationId: stringSchema, agentId: stringSchema, authorizationEpoch: stringSchema,
        acceptedCapabilities: stringArraySchema, deniedCapabilities: stringArraySchema },
      ["registrationId", "agentId", "authorizationEpoch", "acceptedCapabilities", "deniedCapabilities"]);
    case "externalAgent/task/started":
      return { oneOf: [taskNotice, objectWith({ task: objectSchema }, ["task"])] };
    case "externalAgent/task/reconnected":
      return objectWith({ task: objectSchema, resyncRequired: booleanSchema, events: arraySchema, reason: stringSchema }, ["task", "resyncRequired"]);
    case "externalAgent/task/updated":
    case "externalAgent/task/unknown":
      return taskNotice;
    case "$/control_plane_event":
      return objectWith({ ...noticeCursor, event: controlPlaneEvent }, ["subscriptionId", "event"]);
    case "$/run_event":
      return { oneOf: [
        objectWith({ kind: { enum: ["ready"] }, data: {} }, ["kind", "data"]),
        objectWith({ kind: { enum: ["event"] }, event: stringSchema, data: {} }, ["kind", "event", "data"]),
        objectWith({ kind: { enum: ["error"] }, statusCode: integerSchema, body: {} }, ["kind", "statusCode", "body"]),
        objectWith({ kind: { enum: ["end"] } }, ["kind"]),
      ] };
    default:
      return durableNotice;
  }
}

const serverRequestSchemas: LingAppServerSchemaDocument["serverRequests"] = {
  "approval/requestDecision": objectWith({ approvalId: stringSchema, pendingId: stringSchema, revision: stringSchema,
    ...threadTarget, runId: stringSchema, turnId: stringSchema }, ["approvalId", "pendingId", "revision"]),
  "input/requestAnswer": objectWith({ pendingId: stringSchema, ...threadTarget, itemId: stringSchema,
    request: objectWith({ requestId: stringSchema, status: { enum: ["pending"] } }, ["requestId", "status"]) },
  ["pendingId", "threadId", "itemId", "request"]),
};
const notificationSchemas = Object.fromEntries(LING_APP_SERVER_NOTIFICATION_METHODS.map(method => [method, notificationSchemaFor(method)])) as
  Record<LingAppServerNotificationMethod, LingAppServerJsonSchema>;

export const LING_APP_SERVER_METHOD_SCHEMAS: Readonly<Record<LingAppServerMethod, LingAppServerMethodSchema>> =
  Object.fromEntries(LING_APP_SERVER_METHODS.map(method => [method, schemaFor(method)])) as Record<LingAppServerMethod, LingAppServerMethodSchema>;

export function getLingAppServerSchema(): LingAppServerSchemaDocument {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Ling App Server protocol",
    protocolVersion: LING_APP_SERVER_PROTOCOL_VERSION,
    methods: LING_APP_SERVER_METHOD_SCHEMAS,
    notifications: notificationSchemas,
    serverRequests: serverRequestSchemas,
  };
}

export function validateLingAppServerParams(method: string, params: unknown): LingAppServerValidationResult {
  if (!isLingAppServerMethod(method)) return { ok: false, path: "method", message: "unknown App Server method" };
  return validateAgainstSchema(params === undefined ? {} : params, LING_APP_SERVER_METHOD_SCHEMAS[method].params, "params");
}

export function validateLingAppServerResult(method: LingAppServerMethod, result: unknown): LingAppServerValidationResult {
  return validateAgainstSchema(result, LING_APP_SERVER_METHOD_SCHEMAS[method].result, "result");
}

export function validateLingAppServerNotificationParams(method: string, params: unknown): LingAppServerValidationResult {
  if (!isLingAppServerNotificationMethod(method)) return { ok: false, path: "method", message: "unknown App Server notification" };
  return validateAgainstSchema(method === "initialized" && params === undefined ? {} : params, notificationSchemas[method], "params");
}

export function validateLingAppServerServerRequestParams(method: string, params: unknown): LingAppServerValidationResult {
  if (!LING_APP_SERVER_SERVER_REQUEST_METHODS.some(registered => registered === method)) {
    return { ok: false, path: "method", message: "unknown App Server server request" };
  }
  return validateAgainstSchema(params, serverRequestSchemas[method as LingAppServerServerRequestMethod], "params");
}

function validateAgainstSchema(value: unknown, schema: LingAppServerJsonSchema, path: string): LingAppServerValidationResult {
  if (schema.oneOf) {
    if (schema.oneOf.filter(candidate => validateAgainstSchema(value, candidate, path).ok).length === 1) return { ok: true };
    return { ok: false, path, message: "does not match any allowed shape" };
  }
  if (schema.enum && !schema.enum.includes(value as never)) return { ok: false, path, message: "must be one of the allowed values" };
  if (schema.type === "object") {
    if (!isRecord(value)) return { ok: false, path, message: "must be an object" };
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) return { ok: false, path: `${path}.${key}`, message: "is required" };
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) {
        const result = validateAgainstSchema(value[key], property, `${path}.${key}`);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return { ok: false, path, message: "must be an array" };
    if (schema.items) for (const [index, item] of value.entries()) {
      const result = validateAgainstSchema(item, schema.items, `${path}[${index}]`);
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (schema.type === "string" && typeof value !== "string") return { ok: false, path, message: "must be a string" };
  if (schema.type === "boolean" && typeof value !== "boolean") return { ok: false, path, message: "must be a boolean" };
  if (schema.type === "integer" && (!Number.isInteger(value) || !Number.isSafeInteger(value))) return { ok: false, path, message: "must be an integer" };
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return { ok: false, path, message: "must be a number" };
  if (schema.type === "null" && value !== null) return { ok: false, path, message: "must be null" };
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
