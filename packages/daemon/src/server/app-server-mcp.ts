import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { LING_APP_SERVER_ARTIFACT_RANGE_BYTES, LING_APP_SERVER_NATIVE_INTAKE_PAGE_LIMIT,
  LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS, LING_PRODUCT_VERSION } from "@ling-stack/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connectToAppServer, type AppServerLocalTransportOptions } from "./app-server-local-transport.js";
import { coordinationDecisionInput, deliberationEvaluateInput, deliberationOpenInput } from "./app-server-deliberation.js";

const objectId = z.string().min(1).max(256);
const requestKey = z.string().min(1).max(128);
const candidateDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const candidate = z.strictObject({
  workspaceId: z.string().min(1).max(4096), candidateDigest, worktreeId: objectId.optional(),
  baseCommit: objectId.optional(), headCommit: objectId.optional(),
  filePaths: z.array(z.string().min(1).max(4096)).max(1000).optional(),
});
const changeWorktree = z.strictObject({ ownerKind: z.enum(["channel", "teammate"]), ownerId: z.string().min(1).max(200) });
const transferInput = {
  sourceWorktree: changeWorktree.optional(), targetWorktree: changeWorktree, candidateDigest: z.string().length(64),
  hunkIds: z.array(z.string().length(64)).min(1).max(128),
};

export async function runLingAppServerMcp(
  options: AppServerLocalTransportOptions,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const client = connectToAppServer(options, "ling-mcp");
  const negotiated = await client.getCapabilities().catch(error => {
    client.close();
    throw error;
  });
  const methods = new Set(negotiated.methods);
  const canTransfer = negotiated.capabilities.includes("development.changeTransfer");
  const server = new McpServer({ name: "ling-app-server", version: LING_PRODUCT_VERSION });
  const describe = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  if (methods.has("thread/read")) server.registerTool("ling_thread_read", {
    description: "Read a Ling Thread and its current Goal.",
    inputSchema: z.strictObject({ threadId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ threadId }) => describe(await client.readThread(threadId)));
  if (methods.has("thread/snapshot")) server.registerTool("ling_thread_snapshot", {
    description: "Read the active Ling Turn, Run, Goal, pending requests, and event cursor.",
    inputSchema: z.strictObject({ threadId: objectId }),
    annotations: { readOnlyHint: true },
  }, async params => {
    const { turn, run, goal, cursor, pendingApprovals, pendingInputs } = await client.readThreadSnapshot(params);
    return describe({ turn, run, goal, cursor, pendingApprovals,
      pendingInputs: pendingInputs.map(({ answerAuthority: _authority, ...input }) => input) });
  });
  if (methods.has("thread/events/read")) server.registerTool("ling_thread_events", {
    description: "Read a page of Ling Thread events. Use the returned cursor to continue reading; use a Thread snapshot if resync is required.",
    inputSchema: z.strictObject({ threadId: objectId, cursor: z.string().min(1).max(128).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ threadId, cursor }) => describe(await client.readThreadEvents({ threadId, cursor, limit: 1 })));
  if (methods.has("model/list")) server.registerTool("ling_model_list", {
    description: "Read model and Provider capabilities visible to this App Server connection.",
    inputSchema: z.strictObject({ offset: z.number().int().nonnegative().optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ offset }) => describe(await client.listModels(offset)));
  if (methods.has("skill/read")) server.registerTool("ling_skill_read", {
    description: "Read one Skill definition visible to this App Server connection.",
    inputSchema: z.strictObject({ skillId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ skillId }) => describe(await client.readSkill(skillId)));
  if (methods.has("permissionProfile/list")) server.registerTool("ling_permission_profile_list", {
    description: "Read the permission axes supported by this Ling App Server connection.",
    inputSchema: z.strictObject({}),
    annotations: { readOnlyHint: true },
  }, async () => describe(await client.listPermissionProfiles()));

  if (methods.has("workItem/read")) server.registerTool("ling_work_item_read", {
    description: "Read the Work Item, its current control state and any automatic intake receipt.",
    inputSchema: z.strictObject({ workspaceId: objectId, workItemId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ workspaceId, workItemId }) => describe(await client.readWorkItemSnapshot(workspaceId, workItemId)));
  if (methods.has("workItem/device/read")) server.registerTool("ling_work_item_device_read", {
    description: "Read the durable Work Item to Device Fabric graph/node, owner host, WorkUnit and receipt projection.",
    inputSchema: z.strictObject({ workItemId: objectId }),
    annotations: { readOnlyHint: true },
  }, async ({ workItemId }) => describe(await client.readWorkItemDevice(workItemId)));
  if (methods.has("workItem/stage/read")) server.registerTool("ling_work_item_stages", {
    description: "Read the accepted Workflow stages, current blockers, and bounded stage evidence for a Work Item.",
    inputSchema: z.strictObject({ workItemId: objectId, stageOffset: z.number().int().nonnegative().optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ workItemId, stageOffset }) => describe(await client.readWorkItemStages(workItemId, stageOffset)));
  if (methods.has("workItem/collaboration/read")) server.registerTool("ling_work_item_collaboration", {
    description: "Read scoped Work Item messages, questions, evidence notes, or deliberation records.",
    inputSchema: z.strictObject({ workItemId: objectId,
      kind: z.enum(["message", "question", "deliberation", "coordination", "stage", "brief"]),
      afterRevision: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }),
    annotations: { readOnlyHint: true },
  }, async params => describe(await client.readWorkItemCollaboration(params)));
  if (methods.has("artifact/read")) server.registerTool("ling_artifact_read", {
    description: "Read bounded bytes from an authorized Ling artifact. Use ranges for large files.",
    inputSchema: z.strictObject({ artifactId: objectId, offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(LING_APP_SERVER_ARTIFACT_RANGE_BYTES).optional(), threadId: objectId.optional(),
      workItemId: objectId.optional(), runId: objectId.optional() }),
    annotations: { readOnlyHint: true },
  }, async params => describe(await client.readArtifact(params)));

  if (options.authToken) {
    const followupInput = z.strictObject({ threadId: objectId, expectedTurnId: objectId, expectedTurnRevision: objectId,
      message: z.string().min(1).max(16_384), idempotencyKey: requestKey });
    if (methods.has("thread/start")) server.registerTool("ling_thread_start", {
      description: "Create a Ling Thread in the connected workspace. Use the same request key when retrying.",
      inputSchema: z.strictObject({ title: z.string().min(1).max(200), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async ({ title, idempotencyKey }) => describe(await client.startThread({
      title, threadId: `thread_mcp_${createHash("sha256").update(idempotencyKey).digest("hex")}`,
    })));
    if (methods.has("turn/start")) server.registerTool("ling_turn_start", {
      description: "Submit a Turn to Ling using a configured provider preset. Use the same key when retrying.",
      inputSchema: z.strictObject({
        threadId: objectId, message: z.string().min(1).max(16_384), providerPresetId: objectId, idempotencyKey: requestKey,
      }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.startTurn(params)));
    if (methods.has("workItem/create")) server.registerTool("ling_work_item_create", {
      description: "Submit a source occurrence to the task inbox. A GitHub subject joins existing work. Link a channel Task or AutomationRun by its source ID to follow that execution.",
      inputSchema: z.strictObject({ sourceId: objectId, title: z.string().min(1).max(200), idempotencyKey: requestKey,
        gitHubSubject: z.strictObject({ repository: z.string().min(3).max(201), kind: z.enum(["issue", "pull_request"]), number: z.number().int().positive() }).optional(),
        sourceType: z.enum(["channel_task", "automation_run", "device_task_graph_node"]).optional(), linkExistingExecution: z.boolean().optional(),
      }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.createWorkItem(params)));
    if (methods.has("workItem/accept")) server.registerTool("ling_work_item_accept", {
      description: "Accept a Work Item and give its primary execution to a Ling conversation. A retry uses the original dispatch.",
      inputSchema: z.strictObject({ workItemId: objectId, expectedWorkItemRevision: z.number().int().positive(), idempotencyKey: requestKey,
        dispatch: z.strictObject({ threadId: objectId, message: z.string().min(1).max(16_384), providerPresetId: objectId.optional() }).optional(),
      }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.acceptWorkItem(params)));
    if (methods.has("workItem/device/bind")) server.registerTool("ling_work_item_device_bind", {
      description: "Bind one accepted Work Item to a Device Fabric graph node and its owner-host WorkUnit. Retry with the same key.",
      inputSchema: z.strictObject({ workItemId: objectId, graphId: objectId, graphNodeId: objectId,
        graphRevision: z.number().int().positive(), ownerHostId: objectId, ownerRouteGeneration: z.number().int().positive(),
        workUnitId: objectId, attemptId: objectId.optional(), expectedWorkItemRevision: z.number().int().positive(), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.bindWorkItemDevice(params)));
    if (methods.has("workItem/device/receipt")) server.registerTool("ling_work_item_device_receipt", {
      description: "Record an owner-host Device Fabric receipt. Unknown remains durable until the owner supplies a later reconciliation receipt.",
      inputSchema: z.strictObject({ workItemId: objectId, bindingId: objectId, expectedBindingRevision: z.number().int().positive(),
        expectedWorkItemRevision: z.number().int().positive(), ownerHostId: objectId, ownerRouteGeneration: z.number().int().positive(),
        workUnitId: objectId, attemptId: objectId.optional(), status: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
        resultRef: z.string().min(1).max(512), reconciled: z.boolean().optional(), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.recordWorkItemDeviceReceipt(params)));
    if (methods.has("workItem/workflow/bind")) server.registerTool("ling_work_item_workflow_bind", {
      description: "Bind an accepted Plan to its converted Workflow. Supply the paused predecessor, accepted successor and any retained independent results or active executions. Retry with the same key.",
      inputSchema: z.strictObject({ workItemId: objectId, planId: objectId,
        expectedPlanRevision: z.number().int().nonnegative(), expectedWorkItemRevision: z.number().int().nonnegative(), idempotencyKey: requestKey,
        previousWorkflowId: objectId.optional(), resolvedPlanChangeIds: z.array(objectId).max(50).optional(),
        retainStageResults: z.array(z.strictObject({
          sourceStepId: objectId, expectedSourceRevision: objectId, targetStepId: objectId,
        })).max(20).optional(),
        retainStageExecutions: z.array(z.strictObject({
          sourceStepId: objectId, expectedSourceRevision: objectId, targetStepId: objectId, sourceRunId: objectId,
        })).max(20).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.bindWorkItemWorkflow(params)));
    const planChange = {
      workItemId: objectId, planRevision: objectId, expectedWorkItemRevision: z.number().int().positive(), idempotencyKey: requestKey,
    };
    if (methods.has("workItem/plan/change/request")) server.registerTool("ling_work_item_plan_change_request", {
      description: "Record an authorized change to the accepted Plan. Hold the named stages and their downstream dependencies.",
      inputSchema: z.strictObject({ ...planChange, affectedStageIds: z.array(objectId).min(1).max(50), reason: z.string().min(1).max(2000) }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.requestWorkItemPlanChange(params)));
    if (methods.has("workItem/plan/change/withdraw")) server.registerTool("ling_work_item_plan_change_withdraw", {
      description: "Withdraw one pending Plan change and release its stage hold.",
      inputSchema: z.strictObject({ ...planChange, changeId: objectId }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.withdrawWorkItemPlanChange(params)));
    const stageHandoff = {
      workItemId: objectId, planRevision: objectId, sourceStepId: objectId, targetStepId: objectId,
      expectedSourceRevision: objectId, expectedTargetRevision: objectId,
      expectedWorkItemRevision: z.number().int().positive(), idempotencyKey: requestKey,
      detail: z.string().max(1200).optional(),
      expectedCandidateDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    };
    if (methods.has("workItem/handoff/accept")) server.registerTool("ling_stage_handoff_accept", {
      description: "Accept the current supplying stage packet. To repair a return, supply the previous handoff ID and any required independent verification for the current candidate.",
      inputSchema: z.strictObject({ ...stageHandoff,
        previousHandoffId: objectId.optional(), verification: z.strictObject({ operationId: objectId, checkId: objectId }).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.settleWorkItemStageHandoff("accept", params)));
    if (methods.has("workItem/handoff/return")) server.registerTool("ling_stage_handoff_return", {
      description: "Return the supplying stage packet with a reason and its offered candidate digest, when available. The receiving stage waits for an accepted repair.",
      inputSchema: z.strictObject({ ...stageHandoff, reason: z.enum(LING_APP_SERVER_STAGE_HANDOFF_RETURN_REASONS) }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.settleWorkItemStageHandoff("return", params)));
    if (methods.has("workItem/message/send")) server.registerTool("ling_stage_message_send", {
      description: "Queue coordination context for an accepted Plan stage. For a running stage, supply its current Run and Attempt.",
      inputSchema: z.strictObject({ ...planChange, targetStepId: objectId, expectedTargetRevision: objectId, body: z.string().min(1).max(1200),
        expectedExecution: z.strictObject({ runId: objectId, attemptId: objectId }).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.sendWorkItemStageMessage(params)));
    if (methods.has("workItem/question/ask")) server.registerTool("ling_stage_question_ask", {
      description: "Ask an assigned stage a question and hold the waiting stage's admission until the answer is recorded.",
      inputSchema: z.strictObject({ ...planChange, waitingStepId: objectId, respondentStepId: objectId,
        deadlineAt: objectId, question: z.string().min(1).max(1200), answerFromStageResult: z.boolean().optional(),
        predecessorQuestion: z.strictObject({ id: z.string().min(1).max(256), revision: z.number().int().positive() }).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.askWorkItemStageQuestion(params)));
    if (methods.has("workItem/question/reply")) server.registerTool("ling_stage_question_reply", {
      description: "Record an answer for a current Plan stage question and recheck the waiting stage.",
      inputSchema: z.strictObject({ workItemId: objectId, questionId: objectId, expectedQuestionRevision: z.number().int().positive(),
        expectedWorkItemRevision: z.number().int().positive(), answer: z.string().min(1).max(1200), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.replyToWorkItemStageQuestion(params)));
    const plan = { threadId: objectId, planId: objectId, expectedRevision: z.number().int().positive() };
    if (methods.has("plan/refine")) server.registerTool("ling_plan_refine", {
      description: "Create the next draft from a Ling Plan at its current revision.",
      inputSchema: z.strictObject({ ...plan, draft: z.strictObject({
        title: z.string().min(1).max(500), bodyMarkdown: z.string().min(1).max(65_536),
      }).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.refinePlan(params)));
    if (methods.has("plan/accept")) server.registerTool("ling_plan_accept_workflow", {
      description: "Accept a Plan revision as a staged Workflow using the supplied participant and dependency previews.",
      inputSchema: z.strictObject({ ...plan, workflowTitle: z.string().min(1).max(500).optional(),
        workflowStepPreviews: z.array(z.strictObject({
          stageId: objectId, title: z.string().min(1).max(500),
          ownerId: objectId.optional(), ownerLabel: z.string().min(1).max(160).optional(),
          dependsOnStageIds: z.array(objectId).max(50).optional(),
          handoffFromStageIds: z.array(objectId).max(20).optional(),
          requiredTools: z.array(z.enum(["read", "grep", "find", "ls", "bash", "edit", "write"])).max(7).optional(),
          requiredDecision: z.strictObject({
            question: z.string().min(1).max(500), options: z.array(z.string().min(1).max(200)).min(2).max(12),
            trigger: z.literal("when_ready").optional(),
            ballot: z.strictObject({ voterStageIds: z.array(objectId).min(2).max(12), quorum: z.number().int().min(2).max(12) }).optional(),
          }).optional(),
        })).min(1).max(50),
      }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.acceptPlanAsWorkflow({ ...params, mode: "workflow" })));
    if (methods.has("handoff/create")) server.registerTool("ling_handoff_create", {
      description: "Seal the current candidate and the latest settled Ling Turn for a handoff.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, idempotencyKey: requestKey,
        nextInstruction: z.string().min(1).max(8192) }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.createHandoff(params)));
    if (methods.has("handoff/read")) server.registerTool("ling_handoff_read", {
      description: "Read a sealed Ling handoff.",
      inputSchema: z.strictObject({ handoffId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readHandoff(params)));
    if (methods.has("handoff/resume")) server.registerTool("ling_handoff_resume", {
      description: "Continue a sealed Ling handoff in its successor conversation and transfer the accepted Goal with its usage and budget.",
      inputSchema: z.strictObject({ handoffId: objectId, providerPresetId: objectId }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.resumeHandoff(params)));
    if (methods.has("changes/capture")) server.registerTool("ling_changes_capture", {
      description: "Capture the current working-tree candidate and its coverage.",
      inputSchema: z.strictObject({ sourceWorktree: changeWorktree.optional() }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.captureChanges(params)));
    if (methods.has("changes/read")) server.registerTool("ling_changes_read", {
      description: "Read the bounded current candidate diff for a captured candidate digest.",
      inputSchema: z.strictObject({ candidateDigest: z.string().length(64), offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(50).optional(), sourceWorktree: changeWorktree.optional() }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readChanges(params)));
    if (methods.has("verify/plan")) server.registerTool("ling_verify_plan", {
      description: "Select registered verification checks for a captured candidate. Supply the Work Item and accepted Plan when the checks belong to a staged workflow.",
      inputSchema: z.strictObject({ candidate, threadId: objectId.optional(), workItemId: objectId.optional(), planRevision: objectId.optional(),
        requestedChecks: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u)).max(64).optional(), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.planVerification(params)));
    if (methods.has("verify/start")) server.registerTool("ling_verify_start", {
      description: "Run a verification plan against its candidate digest. Reuse the request key when retrying.",
      inputSchema: z.strictObject({ planId: objectId, planRevision: objectId, candidateDigest, idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.startVerification(params)));
    if (methods.has("verify/status")) server.registerTool("ling_verify_status", {
      description: "Read the committed verification results and structured evidence for an operation.",
      inputSchema: z.strictObject({ operationId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.getVerificationStatus(params)));
    if (methods.has("verify/cancel")) server.registerTool("ling_verify_cancel", {
      description: "Request cancellation of a verification. Check its status for a confirmed outcome.",
      inputSchema: z.strictObject({ operationId: objectId, expectedRevision: objectId.optional(), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true },
    }, async params => describe(await client.cancelVerification(params)));
    if (methods.has("review/start")) server.registerTool("ling_review_start", {
      description: "Start a code review of a captured candidate, with the Work Item and accepted Plan revision when applicable.",
      inputSchema: z.strictObject({ candidate, workItemId: objectId.optional(), planRevision: objectId.optional(), providerPresetId: objectId.optional(),
        baseInstructions: z.string().max(8000).optional(), reviewRulesRefs: z.array(z.string().min(1).max(1024)).max(24).optional(),
        idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.startReview(params)));
    if (methods.has("review/status")) server.registerTool("ling_review_status", {
      description: "Read a review's result, revision, candidate, and Work Item binding.",
      inputSchema: z.strictObject({ operationId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.getReviewStatus(params)));
    if (methods.has("review/finding/update")) server.registerTool("ling_review_finding_update", {
      description: "Record a finding's disposition. Resolving a finding checks the current candidate.",
      inputSchema: z.strictObject({ assessmentId: objectId, findingId: objectId,
        disposition: z.enum(["open", "acknowledged", "resolved", "dismissed"]),
        closeReason: z.enum(["false_positive", "accepted_risk", "not_reproducible", "duplicate", "out_of_scope"]).optional(),
        reason: z.string().max(2000).optional(), expectedRevision: objectId.optional(), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.updateReviewFinding(params)));
    if (methods.has("changes/apply/preview")) server.registerTool("ling_changes_preview_recovery", {
      description: "Preview undo or reapply for a completed Ling Turn before committing the workspace recovery.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, action: z.enum(["undo", "reapply"]) }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.previewChangeRecovery(params)));
    if (methods.has("changes/apply")) server.registerTool("ling_changes_apply_recovery", {
      description: "Apply a previously reviewed Turn recovery preview using its exact revision and idempotency key.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, action: z.enum(["undo", "reapply"]), expectedRevision: z.string().length(64), idempotencyKey: requestKey, confirmed: z.literal(true) }),
      annotations: { idempotentHint: true, destructiveHint: true },
    }, async params => describe(await client.applyChanges(params)));
    if (canTransfer && methods.has("changes/apply/preview")) server.registerTool("ling_changes_preview_transfer", {
      description: "Preview transferring selected hunk IDs from the captured candidate to an owned worktree.",
      inputSchema: z.strictObject(transferInput),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.previewChangeTransfer({ ...params, action: "apply" })));
    if (canTransfer && methods.has("changes/apply")) server.registerTool("ling_changes_apply_transfer", {
      description: "Apply a confirmed hunk transfer with its preview revision and idempotency key.",
      inputSchema: z.strictObject({ ...transferInput, expectedRevision: z.string().length(64), idempotencyKey: requestKey, confirmed: z.literal(true) }),
      annotations: { idempotentHint: true, destructiveHint: true },
    }, async params => describe(await client.applyChangeTransfer({ ...params, action: "apply" })));
    if (methods.has("workItem/intake/list")) server.registerTool("ling_native_intake_list", {
      description: "Read the evaluations and dispatch receipts for a Channel Task or Automation source.",
      inputSchema: z.strictObject({ sourceKind: z.enum(["channel_task", "automation_run"]),
        sourceScope: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(LING_APP_SERVER_NATIVE_INTAKE_PAGE_LIMIT).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    }, async params => describe(await client.listNativeWorkIntake(params)));
    if (methods.has("workItem/stage/recover")) server.registerTool("ling_work_item_stage_recover", {
      description: "Recover a stalled stage using the accepted Plan's Verify or Review evidence for its current failure and candidate.",
      inputSchema: z.strictObject({ workItemId: objectId, workflowStepId: objectId, planRevision: objectId, blockerId: objectId,
        failureEventId: objectId, operationId: objectId, evidenceKind: z.enum(["verification", "review"]).optional(),
        expectedWorkItemRevision: z.number().int().positive(), idempotencyKey: requestKey }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.recoverWorkItemStage(params)));
    if (methods.has("workItem/coordination/decision/submit")) server.registerTool("ling_coordination_decision_submit", {
      description: "Register a decision for evaluation when an open scheduled checkpoint closes. Supply the current accepted stage and its evidence.",
      inputSchema: coordinationDecisionInput,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.submitCoordinationDecision(params)));
    if (methods.has("workItem/coordination/decisions/read")) server.registerTool("ling_coordination_decisions_read", {
      description: "Read the registered, pending or terminal decision receipts for a checkpoint round.",
      inputSchema: z.strictObject({ workItemId: objectId, roundId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readCoordinationDecisions(params)));
    if (methods.has("workItem/deliberation/evaluate")) server.registerTool("ling_deliberation_evaluate", {
      description: "Evaluate a Work Item decision using a current draft or stage checkpoint and its evidence. A suggestion waits for operator acceptance.",
      inputSchema: deliberationEvaluateInput,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.evaluateWorkItemDeliberation(params)));
    if (methods.has("workItem/deliberation/open")) server.registerTool("ling_deliberation_open", {
      description: "Accept a current deliberation suggestion. Use read_only_shaping with a budget for draft consultations, or read_only_workflow for an accepted stage.",
      inputSchema: deliberationOpenInput,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.openWorkItemDeliberation(params)));
    const roundSettlement = deliberationOpenInput.omit({ evaluationId: true, execution: true, ballotMode: true, shapingBudget: true }).extend({
      roundId: objectId, expectedRoundRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(2000),
    });
    if (methods.has("workItem/deliberation/decide")) server.registerTool("ling_deliberation_decide", {
      description: "Record the operator's decision for the current round. Supply the selected option reference exactly as recorded.",
      inputSchema: roundSettlement.extend({ decision: z.discriminatedUnion("disposition", [
        z.object({ disposition: z.literal("selected"), option: z.string().min(1).max(200) }),
        z.object({ disposition: z.enum(["deferred", "replan_required"]) }),
      ]) }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.decideWorkItemDeliberation(params)));
    if (methods.has("workItem/deliberation/cancel")) server.registerTool("ling_deliberation_cancel", {
      description: "Close a deliberation without a decision and retain its record.",
      inputSchema: roundSettlement,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.cancelWorkItemDeliberation(params)));
    if (methods.has("workItem/intake/accept")) server.registerTool("ling_native_intake_accept", {
      description: "Accept a suggested Channel Task or Automation occurrence by receipt ID. The original execution owner handles dispatch.",
      inputSchema: z.strictObject({ receiptId: z.string().regex(/^intake_[a-f0-9]{64}$/u) }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.acceptNativeWorkIntake(params)));
    if (methods.has("workItem/intake/retry")) server.registerTool("ling_native_intake_retry", {
      description: "Re-evaluate a blocked native occurrence under current policy using the same execution identity.",
      inputSchema: z.strictObject({ receiptId: z.string().regex(/^intake_[a-f0-9]{64}$/u), idempotencyKey: z.string().min(1).max(200) }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.retryNativeWorkIntake(params)));
    if (methods.has("github/intake/poll")) server.registerTool("ling_github_intake_poll", {
      description: "Evaluate a registered GitHub intake page under its current manual, suggestion, or automatic admission policy.",
      inputSchema: z.strictObject({ repository: z.string().min(3).max(201), page: z.number().int().min(1).max(500).optional(),
        retryKey: z.string().max(160).optional() }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.pollGitHubIntake(params)));
    if (methods.has("github/delivery/enqueue")) server.registerTool("ling_github_delivery_enqueue", {
      description: "Admit a current trusted GitHub delivery to the provider-enforced merge queue.",
      inputSchema: z.strictObject({ workItemId: objectId, deliveryId: objectId, expectedWorkItemRevision: z.number().int().positive(),
        idempotencyKey: requestKey, confirmed: z.literal(true) }),
      annotations: { idempotentHint: true, destructiveHint: true },
    }, async params => describe(await client.enqueueGitHubDelivery(params)));
    if (methods.has("github/delivery/queue/read")) server.registerTool("ling_github_delivery_queue_read", {
      description: "Read and reconcile a provider-owned GitHub merge queue receipt.",
      inputSchema: z.strictObject({ workItemId: objectId, queueReceiptId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readGitHubQueue(params)));
    if (methods.has("github/intake/read")) server.registerTool("ling_github_intake_read", {
      description: "Read a durable GitHub intake evaluation receipt.",
      inputSchema: z.strictObject({ receiptId: objectId }),
      annotations: { readOnlyHint: true },
    }, async params => describe(await client.readGitHubIntake(params)));
    if (methods.has("github/intake/policy/list")) server.registerTool("ling_github_intake_policies", {
      description: "Read registered GitHub intake policies and provider availability.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    }, async () => describe(await client.listGitHubIntakePolicies()));
    if (methods.has("turn/queue")) server.registerTool("ling_turn_queue", {
      description: "Queue a follow-up for the active Ling Turn from ling_thread_snapshot. Retry with the same request key.",
      inputSchema: followupInput,
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.queueTurn(params)));
    if (methods.has("turn/interrupt")) server.registerTool("ling_turn_interrupt", {
      description: "Request a stop for the current Run on a Ling Turn.",
      inputSchema: z.strictObject({ threadId: objectId, turnId: objectId, expectedTurnRevision: objectId.optional() }),
    }, async params => describe(await client.interruptTurn(params)));
    if (methods.has("turn/resume")) server.registerTool("ling_turn_resume", {
      description: "Recover a prepared or stopped Ling Turn using its observed revision. Reuse the recovery key when retrying.",
      inputSchema: z.strictObject({
        threadId: objectId, turnId: objectId, expectedTurnRevision: objectId, sourceRunId: objectId.optional(),
        idempotencyKey: requestKey, instruction: z.string().max(16_384).optional(),
      }),
      annotations: { idempotentHint: true, destructiveHint: false },
    }, async params => describe(await client.resumeTurn(params)));
    if (methods.has("turn/interrupt")) server.registerTool("ling_turn_redirect", {
      description: "Stop the observed Ling Turn and submit a follow-up after its Run settles. Retry with the same request key.",
      inputSchema: followupInput,
      annotations: { idempotentHint: true, destructiveHint: true },
    }, async params => describe(await client.redirectTurn(params)));
  }

  const transport = new StdioServerTransport(input, output, { maxBufferSize: 1024 * 1024 });
  const closed = new Promise<void>(resolve => {
    server.server.onclose = resolve;
    input.once("end", resolve);
    input.once("close", resolve);
  });
  try {
    await server.connect(transport);
    await closed;
  } finally {
    client.close();
    await server.close();
  }
}
