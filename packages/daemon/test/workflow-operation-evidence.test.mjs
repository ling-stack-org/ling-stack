import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  approvalSideEffectFingerprintV1,
  createApprovalResumeBasisV1,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import {
  createRequiredParticipantManifestV1,
  delegatedStepFinalizationBasisFingerprintV1,
  workflowGraphFingerprintV1,
} from "../../contracts/dist/index.js";
import { confirmChannelExecutionProposalWorkflow } from "../dist/features/channels/proposal-workflows.js";
import { materializeCommandIntent } from "../dist/features/channels/command-operation-match.js";
import {
  finalizeOrchestratedWorkflowStepRun,
  retryChannelWorkflowStep,
  syncWorkflowApprovalDecision,
} from "../dist/features/channels/orchestrator.js";
import { verifyWorkflowStepExecutionOperations } from "../dist/features/channels/workflow-operation-evidence.js";
import { syncWorkflowSourceTurnProgress } from "../dist/features/channels/workflow-source-turn.js";
import {
  createWorkflowStepOutputArtifact,
  extractWorkflowStepChangedPaths,
} from "../dist/features/channels/workflow-step-packets.js";
import { evaluateWorkflowCompletion, evaluateWorkflowCompletionGate } from "../dist/features/channels/workflow-completion-gate.js";
import { materializeWorkflowDelegatedStepRequirements } from "../dist/features/channels/workflow-step-requirement.js";
import { preflightWorkflowParticipantProvider } from "../dist/features/channels/workflow-participant-provider.js";
import {
  finalizeDelegatedWorkflowStepFromCanonicalState,
} from "../dist/features/channels/workflow-step-finalizer.js";
import { reconcileWorkflowFromCanonicalState } from "../dist/features/channels/workflow-reconciliation.js";
import {
  configureTerminalReportStore,
  processWorkflowTerminalReport,
} from "../dist/features/channels/terminal-report-coordinator.js";
import { ApprovalResumeCoordinator } from "../dist/features/runs/approval-resume-coordinator.js";
import { workflowExactCommandBindingRejection } from "../dist/features/runs/approvals.js";
import {
  listAllExecutionActionsForRun,
  listExecutionActions,
} from "../dist/features/runs/execution-actions.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";

test("workflow changed paths come only from succeeded typed workspace action refs", () => {
  assert.deepEqual(extractWorkflowStepChangedPaths({
    actions: [
      { actionType: "write", status: "succeeded", targetRefs: [{ type: "file", path: "src/index.ts" }] },
      { actionType: "edit", status: "succeeded", targetRefs: [{ type: "file", path: "src/index.ts" }] },
      { actionType: "write", status: "waiting_for_approval", targetRefs: [{ type: "file", path: "src/pending.ts" }] },
      { actionType: "edit", status: "failed", targetRefs: [{ type: "file", path: "src/failed.ts" }] },
      { actionType: "write", status: "succeeded", targetRefs: [{ type: "file", path: "workflows/internal.json" }] },
      { actionType: "write", status: "succeeded", targetRefs: [{ type: "file", path: "../outside.txt" }] },
    ],
  }), ["src/index.ts", "workflows/internal.json"]);
  assert.deepEqual(extractWorkflowStepChangedPaths({
    cwd: "/workspace/project",
    actions: [
      { actionType: "write", status: "succeeded", targetRefs: [{ type: "file", path: "/workspace/project/src/index.ts" }] },
      { actionType: "edit", status: "succeeded", targetRefs: [{ type: "file", path: "/tmp/outside.ts" }] },
    ],
  }), ["src/index.ts"]);
});

test("complete Run action evidence retains an early write after later reads", async () => {
  const fixture = await createOperationFixture("complete-action-history", []);
  try {
    fixture.store.appendEvent(fixture.run.id, "tool_start", {
      toolCallId: "aaa_write",
      toolName: "write",
      args: { path: "created.txt", content: "created" },
    });
    fixture.store.appendEvent(fixture.run.id, "tool_end", {
      toolCallId: "aaa_write",
      toolName: "write",
      isError: false,
    });
    for (let index = 0; index < 501; index += 1) {
      const toolCallId = `read_${String(index).padStart(3, "0")}`;
      fixture.store.appendEvent(fixture.run.id, "tool_start", {
        toolCallId,
        toolName: "read",
        args: { path: `read-${index}.txt` },
      });
      fixture.store.appendEvent(fixture.run.id, "tool_end", {
        toolCallId,
        toolName: "read",
        isError: false,
      });
    }
    const bounded = listExecutionActions(fixture.store, { runId: fixture.run.id, limit: 500 });
    const complete = listAllExecutionActionsForRun(fixture.store, fixture.run.id);
    assert.equal(bounded.some((action) => action.toolCallId === "aaa_write"), false);
    assert.ok(complete.some((action) => action.toolCallId === "aaa_write"));
    assert.equal(complete.length, 502);
  } finally {
    await fixture.close();
  }
});

test("tool-end touchedPaths become every real file target", async () => {
  const fixture = await createOperationFixture("patch-touched-paths", []);
  try {
    fixture.store.appendEvent(fixture.run.id, "tool_start", {
      toolCallId: "patch_write",
      toolName: "write",
      args: { path: "2 files", content: "patch" },
    });
    fixture.store.appendEvent(fixture.run.id, "tool_end", {
      toolCallId: "patch_write",
      toolName: "write",
      isError: false,
      result: { details: { status: "applied", touchedPaths: ["src/a.ts", "workflows/foo.yml"] } },
    });
    const action = listAllExecutionActionsForRun(fixture.store, fixture.run.id)
      .find((candidate) => candidate.toolCallId === "patch_write");
    assert.ok(action);
    assert.deepEqual(action.targetRefs.filter((ref) => ref.type === "file").map((ref) => ref.path), ["src/a.ts", "workflows/foo.yml"]);
    assert.deepEqual(extractWorkflowStepChangedPaths({ cwd: fixture.cwd, actions: [action] }), ["src/a.ts", "workflows/foo.yml"]);
  } finally {
    await fixture.close();
  }
});

test("Host rejects a workflow bash command that is not the owned exact operation", () => {
  const binding = operation(
    "verify_target",
    "run_command",
    "command",
    "node app.js",
    [],
    { kind: "exact_command", command: "node app.js" },
  );
  assert.match(
    workflowExactCommandBindingRejection({
      bindings: [binding],
      request: { toolName: "bash", input: { command: "node -e \"console.log('ok')\"" } },
    }),
    /Expected one of: node app\.js/u,
  );
  assert.equal(workflowExactCommandBindingRejection({
    bindings: [binding],
    request: { toolName: "bash", input: { command: "node app.js" } },
  }), undefined);
  assert.equal(workflowExactCommandBindingRejection({
    bindings: [{ ...binding, commandMatchPolicy: { kind: "executable", executable: "node" } }],
    request: { toolName: "bash", input: { command: "node -e \"console.log('ok')\"" } },
  }), undefined);
});

test("natural-language executable materialization requires a nearby execution objective", () => {
  assert.deepEqual(materializeCommandIntent("然后运行 Node 调用 formatProof(\"7319\") 验证"), {
    targetLabel: "Node",
    policy: { kind: "executable", executable: "node" },
  });
  assert.equal(materializeCommandIntent("Node 是什么？"), undefined);
  assert.equal(materializeCommandIntent("运行项目测试，顺便介绍 Node 的 API。"), undefined);
  assert.equal(materializeCommandIntent("创建 node.md，然后运行验证。"), undefined);
});

test("workflow blocks when a required command has no execution evidence", async () => {
  const fixture = await createOperationFixture("missing-command", [
    operation("run_command", "run_command", "command", "node app.js"),
  ]);
  try {
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T12:00:10.000Z");
    finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.step.id, fixture.task.id, fixture.store.getRun(fixture.run.id), "2026-08-12T12:00:11.000Z");
    const step = fixture.store.getChannelWorkflowStep(fixture.step.id);
    assert.equal(step.status, "blocked");
    assert.equal(step.metadata.executionVerification.status, "blocked");
    assert.equal(step.metadata.executionVerification.operationResults[0].reasonCode, "required_operation_missing_evidence");
    assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "blocked");
  } finally {
    await fixture.close();
  }
});

test("workflow does not accept a command that only contains the planned command", async () => {
  const fixture = await createOperationFixture("command-substring", [
    operation("run_command", "run_command", "command", "node app.js"),
  ]);
  try {
    appendBashAction(fixture.store, fixture.run.id, "echo node app.js", {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    const verification = verifyWorkflowStepExecutionOperations({
      store: fixture.store,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
      now: "2026-08-12T12:00:09.000Z",
    });
    assert.equal(verification.status, "blocked");
    assert.equal(verification.operationResults[0].status, "missing");
    assert.equal(verification.operationResults[0].reasonCode, "required_operation_missing_evidence");
  } finally {
    await fixture.close();
  }
});

test("workflow accepts a quote-aware Node command for executable policy", async () => {
  const fixture = await createOperationFixture("node-executable", [
    operation(
      "run_command",
      "run_command",
      "command",
      "Node",
      [],
      { kind: "executable", executable: "node" },
    ),
  ]);
  try {
    appendBashAction(fixture.store, fixture.run.id, "node -e 'const x = 1; console.log(x)'", {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    const verification = verifyWorkflowStepExecutionOperations({
      store: fixture.store,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
      now: "2026-08-12T12:00:09.250Z",
    });
    assert.equal(verification.status, "verified", JSON.stringify(verification));
    assert.equal(verification.operationResults[0].status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("workflow exact command policy ignores the display label", async () => {
  const fixture = await createOperationFixture("exact-display-label", [
    operation(
      "run_command",
      "run_command",
      "command",
      "Run the requested Node check",
      [],
      { kind: "exact_command", command: "node app.js" },
    ),
  ]);
  try {
    appendBashAction(fixture.store, fixture.run.id, "node app.js", {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    const verification = verifyWorkflowStepExecutionOperations({
      store: fixture.store,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
      now: "2026-08-12T12:00:09.375Z",
    });
    assert.equal(verification.status, "verified", JSON.stringify(verification));
  } finally {
    await fixture.close();
  }
});

test("workflow rejects unsafe or unrelated commands for executable policy", async (t) => {
  for (const [suffix, command] of [
    ["echo", "echo node -e 'console.log(1)'"],
    ["env", "env node -e 'console.log(1)'"],
    ["sudo", "sudo node -e 'console.log(1)'"],
    ["shell-wrapper", "sh -c 'node -e \\\"console.log(1)\\\"'"],
    ["chain", "node -e 'process.exit(1)' && echo ok"],
    ["redirect", "node app.js > output.txt"],
    ["substitution", "node -e \"console.log($(pwd))\""],
    ["unrelated", "ls"],
  ]) {
    await t.test(suffix, async () => {
      const fixture = await createOperationFixture(`node-executable-${suffix}`, [
        operation(
          "run_command",
          "run_command",
          "command",
          "Node",
          [],
          { kind: "executable", executable: "node" },
        ),
      ]);
      try {
        appendBashAction(fixture.store, fixture.run.id, command, {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
        });
        const verification = verifyWorkflowStepExecutionOperations({
          store: fixture.store,
          step: fixture.store.getChannelWorkflowStep(fixture.step.id),
          now: "2026-08-12T12:00:09.500Z",
        });
        assert.equal(verification.status, "blocked", `${suffix}: ${JSON.stringify(verification)}`);
        assert.equal(verification.operationResults[0].reasonCode, "required_operation_missing_evidence");
      } finally {
        await fixture.close();
      }
    });
  }
});

test("workflow preserves case-sensitive file targets on POSIX", { skip: process.platform === "win32" }, async () => {
  const fixture = await createOperationFixture("posix-path-case", [
    operation("create_file", "file_create", "file", "App.js"),
  ]);
  try {
    appendToolAction(fixture.store, fixture.run.id, "write_app", "write", {
      path: "app.js",
      content: "console.log('case')",
    }, false);
    const verification = verifyWorkflowStepExecutionOperations({
      store: fixture.store,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
      now: "2026-08-12T12:00:09.500Z",
    });
    assert.equal(verification.status, "blocked");
    assert.equal(verification.operationResults[0].status, "missing");
  } finally {
    await fixture.close();
  }
});

test("workflow fails when required Node evidence exits non-zero or times out", async (t) => {
  for (const scenario of [
    { suffix: "nonzero", exitCode: 1, timedOut: false, reason: "required_command_non_zero_exit" },
    { suffix: "timeout", exitCode: undefined, timedOut: true, reason: "required_command_timed_out" },
  ]) {
    await t.test(scenario.suffix, async () => {
      const fixture = await createOperationFixture(scenario.suffix, [
        operation("run_command", "run_command", "command", "node app.js"),
      ], { onRunFailed: "fail_workflow", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true });
      try {
        appendBashAction(fixture.store, fixture.run.id, "node app.js", {
          exitCode: scenario.exitCode,
          timedOut: scenario.timedOut,
          cancelled: false,
        });
        fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T12:01:10.000Z");
        finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.step.id, fixture.task.id, fixture.store.getRun(fixture.run.id), "2026-08-12T12:01:11.000Z");
        const step = fixture.store.getChannelWorkflowStep(fixture.step.id);
        assert.equal(step.status, "failed");
        assert.equal(step.metadata.executionVerification.status, "failed");
        assert.equal(step.metadata.executionVerification.operationResults[0].reasonCode, scenario.reason);
        assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "failed");
      } finally {
        await fixture.close();
      }
    });
  }
});

test("workflow succeeds only after required file and Node operations have clean evidence", async () => {
  const fixture = await createOperationFixture("success", [
    operation("create_file", "file_create", "file", "app.js"),
    operation("run_command", "run_command", "command", "node app.js", ["create_file"]),
  ]);
  try {
    appendToolAction(fixture.store, fixture.run.id, "write_app", "write", { path: "app.js", content: "console.log('ok')" }, false);
    appendBashAction(fixture.store, fixture.run.id, "node app.js", { exitCode: 0, timedOut: false, cancelled: false });
    const preflight = verifyWorkflowStepExecutionOperations({ store: fixture.store, step: fixture.store.getChannelWorkflowStep(fixture.step.id), now: "2026-08-12T12:02:09.000Z" });
    assert.equal(preflight.status, "verified", JSON.stringify(preflight));
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T12:02:10.000Z");
    finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.step.id, fixture.task.id, fixture.store.getRun(fixture.run.id), "2026-08-12T12:02:11.000Z");
    const step = fixture.store.getChannelWorkflowStep(fixture.step.id);
    assert.equal(step.status, "succeeded", JSON.stringify(step.metadata.executionVerification));
    assert.equal(step.metadata.executionVerification.status, "verified");
    assert.deepEqual(step.metadata.executionVerification.operationResults.map((result) => result.status), ["succeeded", "succeeded"]);
    const completedWorkflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    assert.equal(completedWorkflow.status, "succeeded", JSON.stringify({
      workflow: completedWorkflow,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
    }));
  } finally {
    await fixture.close();
  }
});

test("workflow accepts terminal legacy Pi bash success without an explicit exit code", async () => {
  const fixture = await createOperationFixture("legacy-pi-success", [
    operation("run_command", "run_command", "command", "node app.js"),
  ]);
  try {
    appendLegacyPiBashAction(fixture.store, fixture.run.id, "node app.js", {
      isError: false,
      output: "CONTINUITY_V2_NODE_OK\n",
    });
    const verification = verifyWorkflowStepExecutionOperations({
      store: fixture.store,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
      now: "2026-08-12T12:03:09.000Z",
    });
    assert.equal(verification.status, "verified", JSON.stringify(verification));
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T12:03:10.000Z");
    finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.step.id, fixture.task.id, fixture.store.getRun(fixture.run.id), "2026-08-12T12:03:11.000Z");
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.step.id).status, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("workflow distinguishes legacy Pi failure from a numeric non-zero exit", async () => {
  const fixture = await createOperationFixture("legacy-pi-failure", [
    operation("run_command", "run_command", "command", "node app.js"),
  ]);
  try {
    appendLegacyPiBashAction(fixture.store, fixture.run.id, "node app.js", {
      isError: true,
      output: "failed\n",
    });
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T12:04:10.000Z");
    finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.step.id, fixture.task.id, fixture.store.getRun(fixture.run.id), "2026-08-12T12:04:11.000Z");
    const result = fixture.store.getChannelWorkflowStep(fixture.step.id).metadata.executionVerification.operationResults[0];
    assert.equal(result.reasonCode, "required_command_failed");
  } finally {
    await fixture.close();
  }
});

test("workflow fails closed when unified exec success omits exit code", async () => {
  const fixture = await createOperationFixture("unified-missing-exit", [
    operation("run_command", "run_command", "command", "node app.js"),
  ]);
  try {
    appendBashAction(fixture.store, fixture.run.id, "node app.js", {
      exitCode: undefined,
      timedOut: false,
      cancelled: false,
      status: "succeeded",
      isError: false,
    });
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T12:05:10.000Z");
    finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.step.id, fixture.task.id, fixture.store.getRun(fixture.run.id), "2026-08-12T12:05:11.000Z");
    const result = fixture.store.getChannelWorkflowStep(fixture.step.id).metadata.executionVerification.operationResults[0];
    assert.equal(result.reasonCode, "required_command_missing_exit_code");
  } finally {
    await fixture.close();
  }
});

test("proposal compiler partitions create-and-run operations between Engineer and QA", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-workflow-operation-compiler-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-12T13:00:00.000Z";
    const channel = store.createChannel({
      name: "Operation compiler",
      boundPath: cwd,
      allowedTools: ["read", "write", "bash"],
    }, now);
    store.updateWorkspaceSettings({ defaultProviderPresetId: "provider_workspace" }, now);
    store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
    store.replaceTeammateChannelMemberships("teammate_builtin_qa", [{ channelId: channel.id }], now);
    const source = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "local-user",
      body: "Engineer creates app.js and QA runs node app.js",
    }, now);
    const proposal = store.createChannelExecutionProposal({
      channelId: channel.id,
      sourceMessageId: source.id,
      proposedByTeammateId: "ling_agent",
      title: "Create and run app.js",
      prompt: "Engineer creates app.js and QA runs node app.js",
      assigneeTeammateId: "teammate_builtin_engineer",
      collaborationSteps: [
        { teammateId: "teammate_builtin_engineer", action: "coordinated", summary: "Create app.js" },
        { teammateId: "teammate_builtin_qa", action: "reviewed", summary: "Run node app.js" },
      ],
      requiredTools: ["write", "bash"],
      status: "draft",
    }, now);
    const sourceItem = store.getConversationItem(source.id);
    assert.ok(sourceItem?.turnId);
    const assignment = store.getEffectiveTurnContextAssignment(sourceItem.turnId);
    assert.ok(assignment);
    const executionPlan = {
      operations: [
        operation("run_command", "run_command", "command", "node app.js", ["create_file"]),
        operation("create_file", "file_create", "file", "app.js"),
      ],
    };
    store.createChannelIntentDecision({
      channelId: channel.id,
      sourceItemId: source.id,
      contextProjection: projectionFor(sourceItem, assignment),
      action: "execute",
      selectedTeammateIds: ["teammate_builtin_engineer", "teammate_builtin_qa"],
      participantManifest: createRequiredParticipantManifestV1([{
        participantId: "teammate_builtin_engineer",
        role: "engineer",
        requirement: "required",
        expectedOutcome: "execution",
        requiredOperationIds: ["create_file"],
        requestedBy: "explicit_role",
      }, {
        participantId: "teammate_builtin_qa",
        role: "qa",
        requirement: "required",
        expectedOutcome: "verification",
        requiredOperationIds: ["run_command"],
        requestedBy: "explicit_role",
      }]),
      proposalId: proposal.id,
      execution: executionPlan,
      reason: "Typed create-and-run plan.",
      status: "accepted",
      createdBy: "deterministic",
    }, now);

    const confirmed = confirmChannelExecutionProposalWorkflow({
      store,
      cwd,
      proposalId: proposal.id,
      validateRunRequest: () => undefined,
      now,
    });

    assert.equal(confirmed.workflow.metadata.sourceTurnId, sourceItem.turnId);
    assert.equal(store.getLingTurn(sourceItem.turnId).status, "running");
    assert.equal(confirmed.workflowSteps.length, 2);
    const [engineerStep, qaStep] = confirmed.workflowSteps;
    assert.equal(engineerStep.toParticipantId, "teammate_builtin_engineer");
    assert.equal(engineerStep.metadata.providerBinding.providerPresetId, "provider_workspace");
    assert.equal(engineerStep.metadata.providerBinding.source, "workspace_default");
    assert.deepEqual(engineerStep.metadata.executionOperationIds, ["create_file"]);
    assert.deepEqual(engineerStep.metadata.requiredTools, ["write"]);
    assert.equal(qaStep.toParticipantId, "teammate_builtin_qa");
    assert.equal(qaStep.metadata.providerBinding.providerPresetId, "provider_workspace");
    assert.equal(qaStep.metadata.providerBinding.source, "workspace_default");
    assert.deepEqual(qaStep.metadata.executionOperationIds, ["run_command"]);
    assert.deepEqual(qaStep.metadata.requiredTools, ["bash"]);
    assert.deepEqual(qaStep.metadata.dependsOnStepIds, [engineerStep.id]);
    assert.equal(engineerStep.metadata.delegatedRequirement.participantId, "teammate_builtin_engineer");
    assert.deepEqual(engineerStep.metadata.delegatedRequirement.requiredOperationIds, ["create_file"]);
    assert.deepEqual(qaStep.metadata.delegatedRequirement.requiredOperationIds, ["run_command"]);
    assert.deepEqual(qaStep.metadata.delegatedRequirement.requiredDependencyStepIds, [engineerStep.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("multi-agent completion requires both Engineer write and QA command evidence", async (t) => {
  await t.test("both operation subsets verified", async () => {
    const fixture = await createMultiAgentOperationFixture("verified");
    try {
      appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "console.log('ok')" }, false);
      fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T14:00:10.000Z");
      finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.engineerStep.id, fixture.engineerTask.id, fixture.store.getRun(fixture.engineerRun.id), "2026-08-12T14:00:11.000Z");
      assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "succeeded");
      fixture.startQa("2026-08-12T14:00:12.000Z");
      appendBashAction(fixture.store, fixture.qaRun.id, "node app.js", { exitCode: 0, timedOut: false, cancelled: false });
      fixture.store.markRunSucceeded(fixture.qaRun.id, "2026-08-12T14:00:20.000Z");
      finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.qaStep.id, fixture.qaTask.id, fixture.store.getRun(fixture.qaRun.id), "2026-08-12T14:00:21.000Z");
      assert.equal(fixture.store.getChannelWorkflowStep(fixture.qaStep.id).metadata.executionVerification.status, "verified");
      assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "succeeded");
    } finally {
      await fixture.close();
    }
  });

  await t.test("missing QA command evidence blocks fan-in completion", async () => {
    const fixture = await createMultiAgentOperationFixture("missing-qa");
    try {
      appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "console.log('ok')" }, false);
      fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T14:01:10.000Z");
      finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.engineerStep.id, fixture.engineerTask.id, fixture.store.getRun(fixture.engineerRun.id), "2026-08-12T14:01:11.000Z");
      fixture.startQa("2026-08-12T14:01:12.000Z");
      fixture.store.markRunSucceeded(fixture.qaRun.id, "2026-08-12T14:01:20.000Z");
      finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.qaStep.id, fixture.qaTask.id, fixture.store.getRun(fixture.qaRun.id), "2026-08-12T14:01:21.000Z");
      assert.equal(fixture.store.getChannelWorkflowStep(fixture.qaStep.id).status, "blocked");
      assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "blocked");
    } finally {
      await fixture.close();
    }
  });
});

test("step finalization rejects evidence that is not owned by the current Run", async (t) => {
  await t.test("same-channel foreign execution action", async () => {
    const fixture = await createMultiAgentOperationFixture("foreign-action-evidence");
    try {
      appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "ok" }, false);
      // A genuinely different Run owns this action; an unmet QA dependency is not started.
      const foreignTask = fixture.store.createTask({ channelId: fixture.workflow.channelId, title: "Foreign action", prompt: "Foreign action",
        assigneeTeammateId: fixture.engineerStep.toParticipantId }, "2026-08-12T14:00:01.000Z");
      const foreignRun = createFixtureRun(fixture.store, fixture.cwd, fixture.workflow.channelId, fixture.engineerStep.id,
        foreignTask, "run_foreign_action_evidence", "2026-08-12T14:00:01.000Z");
      appendToolAction(fixture.store, foreignRun.id, "foreign_action", "write", { path: "foreign.js", content: "foreign" }, false);
      fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T14:00:10.000Z");
      const originalCommit = fixture.store.commitChannelWorkflowStepFinalization.bind(fixture.store);
      let observed;
      fixture.store.commitChannelWorkflowStepFinalization = (input) => {
        const outcome = {
          ...input.delegatedOutcome,
          lineage: {
            ...input.delegatedOutcome.lineage,
            sourceRefs: input.delegatedOutcome.lineage.sourceRefs.map((ref) => ref.type === "execution_action"
              ? { ...ref, id: `tool:${foreignRun.id}:foreign_action` }
              : ref),
          },
          evidenceRefs: [{ kind: "execution_action", id: `tool:${foreignRun.id}:foreign_action` }],
        };
        const basisFingerprint = delegatedStepFinalizationBasisFingerprintV1({
          workflowId: fixture.workflow.id,
          workflowStepId: fixture.engineerStep.id,
          stepUpdatedAt: input.expectedUpdatedAt,
          runId: input.expectedRun.id,
          runStatus: input.expectedRun.status,
          runUpdatedAt: input.expectedRun.updatedAt,
          runEventCount: input.expectedRun.eventWatermark.count,
          runLatestSeq: input.expectedRun.eventWatermark.latestSeq,
          requirementFingerprint: fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).metadata.delegatedRequirement.fingerprint,
          approval: input.expectedApproval,
          artifactIds: input.expectedRun.artifactIds,
          outcome,
          verification: input.executionVerification,
        });
        observed = originalCommit({ ...input, delegatedOutcome: outcome, delegatedOutcomeBasisFingerprint: basisFingerprint });
        return observed;
      };
      const result = finalizeDelegatedWorkflowStepFromCanonicalState({
        store: fixture.store,
        workflowStepId: fixture.engineerStep.id,
        cause: "run_terminal",
        now: "2026-08-12T14:00:11.000Z",
      });
      assert.equal(result.status, "stale");
      assert.deepEqual(observed, { ok: false, code: "invalid_transition", currentStatus: "running" });
      assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "running");
    } finally {
      await fixture.close();
    }
  });

  await t.test("foreign artifact", async () => {
    const fixture = await createSynthesisFinalizationFixture("foreign-artifact-evidence");
    try {
      const foreignRun = createFixtureRun(
        fixture.store,
        fixture.cwd,
        fixture.workflow.channelId,
        fixture.step.id,
        fixture.task,
        "run_synthesis_foreign_artifact",
        "2026-08-12T14:25:00.000Z",
      );
      const foreignArtifact = fixture.store.createArtifact({
        runId: foreignRun.id,
        type: "json",
        path: "foreign-output.json",
        sealedPayload: { schemaVersion: 1, kind: "foreign" },
        createdAt: "2026-08-12T14:25:01.000Z",
      });
      fixture.store.appendEvent(fixture.run.id, "assistant_text_delta", { text: "Sourced synthesis." });
      fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T14:25:10.000Z");
      const originalCommit = fixture.store.commitChannelWorkflowStepFinalization.bind(fixture.store);
      let observed;
      fixture.store.commitChannelWorkflowStepFinalization = (input) => {
        const outcome = {
          ...input.delegatedOutcome,
          lineage: {
            ...input.delegatedOutcome.lineage,
            sourceRefs: input.delegatedOutcome.lineage.sourceRefs.map((ref) => ref.type === "artifact"
              ? { ...ref, id: foreignArtifact.id }
              : ref),
          },
          evidenceRefs: [{ kind: "workflow_output_packet", id: foreignArtifact.id }],
        };
        const basisFingerprint = delegatedStepFinalizationBasisFingerprintV1({
          workflowId: fixture.workflow.id,
          workflowStepId: fixture.step.id,
          stepUpdatedAt: input.expectedUpdatedAt,
          runId: input.expectedRun.id,
          runStatus: input.expectedRun.status,
          runUpdatedAt: input.expectedRun.updatedAt,
          runEventCount: input.expectedRun.eventWatermark.count,
          runLatestSeq: input.expectedRun.eventWatermark.latestSeq,
          requirementFingerprint: fixture.store.getChannelWorkflowStep(fixture.step.id).metadata.delegatedRequirement.fingerprint,
          approval: input.expectedApproval,
          artifactIds: input.expectedRun.artifactIds,
          outcome,
          verification: input.executionVerification,
        });
        observed = originalCommit({ ...input, delegatedOutcome: outcome, delegatedOutcomeBasisFingerprint: basisFingerprint });
        return observed;
      };
      const result = finalizeDelegatedWorkflowStepFromCanonicalState({
        store: fixture.store,
        workflowStepId: fixture.step.id,
        cause: "run_terminal",
        now: "2026-08-12T14:25:11.000Z",
      });
      assert.equal(result.status, "stale");
      assert.deepEqual(observed, { ok: false, code: "invalid_transition", currentStatus: "running" });
      assert.equal(fixture.store.getChannelWorkflowStep(fixture.step.id).status, "running");
    } finally {
      await fixture.close();
    }
  });
});

test("downstream command evidence cannot bypass missing dependency evidence", async () => {
  const fixture = await createMultiAgentOperationFixture("missing-dependency-evidence");
  try {
    const now = "2026-08-12T14:05:00.000Z";
    const beforeStep = fixture.store.getChannelWorkflowStep(fixture.qaStep.id);
    const beforeTasks = fixture.store.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
    const beforeRuns = fixture.store.database.prepare("SELECT COUNT(*) AS count FROM run_sessions").get().count;
    const lease = fixture.store.acquireResourceLease({ workspaceId: fixture.workflow.workspaceId, resourceType: "workflow_step",
      resourceKey: beforeStep.id, ownerType: "workflow_step", ownerId: beforeStep.id, acquiredAt: now,
      expiresAt: "2026-08-12T15:05:00.000Z" });
    assert.ok(lease);
    assert.deepEqual(fixture.store.beginChannelWorkflowStepStart({ workflowStepId: beforeStep.id, expected: beforeStep,
      leaseId: lease.id, task: { channelId: beforeStep.channelId, title: "Premature QA", prompt: "Run node app.js",
        assigneeTeammateId: beforeStep.toParticipantId }, now }), { status: "invalid", code: "workflow_start_not_permitted" });
    assert.deepEqual(fixture.store.getChannelWorkflowStep(beforeStep.id), beforeStep);
    assert.equal(fixture.store.getChannelWorkflowStep(beforeStep.id).taskId, undefined);
    assert.equal(fixture.store.getChannelWorkflowStep(beforeStep.id).runId, undefined);
    assert.equal(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, beforeTasks);
    assert.equal(fixture.store.database.prepare("SELECT COUNT(*) AS count FROM run_sessions").get().count, beforeRuns);
    // Deliberately unowned evidence remains insufficient even if a caller presents it.
    // This is a bypass attempt, not a legally begun QA execution.
    const rogueTask = fixture.store.createTask({ channelId: beforeStep.channelId, title: "Unowned QA evidence", prompt: "node app.js",
      assigneeTeammateId: beforeStep.toParticipantId }, now);
    const rogueRun = createFixtureRun(fixture.store, fixture.cwd, beforeStep.channelId, beforeStep.id,
      rogueTask, "run_unowned_downstream_evidence", now);
    appendBashAction(fixture.store, rogueRun.id, "node app.js", {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    const verification = verifyWorkflowStepExecutionOperations({
      store: fixture.store,
      step: { ...beforeStep, runId: rogueRun.id },
      now,
    });
    assert.equal(verification.status, "blocked");
    assert.equal(
      verification.operationResults[0].reasonCode,
      "required_operation_dependency_missing_evidence",
    );
  } finally {
    await fixture.close();
  }
});

test("approval restart resume feeds QA evidence through the shared multi-agent completion gate", async () => {
  const fixture = await createMultiAgentOperationFixture("approval-resume");
  try {
    await writeFile(resolve(fixture.store.paths.cwd, "app.js"), "console.log('ok')\n", "utf8");
    appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "console.log('ok')" }, false);
    fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-15T02:00:10.000Z");
    finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.engineerStep.id,
      fixture.engineerTask.id,
      fixture.store.getRun(fixture.engineerRun.id),
      "2026-08-15T02:00:11.000Z",
    );
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "succeeded");
    assert.notEqual(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "succeeded");

    const now = "2026-08-15T02:01:00.000Z";
    fixture.startQa(now);
    const workUnit = fixture.store.getWorkUnit(fixture.qaRun.workUnitId);
    const attempt = fixture.store.getWorkUnitAttempt(workUnit.activeAttemptId);
    assert.ok(attempt);
    fixture.store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now,
    });
    fixture.store.updateWorkUnitAttemptStatus({ attemptId: attempt.id, status: "waiting_for_approval", now });
    fixture.store.transitionRunStatus({
      runId: fixture.qaRun.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now,
    });
    const approval = fixture.store.createApprovalRequest({
      runId: fixture.qaRun.id,
      taskId: fixture.qaTask.id,
      channelId: fixture.qaRun.channelId,
      toolCallId: "qa_node_after_restart",
      actionType: "bash",
      risk: "medium",
      title: "Approve QA Node verification",
      description: "node app.js",
      payload: { type: "bash", cwd: fixture.store.paths.cwd, command: "node app.js", riskFlags: [] },
    }, now);
    const checkpoint = fixture.store.getApprovalCheckpointForApproval(approval.id);
    const requirement = fixture.store.getChannelWorkflowStep(fixture.qaStep.id).metadata.delegatedRequirement;
    assert.ok(checkpoint);
    assert.ok(requirement);
    const resumeBasis = createApprovalResumeBasisV1({
      approvalId: approval.id,
      runId: fixture.qaRun.id,
      workUnitId: workUnit.id,
      priorAttemptId: attempt.id,
      workflowStepId: fixture.qaStep.id,
      toolCallId: approval.toolCallId,
      actionType: approval.actionType,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect: approval.payload,
      }),
      delegatedRequirementFingerprint: requirement.fingerprint,
    });
    fixture.store.updateApprovalCheckpointStatus(checkpoint.id, {
      status: "pending",
      expectedStatus: "pending",
      expectedRevision: checkpoint.revision,
      resumeBasis,
    }, now);
    const approved = fixture.store.approveApprovalRequest(approval.id, { reason: "resume QA" }, "2026-08-15T02:01:10.000Z");
    assert.equal(approved.status, "approved");

    const createCoordinator = (activeRuns) => new ApprovalResumeCoordinator({
      activeRuns,
      runnerRegistry: {
        get() {
          return {
            id: "pi",
            displayName: "Pi",
            status: "enabled",
            adapter: { async runTask() { return { taskId: "unused", events: [], messages: [] }; } },
            resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] },
          };
        },
        list() { return []; },
        resolve() { throw new Error("unused"); },
      },
runtimeSupervisor: {
        getRestrictedCommandRuntime() { return undefined; },
        getRuntime() {
          return { runtimeInstanceId: "runtime_after_restart" };
        },
      },
    });
    const activeRuns = new ActiveRunRegistry();
    const coordinator = createCoordinator(activeRuns);
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: approved });
    assert.equal(started.status, "started");
    activeRuns.suspendAll("daemon_restart");
    await activeRuns.waitForIdle();

    assert.equal(fixture.store.getChannelWorkflowStep(fixture.qaStep.id).status, "running");
    assert.notEqual(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "succeeded");
    assert.equal(fixture.store.getApprovalCheckpoint(checkpoint.id).status, "resume_pending");

    createCoordinator(new ActiveRunRegistry()).registerStore(fixture.store);

    await waitForCondition(() => fixture.store.getChannelWorkflow(fixture.workflow.id).status === "succeeded", "workflow completion after approval resume");
    const qaStep = fixture.store.getChannelWorkflowStep(fixture.qaStep.id);
    const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    assert.equal(qaStep.status, "succeeded");
    assert.equal(qaStep.metadata.executionVerification.status, "verified");
    assert.equal(qaStep.metadata.delegatedOutcome.kind, "completed");
    const replacementAttemptId = fixture.store.getWorkUnit(workUnit.id).activeAttemptId;
    assert.ok(replacementAttemptId);
    assert.notEqual(replacementAttemptId, attempt.id);
    assert.equal(qaStep.metadata.delegatedOutcome.lineage.attemptId, replacementAttemptId);
    const resumedApprovalAction = listExecutionActions(fixture.store, { runId: fixture.qaRun.id, complete: true })
      .find((action) => action.id === `approval:${approval.id}`);
    assert.equal(resumedApprovalAction?.attemptId, replacementAttemptId);
    assert.equal(workflow.metadata.completionGate.status, "verified");
    assert.deepEqual(
      workflow.metadata.completionGate.participantResults.map((participant) => [participant.participantId, participant.status]),
      [["teammate_builtin_engineer", "satisfied"], ["teammate_builtin_qa", "satisfied"]],
    );
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ workUnitId: workUnit.id, status: "active" }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("approval resume rejects a command that no longer matches the workflow binding", async () => {
  const fixture = await createMultiAgentOperationFixture("approval-resume-binding-mismatch");
  try {
    appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "ok" }, false);
    fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-15T02:09:58.000Z");
    finalizeOrchestratedWorkflowStepRun(fixture.store, fixture.engineerStep.id, fixture.engineerTask.id,
      fixture.store.getRun(fixture.engineerRun.id), "2026-08-15T02:09:59.000Z");
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "succeeded");
    const now = "2026-08-15T02:10:00.000Z";
    fixture.startQa(now);
    const workUnit = fixture.store.getWorkUnit(fixture.qaRun.workUnitId);
    const attempt = fixture.store.getWorkUnitAttempt(workUnit.activeAttemptId);
    assert.ok(attempt);
    fixture.store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now,
    });
    fixture.store.updateWorkUnitAttemptStatus({ attemptId: attempt.id, status: "waiting_for_approval", now });
    fixture.store.transitionRunStatus({
      runId: fixture.qaRun.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now,
    });
    const approval = fixture.store.createApprovalRequest({
      runId: fixture.qaRun.id,
      taskId: fixture.qaTask.id,
      channelId: fixture.qaRun.channelId,
      toolCallId: "qa_mismatched_resume_command",
      actionType: "bash",
      risk: "medium",
      title: "Approve QA Node verification",
      description: "node -e semantic substitute",
      payload: {
        type: "bash",
        cwd: fixture.store.paths.cwd,
        command: "node -e \"console.log('semantic substitute')\"",
        riskFlags: [],
      },
    }, now);
    const checkpoint = fixture.store.getApprovalCheckpointForApproval(approval.id);
    assert.ok(checkpoint);
    const requirement = fixture.store.getChannelWorkflowStep(fixture.qaStep.id).metadata.delegatedRequirement;
    assert.ok(requirement);
    const resumeBasis = createApprovalResumeBasisV1({
      approvalId: approval.id,
      runId: fixture.qaRun.id,
      workUnitId: workUnit.id,
      priorAttemptId: attempt.id,
      workflowStepId: fixture.qaStep.id,
      toolCallId: approval.toolCallId,
      actionType: approval.actionType,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect: approval.payload,
      }),
      delegatedRequirementFingerprint: requirement.fingerprint,
    });
    fixture.store.updateApprovalCheckpointStatus(checkpoint.id, {
      status: "pending",
      expectedStatus: "pending",
      expectedRevision: checkpoint.revision,
      resumeBasis,
    }, now);
    const approved = fixture.store.approveApprovalRequest(approval.id, { reason: "resume mismatched QA" }, "2026-08-15T02:10:10.000Z");

    const activeRuns = new ActiveRunRegistry();
    const coordinator = new ApprovalResumeCoordinator({
      activeRuns,
      runnerRegistry: {
        get() {
          return {
            id: "pi",
            displayName: "Pi",
            status: "enabled",
            adapter: { async runTask() { return { taskId: "unused", events: [], messages: [] }; } },
            resumeCapabilities: { nativeResume: false, hostApprovalContinuation: ["bash"] },
          };
        },
        list() { return []; },
        resolve() { throw new Error("unused"); },
      },
runtimeSupervisor: {
        getRestrictedCommandRuntime() { return undefined; },
        getRuntime() {
          return { runtimeInstanceId: "runtime_after_restart" };
        },
      },
    });
    const started = coordinator.resumeAfterApproval({ store: fixture.store, approval: approved });
    assert.equal(started.status, "started");
    await activeRuns.waitForIdle();

    const run = fixture.store.getRun(fixture.qaRun.id);
    const step = fixture.store.getChannelWorkflowStep(fixture.qaStep.id);
    const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    assert.equal(run.status, "failed");
    assert.equal(step.status, "blocked");
    assert.equal(step.metadata.delegatedOutcome.kind, "blocked");
    assert.equal(step.metadata.delegatedOutcome.code, "approval_resume_tool_mismatch");
    assert.equal(workflow.status, "blocked");
    assert.equal(fixture.store.getApprovalCheckpoint(checkpoint.id).status, "resume_failed");
    assert.equal(fixture.store.listEvents(fixture.qaRun.id, { limit: 500 }).some((event) => event.type === "tool_start"), false);
  } finally {
    await fixture.close();
  }
});

test("generic delegated workflow with no declared operations validates successful Run actions", async () => {
  const fixture = await createGenericDelegatedActionFixture("generic-action");
  try {
    appendToolAction(fixture.store, fixture.run.id, "read_package", "read", { path: "package.json" }, false);
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T14:05:10.000Z");
    finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.step.id,
      fixture.task.id,
      fixture.store.getRun(fixture.run.id),
      "2026-08-12T14:05:11.000Z",
    );
    const step = fixture.store.getChannelWorkflowStep(fixture.step.id);
    assert.equal(step.status, "succeeded");
    assert.deepEqual(step.metadata.delegatedOutcome.evidenceRefs, [{
      kind: "execution_action",
      id: `tool:${fixture.run.id}:read_package`,
    }]);
    const completedWorkflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    assert.equal(completedWorkflow.status, "succeeded", JSON.stringify({
      workflow: completedWorkflow,
      step: fixture.store.getChannelWorkflowStep(fixture.step.id),
    }));
  } finally {
    await fixture.close();
  }
});

test("ready-only delegated text cannot be treated as successful execution", async () => {
  const fixture = await createGenericDelegatedActionFixture("ready-only");
  try {
    fixture.store.appendEvent(fixture.run.id, "assistant_text_delta", { text: "ready" });
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T14:06:10.000Z");
    finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.step.id,
      fixture.step.taskId ?? fixture.run.taskId,
      fixture.store.getRun(fixture.run.id),
      "2026-08-12T14:06:11.000Z",
    );
    const step = fixture.store.getChannelWorkflowStep(fixture.step.id);
    const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    const outcome = step.metadata.delegatedOutcome;
    assert.equal(step.status, "blocked");
    assert.equal(workflow.status, "blocked");
    assert.equal(outcome.kind, "blocked");
    assert.equal(outcome.code, "delegated_outcome_missing");
    assert.deepEqual(outcome.evidenceRefs, []);
    assert.equal(outcome.lineage.runId, fixture.run.id);
    assert.equal(outcome.lineage.attemptId, `attempt_run_generic_action_ready-only`);
    assert.deepEqual(outcome.lineage.sourceRefs, [
      { type: "workflow", id: fixture.workflow.id },
      { type: "workflow_step", id: fixture.step.id },
      { type: "run", id: fixture.run.id },
      { type: "attempt", id: "attempt_run_generic_action_ready-only" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("approval resume unsupported is a structured delegated blocker, not workflow success or cancellation", async () => {
  const fixture = await createGenericDelegatedActionFixture("approval-resume-unsupported");
  try {
    fixture.store.markRunFailed(
      fixture.run.id,
      "2026-08-15T03:00:00.000Z",
      "approval_resume_unsupported:file_write",
    );
    finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.step.id,
      fixture.step.taskId ?? fixture.run.taskId,
      fixture.store.getRun(fixture.run.id),
      "2026-08-15T03:00:01.000Z",
    );
    const step = fixture.store.getChannelWorkflowStep(fixture.step.id);
    const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    assert.equal(step.status, "blocked");
    assert.equal(step.metadata.delegatedOutcome.kind, "blocked");
    assert.equal(step.metadata.delegatedOutcome.code, "approval_resume_unsupported");
    assert.equal(workflow.status, "blocked");
  } finally {
    await fixture.close();
  }
});

test("execution loop blocks the delegated participant, fan-in, and unchanged retry", async () => {
  const fixture = await createMultiAgentOperationFixture("execution-loop-blocker");
  try {
    fixture.store.appendEvent(fixture.engineerRun.id, "loop_detected", {
      code: "execution_loop_detected",
      attemptId: `attempt_${fixture.engineerRun.id}`,
      loopKind: "cycle",
      observedEventType: "tool_end",
      observedEventSeq: 6,
      repeatedCount: 3,
      noProgressActionCount: 6,
      cycleLength: 2,
      fingerprint: "b".repeat(64),
      message: "Execution stopped after a 2-action cycle repeated 3 times.",
      retryable: false,
    });
    fixture.store.markRunFailed(
      fixture.engineerRun.id,
      "2026-08-15T03:10:00.000Z",
      "execution_loop_detected",
    );

    finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.engineerStep.id,
      fixture.engineerTask.id,
      fixture.store.getRun(fixture.engineerRun.id),
      "2026-08-15T03:10:01.000Z",
    );

    const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    const steps = fixture.store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
    const engineerStep = steps.find((step) => step.id === fixture.engineerStep.id);
    assert.equal(engineerStep.status, "blocked");
    assert.equal(engineerStep.metadata.delegatedOutcome.kind, "blocked");
    assert.equal(engineerStep.metadata.delegatedOutcome.code, "execution_loop_detected");
    assert.deepEqual(engineerStep.metadata.delegatedOutcome.missingRequirements, ["manual_intervention"]);
    assert.equal(workflow.status, "blocked");

    const gate = evaluateWorkflowCompletionGate({
      store: fixture.store,
      workflow,
      steps,
      now: "2026-08-15T03:10:02.000Z",
    });
    assert.equal(gate.status, "blocked");
    assert.equal(
      gate.participantResults.find((result) => result.participantId === engineerStep.toParticipantId)?.status,
      "blocked",
    );

    let startRunCalled = false;
    await assert.rejects(
      retryChannelWorkflowStep({
        store: fixture.store,
        cwd: fixture.engineerRun.cwd,
        workflowStepId: engineerStep.id,
        validateRunRequest: () => undefined,
        startRun: async () => {
          startRunCalled = true;
          return "unexpected-retry-run";
        },
      }),
      (error) => error?.statusCode === 409 && error?.code === "workflow_step_loop_failure_not_retryable",
    );
    assert.equal(startRunCalled, false);
  } finally {
    await fixture.close();
  }
});

test("completion gate blocks a graph branch whose step row is absent", async () => {
  const fixture = await createMultiAgentOperationFixture("missing-graph-step");
  try {
    const steps = [fixture.store.getChannelWorkflowStep(fixture.engineerStep.id)];
    const gate = evaluateWorkflowCompletionGate({
      store: fixture.store,
      workflow: fixture.store.getChannelWorkflow(fixture.workflow.id),
      steps,
      now: "2026-08-12T14:10:00.000Z",
    });
    assert.equal(gate.status, "blocked");
    assert.equal(gate.participantResults.find((result) => result.participantId === "teammate_builtin_qa").reasonCode, "required_participant_missing");
  } finally {
    await fixture.close();
  }
});

test("completion gate blocks duplicate graph-node step materialization", async () => {
  const fixture = await createMultiAgentOperationFixture("duplicate-graph-step");
  try {
    const engineer = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    const qa = fixture.store.getChannelWorkflowStep(fixture.qaStep.id);
    const gate = evaluateWorkflowCompletionGate({
      store: fixture.store,
      workflow: fixture.store.getChannelWorkflow(fixture.workflow.id),
      steps: [engineer, qa, engineer],
      now: "2026-08-12T14:15:00.000Z",
    });
    assert.equal(gate.status, "blocked");
  } finally {
    await fixture.close();
  }
});

test("synthesis participant completes with a bound output packet but not naked text", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-workflow-synthesis-packet-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-12T14:20:00.000Z";
    const channel = store.createChannel({ name: "Synthesis packet", boundPath: cwd }, now);
    const providerBinding = fixtureParticipantBinding(store, channel, cwd, "teammate_builtin_architect", [], now);
    const participantManifest = createRequiredParticipantManifestV1([{
      participantId: "teammate_builtin_architect",
      role: "architect",
      requirement: "required",
      expectedOutcome: "synthesis",
      requiredOperationIds: [],
      requestedBy: "explicit_role",
    }]);
    const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Synthesize results" }, now);
    const sourceItem = store.getConversationItem(source.id);
    const decision = store.createChannelIntentDecision({
      channelId: channel.id,
      sourceItemId: source.id,
      contextProjection: projectionFor(sourceItem, store.getEffectiveTurnContextAssignment(sourceItem.turnId)),
      action: "workflow_proposal",
      selectedTeammateIds: ["teammate_builtin_architect"],
      participantManifest,
      reason: "Synthesize results",
      status: "accepted",
      createdBy: "deterministic",
    }, now);
    const graph = {
      schemaVersion: 1,
      id: "graph_synthesis_packet",
      name: "Synthesis",
      entryNodeId: "synthesis",
      nodes: [{ id: "synthesis", kind: "step", name: "Synthesis", prompt: "Synthesize", teammateId: "teammate_builtin_architect",
        providerPresetId: providerBinding.providerPresetId, providerBinding }],
      edges: [],
      termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
    };
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Synthesis",
      objective: "Synthesize results",
      status: "running",
      createdBy: "ling_agent",
      metadata: {
        sourceIntentDecisionId: decision.id,
        requiredParticipantManifest: participantManifest,
        workflowGraph: graph,
        workflowGraphId: graph.id,
        workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
        termination: graph.termination,
      },
    }, now);
    let step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Synthesis",
      prompt: "Synthesize",
      toParticipantId: "teammate_builtin_architect",
      toParticipantLabel: "Architect",
      status: "queued",
      metadata: { graphId: graph.id, graphNodeId: "synthesis", providerPresetId: providerBinding.providerPresetId, providerBinding },
    }, now);
    [step] = materializeWorkflowDelegatedStepRequirements({ store, workflow, manifest: participantManifest, now });
    const started = startFixtureStep(store, cwd, step.id, "run_synthesis_packet", now);
    store.markRunSucceeded(started.run.id, now);
    const run = store.getRun(started.run.id);
    assert.equal(store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id, expectedStatus: "running",
      event: "succeed", actor: "system", now }).ok, false);
    // Deliberately malformed terminal input verifies that the completion gate is
    // still defensive even if a caller bypasses the guarded transition API.
    step = store.updateChannelWorkflowStep(step.id, { status: "succeeded", resultSummary: "Sourced synthesis." }, now);
    let gate = evaluateWorkflowCompletionGate({ store, workflow, steps: [step], now });
    assert.equal(gate.status, "blocked");
    assert.equal(gate.participantResults[0].reasonCode, "required_participant_outcome_missing");
    const artifact = createWorkflowStepOutputArtifact({ store, workflow, step, run, now });
    step = store.updateChannelWorkflowStep(step.id, {
      metadata: {
        ...step.metadata,
        outputArtifactId: artifact.id,
        delegatedOutcomeBasisFingerprint: "dsbv1_test_synthesis_packet",
      delegatedOutcome: {
        kind: "completed",
        workflowId: workflow.id,
        workflowStepId: step.id,
        participantId: "teammate_builtin_architect",
        lineage: {
          workflowId: workflow.id,
          workflowStepId: step.id,
          participantId: "teammate_builtin_architect",
          runId: run.id,
          attemptId: "attempt_run_synthesis_packet",
          sourceRefs: [
            { type: "workflow", id: workflow.id },
            { type: "workflow_step", id: step.id },
            { type: "run", id: run.id },
            { type: "attempt", id: "attempt_run_synthesis_packet" },
            { type: "artifact", id: artifact.id },
          ],
        },
        evidenceRefs: [{ kind: "workflow_output_packet", id: artifact.id }],
      },
      },
    }, now);
    gate = evaluateWorkflowCompletionGate({ store, workflow, steps: [step], now });
    assert.equal(gate.status, "verified", JSON.stringify(gate));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("startup synthesis finalization prepares one deterministic output packet and reuses it", async () => {
  const fixture = await createSynthesisFinalizationFixture("restart-packet");
  try {
    fixture.store.appendEvent(fixture.run.id, "assistant_text_delta", { text: "Evidence-backed synthesis." });
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-12T14:25:10.000Z");
    const first = reconcileWorkflowFromCanonicalState({
      store: fixture.store,
      workflowId: fixture.workflow.id,
      cause: "startup",
      now: "2026-08-12T14:25:11.000Z",
    });
    assert.deepEqual(first.finalizedStepIds, [fixture.step.id]);
    assert.equal(first.workflow.status, "succeeded", JSON.stringify(first.workflow.metadata?.completionGate));
    const finalized = fixture.store.getChannelWorkflowStep(fixture.step.id);
    assert.equal(finalized.status, "succeeded");
    assert.equal(finalized.metadata.delegatedOutcome.kind, "completed");
    const packetRef = finalized.metadata.delegatedOutcome.evidenceRefs.find((ref) => ref.kind === "workflow_output_packet");
    assert.ok(packetRef);
    assert.equal(finalized.metadata.outputArtifactId, packetRef.id);
    const firstArtifacts = fixture.store.listArtifacts(fixture.run.id)
      .filter((artifact) => artifact.id === packetRef.id);
    assert.equal(firstArtifacts.length, 1);
    const decision = fixture.store.getChannelIntentDecision(fixture.workflow.metadata.sourceIntentDecisionId);
    const sourceItem = fixture.store.getConversationItem(decision.sourceItemId);
    assert.ok(sourceItem?.turnId);
    assert.notEqual(fixture.store.getLingTurn(sourceItem.turnId).status, "succeeded");
    configureTerminalReportStore(fixture.store, { enabled: true });
    const firstReport = await processWorkflowTerminalReport(fixture.store, fixture.workflow.id, {
      now: "2026-08-12T14:25:11.500Z",
    });
    assert.ok(firstReport.record.resultItemId);
    assert.equal(fixture.store.getLingTurn(sourceItem.turnId).status, "succeeded");

    const duplicate = reconcileWorkflowFromCanonicalState({
      store: fixture.store,
      workflowId: fixture.workflow.id,
      cause: "duplicate_callback",
      now: "2026-08-12T14:25:12.000Z",
    });
    assert.deepEqual(duplicate.finalizedStepIds, []);
    assert.equal(fixture.store.listArtifacts(fixture.run.id)
      .filter((artifact) => artifact.id === packetRef.id).length, 1);
    const duplicateReport = await processWorkflowTerminalReport(fixture.store, fixture.workflow.id, {
      now: "2026-08-12T14:25:12.500Z",
    });
    assert.equal(duplicateReport.record.id, firstReport.record.id);
    assert.equal(duplicateReport.record.resultItemId, firstReport.record.resultItemId);
    assert.equal(fixture.store.listConversationItemsForTurn({ turnId: sourceItem.turnId })
      .filter((item) => item.id === firstReport.record.resultItemId).length, 1);
    assert.equal(fixture.store.listStateTransitionEvents({ entityType: "turn", entityId: sourceItem.turnId })
      .filter((event) => event.toStatus === "succeeded").length, 1);
  } finally {
    await fixture.close();
  }
});

test("approval wait and resume update the workflow source turn immediately", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-workflow-source-turn-approval-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-12T15:00:00.000Z";
    const channel = store.createChannel({ name: "Source turn approval", boundPath: cwd }, now);
    const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Run gated work" }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Gated work",
      objective: "Run gated work",
      status: "running",
      createdBy: "ling_agent",
      metadata: { sourceTurnId: source.turnId },
    }, now);
    syncWorkflowSourceTurnProgress(store, workflow, now);
    assert.equal(store.getLingTurn(source.turnId).status, "running");
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Gated step",
      prompt: "Run gated step",
      toParticipantId: "teammate_builtin_engineer",
      toParticipantLabel: "Engineer",
      status: "queued",
      metadata: {
        gates: [{
          stage: "post",
          approvalProfile: { mode: "standard", risk: "medium" },
          title: "Review result",
          reason: "Review the completed result.",
          requiredForStatuses: ["succeeded"],
        }],
      },
    }, now);
    const { task, run } = startFixtureStep(store, cwd, step.id, "run_source_turn_approval", now);
    store.markRunSucceeded(run.id, "2026-08-12T15:00:10.000Z");
    finalizeOrchestratedWorkflowStepRun(store, step.id, task.id, store.getRun(run.id), "2026-08-12T15:00:11.000Z");
    const waitingStep = store.getChannelWorkflowStep(step.id);
    assert.equal(waitingStep.status, "waiting_for_approval");
    assert.equal(store.getLingTurn(source.turnId).status, "waiting_for_approval");
    const approval = store.approveApprovalRequest(waitingStep.metadata.postStepApprovalId, { resolvedBy: "local-user" }, "2026-08-12T15:00:12.000Z");
    syncWorkflowApprovalDecision(store, approval, "2026-08-12T15:00:12.000Z");
    assert.equal(store.getLingTurn(source.turnId).status, "running");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("post-step approval cannot replace missing required operation evidence", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-workflow-post-approval-operation-evidence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-08-12T16:00:00.000Z";
    const channel = store.createChannel({ name: "Post approval evidence", boundPath: cwd }, now);
    const workflow = store.createChannelWorkflow({
      channelId: channel.id,
      title: "Run gated command",
      objective: "Run node app.js",
      status: "ready",
      createdBy: "ling_agent",
    }, now);
    const plan = { operations: [operation("run_command", "run_command", "command", "node app.js")] };
    const step = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Run gated command",
      prompt: "Run node app.js",
      toParticipantId: "teammate_builtin_qa",
      toParticipantLabel: "QA",
      status: "queued",
      metadata: { executionPlan: plan, executionOperationIds: ["run_command"] },
    }, now);
    const { run, owner } = startFixtureStep(store, cwd, step.id, "run_post_approval_missing_operation", now);
    store.markRunSucceeded(run.id, "2026-08-12T16:00:10.000Z");
    const requested = store.commitChannelWorkflowStepPostApproval({
      workflowStepId: step.id,
      owner, runId: run.id, now: "2026-08-12T16:00:10.500Z",
      approval: {
        risk: "medium", title: "Review command result", description: "Review the completed command.",
        payload: { type: "workflow_step", gateStage: "post", workflowId: workflow.id, workflowStepId: step.id, runId: run.id },
      },
    });
    assert.equal(requested.status, "requested", JSON.stringify(requested));
    const approval = requested.approval;
    const approved = store.approveApprovalRequest(approval.id, { resolvedBy: "local-user" }, "2026-08-12T16:00:11.000Z");

    syncWorkflowApprovalDecision(store, approved, "2026-08-12T16:00:11.000Z");

    const closedStep = store.getChannelWorkflowStep(step.id);
    assert.equal(closedStep.status, "blocked");
    assert.equal(closedStep.metadata.executionVerification.status, "blocked");
    assert.equal(store.getChannelWorkflow(workflow.id).status, "blocked");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const sample of [
  {
    name: "assistant message boundaries preserve Markdown",
    events: [
      ["assistant_text_delta", { text: "Inspect first." }],
      ["message_end", { role: "assistant", text: "Inspect first." }],
      ["assistant_text_delta", { text: "## Result\n\n```js\n" }],
      ["assistant_text_delta", { text: "console.log('ok');\n```" }],
      ["message_end", { role: "assistant", text: "## Result\n\n```js\nconsole.log('ok');\n```" }],
    ],
    expected: "Inspect first.\n\n## Result\n\n```js\nconsole.log('ok');\n```",
  },
  {
    name: "end-only assistant content is retained",
    events: [["message_end", { role: "assistant", text: "Completed without text deltas." }]],
    expected: "Completed without text deltas.",
  },
  {
    name: "narration after the first event page is retained",
    events: [
      ["assistant_text_delta", { text: "Before tool work." }],
      ["message_end", { role: "assistant", text: "Before tool work." }],
      ...Array.from({ length: 1001 }, () => ["message_end", { role: "toolResult" }]),
      ["assistant_text_delta", { text: "After tool work." }],
      ["message_end", { role: "assistant", text: "After tool work." }],
    ],
    expected: "Before tool work.\n\nAfter tool work.",
  },
]) {
  test(`delegated result narration: ${sample.name}`, async () => {
    const fixture = await createMultiAgentOperationFixture("result-narration");
    try {
      appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "ok" }, false);
      for (const [type, data] of sample.events) fixture.store.appendEvent(fixture.engineerRun.id, type, data);
      fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T17:00:10.000Z");
      const result = finalizeDelegatedWorkflowStepFromCanonicalState({
        store: fixture.store,
        workflowStepId: fixture.engineerStep.id,
        cause: "run_terminal",
        now: "2026-08-12T17:00:11.000Z",
      });
      assert.equal(result.status, "finalized");
      const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
      assert.equal(step.status, "succeeded");
      assert.equal(step.resultSummary, sample.expected);
    } finally {
      await fixture.close();
    }
  });
}

test("delegated finalization is idempotent across duplicate callbacks", async () => {
  const fixture = await createMultiAgentOperationFixture("duplicate-callback");
  try {
    appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "console.log('ok')" }, false);
    fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T17:00:10.000Z");
    const first = finalizeDelegatedWorkflowStepFromCanonicalState({
      store: fixture.store,
      workflowStepId: fixture.engineerStep.id,
      cause: "run_terminal",
      now: "2026-08-12T17:00:11.000Z",
    });
    const second = finalizeDelegatedWorkflowStepFromCanonicalState({
      store: fixture.store,
      workflowStepId: fixture.engineerStep.id,
      cause: "duplicate_callback",
      now: "2026-08-12T17:00:12.000Z",
    });
    assert.equal(first.status, "finalized");
    assert.equal(second.status, "duplicate");
    const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    assert.equal(step.status, "succeeded");
    assert.equal(step.metadata.delegatedOutcome.kind, "completed");
    assert.ok(step.metadata.delegatedOutcomeBasisFingerprint);
    assert.equal(fixture.store.listStateTransitionEvents({ entityType: "workflow_step", entityId: step.id })
      .filter((event) => event.event === "succeed").length, 1);
  } finally {
    await fixture.close();
  }
});

test("delegated finalization rolls back the step and transition event and keeps the connection reusable", async (t) => {
  for (const boundary of ["step", "transition_event"]) {
    await t.test(boundary, async () => {
      const fixture = await createMultiAgentOperationFixture(`finalization-rollback-${boundary}`);
      try {
        appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", {
          path: "app.js",
          content: "console.log('ok')",
        }, false);
        fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T17:05:10.000Z");
        const beforeStep = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
        const beforeEvents = fixture.store.listStateTransitionEvents({
          entityType: "workflow_step",
          entityId: fixture.engineerStep.id,
        });
        fixture.store.database.exec(delegatedFinalizationCrashTrigger(boundary, fixture.engineerStep.id));

        assert.throws(() => finalizeDelegatedWorkflowStepFromCanonicalState({
          store: fixture.store,
          workflowStepId: fixture.engineerStep.id,
          cause: "run_terminal",
          now: "2026-08-12T17:05:11.000Z",
        }), /injected_delegated_finalization_crash/u);
        assert.deepEqual(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id), beforeStep);
        assert.deepEqual(fixture.store.listStateTransitionEvents({
          entityType: "workflow_step",
          entityId: fixture.engineerStep.id,
        }), beforeEvents);
        appendRollbackRecoveryProbe(
          fixture.store,
          fixture.engineerRun.cwd,
          `delegated-finalization-${boundary}`,
          "2026-08-12T17:05:11.500Z",
        );
        fixture.store.database.exec(`DROP TRIGGER ${delegatedFinalizationCrashTriggerName(boundary)};`);

        const recovered = finalizeDelegatedWorkflowStepFromCanonicalState({
          store: fixture.store,
          workflowStepId: fixture.engineerStep.id,
          cause: "run_terminal",
          now: "2026-08-12T17:05:12.000Z",
        });
        assert.equal(recovered.status, "finalized");
        assert.equal(recovered.step.status, "succeeded");
        assert.equal(recovered.step.metadata.delegatedOutcome.kind, "completed");
        assert.equal(fixture.store.listStateTransitionEvents({
          entityType: "workflow_step",
          entityId: fixture.engineerStep.id,
        }).filter((event) => event.event === "succeed").length, 1);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("completion evaluation rolls back workflow state and event and succeeds on the same connection", async (t) => {
  for (const boundary of ["workflow", "transition_event"]) {
    await t.test(boundary, async () => {
      const fixture = await createMultiAgentOperationFixture(`completion-rollback-${boundary}`);
      try {
        appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", {
          path: "app.js",
          content: "console.log('ok')",
        }, false);
        fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T17:06:10.000Z");
        assert.equal(finalizeDelegatedWorkflowStepFromCanonicalState({
          store: fixture.store,
          workflowStepId: fixture.engineerStep.id,
          cause: "run_terminal",
          now: "2026-08-12T17:06:11.000Z",
        }).status, "finalized");
        fixture.startQa("2026-08-12T17:06:11.500Z");
        appendBashAction(fixture.store, fixture.qaRun.id, "node app.js", {
          exitCode: 0,
          timedOut: false,
          cancelled: false,
        });
        fixture.store.markRunSucceeded(fixture.qaRun.id, "2026-08-12T17:06:12.000Z");
        assert.equal(finalizeDelegatedWorkflowStepFromCanonicalState({
          store: fixture.store,
          workflowStepId: fixture.qaStep.id,
          cause: "run_terminal",
          now: "2026-08-12T17:06:13.000Z",
        }).status, "finalized");

        const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
        assert.equal(workflow.status, "running");
        const evaluation = evaluateWorkflowCompletion({
          store: fixture.store,
          workflow,
          steps: fixture.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }),
          now: "2026-08-12T17:06:14.000Z",
        });
        assert.equal(evaluation.gate.status, "verified");
        const fabricated = {
          ...evaluation,
          gate: { ...evaluation.gate, basisFingerprint: "wcbv1_fabricated" },
        };
        assert.deepEqual(fixture.store.commitChannelWorkflowCompletionEvaluation({
          workflowId: workflow.id,
          evaluation: fabricated,
          now: "2026-08-12T17:06:14.500Z",
        }), {
          ok: false,
          code: "invalid_transition",
          currentStatus: "running",
        });
        const beforeWorkflow = fixture.store.getChannelWorkflow(workflow.id);
        const beforeEvents = fixture.store.listStateTransitionEvents({
          entityType: "workflow",
          entityId: workflow.id,
        });
        fixture.store.database.exec(workflowCompletionCrashTrigger(boundary, workflow.id));

        assert.throws(() => fixture.store.commitChannelWorkflowCompletionEvaluation({
          workflowId: workflow.id,
          evaluation,
          now: "2026-08-12T17:06:15.000Z",
        }), /injected_workflow_completion_crash/u);
        assert.deepEqual(fixture.store.getChannelWorkflow(workflow.id), beforeWorkflow);
        assert.deepEqual(fixture.store.listStateTransitionEvents({
          entityType: "workflow",
          entityId: workflow.id,
        }), beforeEvents);
        appendRollbackRecoveryProbe(
          fixture.store,
          fixture.engineerRun.cwd,
          `workflow-completion-${boundary}`,
          "2026-08-12T17:06:15.500Z",
        );
        fixture.store.database.exec(`DROP TRIGGER ${workflowCompletionCrashTriggerName(boundary)};`);

        const recovered = fixture.store.commitChannelWorkflowCompletionEvaluation({
          workflowId: workflow.id,
          evaluation,
          now: "2026-08-12T17:06:16.000Z",
        });
        assert.deepEqual(recovered, { ok: true, from: "running", to: "succeeded" });
        const completedWorkflow = fixture.store.getChannelWorkflow(workflow.id);
        assert.equal(completedWorkflow.status, "succeeded");
        assert.equal(completedWorkflow.metadata.completionGate.status, "verified");
        assert.equal(fixture.store.listStateTransitionEvents({
          entityType: "workflow",
          entityId: workflow.id,
        }).filter((event) => event.event === "all_steps_succeeded").length, 1);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("startup reconciliation finalizes terminal delegated Runs with the online rules", async () => {
  const fixture = await createMultiAgentOperationFixture("startup-reconcile");
  try {
    appendToolAction(fixture.store, fixture.engineerRun.id, "write_app", "write", { path: "app.js", content: "console.log('ok')" }, false);
    fixture.store.markRunSucceeded(fixture.engineerRun.id, "2026-08-12T17:10:10.000Z");
    assert.equal(fixture.store.recoverStaleChannelWorkflows("2026-08-12T17:10:11.000Z"), 0);
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "running");
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.qaStep.id).status, "queued");
    const engineerRecovery = reconcileWorkflowFromCanonicalState({ store: fixture.store, workflowId: fixture.workflow.id,
      cause: "startup", now: "2026-08-12T17:10:12.000Z" });
    assert.deepEqual(engineerRecovery.finalizedStepIds, [fixture.engineerStep.id]);
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "succeeded");
    assert.notEqual(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "succeeded");
    fixture.startQa("2026-08-12T17:10:13.000Z");
    appendBashAction(fixture.store, fixture.qaRun.id, "node app.js", {
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
    fixture.store.markRunSucceeded(fixture.qaRun.id, "2026-08-12T17:10:16.000Z");
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.qaStep.id).status, "running");
    const recovered = reconcileWorkflowFromCanonicalState({
      store: fixture.store,
      workflowId: fixture.workflow.id,
      cause: "startup",
      now: "2026-08-12T17:10:17.000Z",
    });
    assert.deepEqual(recovered.finalizedStepIds, [fixture.qaStep.id]);
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "succeeded");
    const recoveredQaStep = fixture.store.getChannelWorkflowStep(fixture.qaStep.id);
    assert.equal(recoveredQaStep.status, "succeeded", JSON.stringify(recoveredQaStep.metadata));
    assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "succeeded");
    assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).metadata.completionGate.status, "verified");
  } finally {
    await fixture.close();
  }
});

test("a valid preparing owner waits online and is settled only by scoped startup recovery", async (t) => {
  for (const cause of ["startup", "explicit_reconcile"]) {
    await t.test(cause, async () => {
      const fixture = await createMultiAgentOperationFixture(`missing-linked-run-${cause}`, { engineerPhase: "preparing" });
      try {
        const before = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
        if (cause === "startup") {
          assert.equal(fixture.store.recoverStaleChannelWorkflows("2026-08-12T17:12:00.000Z"), 1);
        }
        const reconciled = reconcileWorkflowFromCanonicalState({
          store: fixture.store,
          workflowId: fixture.workflow.id,
          cause,
          now: "2026-08-12T17:12:01.000Z",
        });
        const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
        assert.equal(step.runId, undefined);
        assert.equal(fixture.store.getTask(fixture.engineerTask.id).currentRunId, undefined);
        if (cause === "startup") {
          assert.deepEqual(reconciled.finalizedStepIds, [], "Core startup recovery already settled only its captured preparing owner");
          assert.equal(step.status, "blocked");
          assert.equal(step.metadata.delegatedOutcome.kind, "blocked");
          assert.equal(step.metadata.delegatedOutcome.code, "delegated_run_missing");
          assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "blocked");
        } else {
          assert.deepEqual(reconciled.finalizedStepIds, []);
          assert.deepEqual(step, before);
          assert.equal(step.metadata.startOwner.phase, "preparing");
          assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "running");
        }
      } finally {
        await fixture.close();
      }
    });
  }
});

test("participant preflight failure atomically settles its preparing owner before a Run exists", async () => {
  const fixture = await createMultiAgentOperationFixture("participant-preflight-blocker", {
    engineerPhase: "preparing", engineerStartedAt: "2026-08-12T17:12:30.000Z" });
  try {
    const result = fixture.store.settleChannelWorkflowStepStartFailure({
      workflowStepId: fixture.engineerStep.id,
      owner: fixture.engineerOwner, leaseId: fixture.engineerLease.id,
      blocker: "The assigned participant no longer allows write.",
      delegatedBlock: { code: "workflow_participant_required_tools_unavailable",
        reason: "The assigned participant no longer allows write.", missingRequirements: ["tool:write"] },
      now: "2026-08-12T17:12:31.000Z",
    });
    assert.equal(result.status, "linked");
    const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    assert.equal(step.status, "blocked");
    assert.equal(step.runId, undefined);
    assert.deepEqual(step.metadata.delegatedOutcome, {
      kind: "blocked",
      workflowId: fixture.workflow.id,
      workflowStepId: fixture.engineerStep.id,
      participantId: step.toParticipantId,
      code: "workflow_participant_required_tools_unavailable",
      reason: "The assigned participant no longer allows write.",
      missingRequirements: ["tool:write"],
      lineage: {
        workflowId: fixture.workflow.id,
        workflowStepId: fixture.engineerStep.id,
        participantId: step.toParticipantId,
        runId: null,
        attemptId: null,
        sourceRefs: [
          { type: "workflow", id: fixture.workflow.id },
          { type: "workflow_step", id: fixture.engineerStep.id },
        ],
      },
      evidenceRefs: [],
    });
    assert.ok(step.metadata.delegatedOutcomeBasisFingerprint);
    assert.equal(fixture.store.getTask(fixture.engineerTask.id).currentRunId, undefined);
    assert.equal(fixture.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id })
      .find((lease) => lease.id === fixture.engineerLease.id).status, "released");
  } finally {
    await fixture.close();
  }
});

test("a captured preparing failure cannot overwrite a concurrently linked ready owner", async () => {
  const fixture = await createMultiAgentOperationFixture("missing-linked-run-race", {
    engineerPhase: "preparing", engineerStartedAt: "2026-08-12T17:13:00.000Z" });
  try {
    const capturedFailure = { workflowStepId: fixture.engineerStep.id, owner: fixture.engineerOwner,
      leaseId: fixture.engineerLease.id, blocker: "A stale preparation failed", now: "2026-08-12T17:13:02.000Z" };
    const run = readyFixtureStep(fixture.store, fixture.cwd, fixture.engineerStep.id,
      { task: fixture.engineerTask, owner: fixture.engineerOwner }, "run_preparing_ready_race", "2026-08-12T17:13:01.000Z");
    const beforeStep = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    const beforeTask = fixture.store.getTask(fixture.engineerTask.id);
    const beforeLeases = fixture.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: beforeStep.id });
    const result = fixture.store.settleChannelWorkflowStepStartFailure(capturedFailure);
    assert.equal(result.status, "stale");
    const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    assert.equal(step.status, "running");
    assert.equal(step.runId, run.id);
    assert.equal(step.metadata.startOwner.phase, "linked");
    assert.deepEqual(step, beforeStep);
    assert.deepEqual(fixture.store.getTask(fixture.engineerTask.id), beforeTask);
    assert.deepEqual(fixture.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: beforeStep.id }), beforeLeases);
    assert.equal(step.metadata.delegatedOutcomeBasisFingerprint, undefined);
  } finally {
    await fixture.close();
  }
});

test("completion evaluation CAS rejects every changed canonical authority class", async (t) => {
  const cases = [
    {
      name: "source decision",
      mutate: (fixture) => fixture.store.database.prepare(`
        UPDATE channel_intent_decisions SET updated_at = ? WHERE id = ?
      `).run("2026-08-12T18:00:01.000Z", fixture.workflow.metadata.sourceIntentDecisionId),
    },
    {
      name: "workflow",
      mutate: (fixture) => fixture.store.updateChannelWorkflow(fixture.workflow.id, {
        metadata: { ...fixture.store.getChannelWorkflow(fixture.workflow.id).metadata, reconciliationTest: "workflow-mutated" },
      }, "2026-08-12T18:00:02.000Z"),
    },
    {
      name: "step",
      mutate: (fixture) => fixture.store.updateChannelWorkflowStep(fixture.engineerStep.id, {
        resultSummary: "Concurrent step mutation",
      }, "2026-08-12T18:00:03.000Z"),
    },
    {
      name: "run",
      mutate: (fixture) => fixture.store.markRunWaitingForApproval(fixture.engineerRun.id, "2026-08-12T18:00:04.000Z"),
    },
    {
      name: "run event",
      mutate: (fixture) => fixture.store.appendEvent(fixture.engineerRun.id, "progress", { message: "Concurrent event" }),
    },
    {
      name: "approval",
      mutate: (fixture) => fixture.store.createApprovalRequest({
        workflowStepId: fixture.engineerStep.id,
        channelId: fixture.store.getChannelWorkflow(fixture.workflow.id).channelId,
        actionType: "workflow_step",
        risk: "medium",
        title: "Concurrent approval",
        description: "Approval created after completion evaluation.",
        payload: {
          type: "workflow_step",
          gateStage: "post",
          workflowId: fixture.workflow.id,
          workflowStepId: fixture.engineerStep.id,
          title: "Concurrent approval",
          approvalMode: "manual",
          requiredForTools: [],
          requiredForActions: [],
        },
      }, "2026-08-12T18:00:05.000Z"),
    },
    {
      name: "artifact",
      mutate: (fixture) => fixture.store.createArtifact({
        runId: fixture.engineerRun.id,
        type: "json",
        path: "concurrent-artifact.json",
        sealedPayload: { schemaVersion: 1, kind: "concurrent" },
        createdAt: "2026-08-12T18:00:06.000Z",
      }),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = await createMultiAgentOperationFixture(`cas-${scenario.name.replaceAll(" ", "-")}`);
      try {
        const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
        const steps = fixture.store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
        const evaluation = evaluateWorkflowCompletion({
          store: fixture.store,
          workflow,
          steps,
          now: "2026-08-12T18:00:00.000Z",
        });
        assert.equal(evaluation.gate.status, "pending");
        scenario.mutate(fixture);
        assert.deepEqual(fixture.store.commitChannelWorkflowCompletionEvaluation({
          workflowId: workflow.id,
          evaluation,
          now: "2026-08-12T18:00:10.000Z",
        }), {
          ok: false,
          code: "stale_transition",
          currentStatus: fixture.store.getChannelWorkflow(workflow.id).status,
        });
      } finally {
        await fixture.close();
      }
    });
  }
});

test("a late callback cannot finalize a newer linked retry Run", async () => {
  const fixture = await createMultiAgentOperationFixture("late-callback");
  try {
    appendToolAction(fixture.store, fixture.engineerRun.id, "write_old", "write", { path: "app.js", content: "old" }, false);
    fixture.store.markRunFailed(fixture.engineerRun.id, "2026-08-12T17:20:10.000Z", "Retryable fixture failure");
    assert.equal(finalizeDelegatedWorkflowStepFromCanonicalState({ store: fixture.store, workflowStepId: fixture.engineerStep.id,
      cause: "run_terminal", now: "2026-08-12T17:20:11.000Z" }).status, "finalized");
    assert.equal(fixture.store.getChannelWorkflowStep(fixture.engineerStep.id).status, "blocked");
    fixture.store.releaseResourceLease(fixture.engineerLease.id, "workflow_step", fixture.engineerStep.id, "2026-08-12T17:20:11.000Z");
    const retry = startFixtureStep(fixture.store, fixture.cwd, fixture.engineerStep.id,
      "run_multi_engineer_late_callback_retry", "2026-08-12T17:20:12.000Z");
    assert.notEqual(retry.task.id, fixture.engineerTask.id);
    const before = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    finalizeOrchestratedWorkflowStepRun(
      fixture.store,
      fixture.engineerStep.id,
      fixture.engineerTask.id,
      fixture.store.getRun(fixture.engineerRun.id),
      "2026-08-12T17:20:13.000Z",
    );
    const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    assert.equal(step.runId, retry.run.id);
    assert.equal(step.taskId, retry.task.id);
    assert.equal(step.status, "running");
    assert.equal(step.metadata.startOwner.phase, "linked");
    assert.deepEqual(step, before);
  } finally {
    await fixture.close();
  }
});

test("A12 captured delegated B cannot request a post-approval after real reconciliation and C takeover", async () => {
  const fixture = await createMultiAgentOperationFixture("post-approval-takeover", { engineerPhase: "queued" });
  try {
    const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    fixture.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata,
      gates: [{ stage: "post", approvalProfile: { mode: "standard", risk: "medium" },
        title: "Review result", reason: "Review the completed result.", requiredForStatuses: ["succeeded"] }],
    } }, "2026-08-12T17:24:00.000Z");
    const generation = startFixtureStep(fixture.store, fixture.cwd, step.id,
      "run_post_approval_B", "2026-08-12T17:24:01.000Z");
    // B's model finishes without the required write evidence. A concurrent
    // canonical reconciliation genuinely blocks it before a fresh C starts.
    fixture.store.markRunSucceeded(generation.run.id, "2026-08-12T17:24:02.000Z");
    const commit = fixture.store.commitChannelWorkflowStepPostApproval.bind(fixture.store);
    let captured;
    let replacement;
    let replacementState;
    fixture.store.commitChannelWorkflowStepPostApproval = (input) => {
      captured = input;
      const blocked = finalizeDelegatedWorkflowStepFromCanonicalState({ store: fixture.store,
        workflowStepId: step.id, cause: "explicit_reconcile", now: "2026-08-12T17:24:03.000Z" });
      assert.equal(blocked.status, "finalized");
      assert.equal(fixture.store.getChannelWorkflowStep(step.id).status, "blocked");
      replacement = startFixtureStep(fixture.store, fixture.cwd, step.id,
        "run_post_approval_C", "2026-08-12T17:24:04.000Z");
      replacementState = workflowFinalizerDurableSnapshot(fixture.store);
      return commit(input);
    };
    assert.throws(() => finalizeOrchestratedWorkflowStepRun(fixture.store, step.id, generation.task.id,
      fixture.store.getRun(generation.run.id), "2026-08-12T17:24:05.000Z"),
    (error) => error.code === "workflow_post_approval_owner_stale");
    assert.equal(captured.owner.taskId, generation.task.id);
    assert.equal(captured.runId, generation.run.id);
    assert.notEqual(replacement.task.id, generation.task.id);
    assert.deepEqual(workflowFinalizerDurableSnapshot(fixture.store), replacementState,
      "rejected B approval must not create an approval, marker, reply or state audit for C");
    const current = fixture.store.getChannelWorkflowStep(step.id);
    assert.equal(current.status, "running");
    assert.equal(current.runId, replacement.run.id);
    assert.equal(current.metadata.postStepApprovalId, undefined);
    assert.equal(fixture.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, limit: 100 })
      .find((lease) => lease.id === replacement.lease.id).status, "active");
  } finally { await fixture.close(); }
});

for (const decision of ["approved", "denied"]) {
  test(`A12 replayed ${decision} B approval cannot settle C's current post gate`, async () => {
    const fixture = await createMultiAgentOperationFixture(`post-decision-replay-${decision}`, { engineerPhase: "queued" });
    const { store } = fixture;
    try {
      const step = store.getChannelWorkflowStep(fixture.engineerStep.id);
      store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata,
        gates: [{ stage: "post", approvalProfile: { mode: "standard", risk: "medium" },
          title: "Review result", reason: "Review this generation's completed result.", requiredForStatuses: ["succeeded"] }],
        policy: { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true },
      } }, "2026-08-12T17:25:00.000Z");
      const b = startFixtureStep(store, fixture.cwd, step.id, `run_post_replay_B_${decision}`, "2026-08-12T17:25:01.000Z");
      store.markRunSucceeded(b.run.id, "2026-08-12T17:25:02.000Z");
      finalizeOrchestratedWorkflowStepRun(store, step.id, b.task.id, store.getRun(b.run.id), "2026-08-12T17:25:03.000Z");
      const waitingB = store.getChannelWorkflowStep(step.id);
      assert.equal(waitingB.status, "waiting_for_approval");
      const oldDecision = store[decision === "approved" ? "approveApprovalRequest" : "denyApprovalRequest"](
        waitingB.metadata.postStepApprovalId, { resolvedBy: "local-user" }, "2026-08-12T17:25:04.000Z");
      assert.equal(oldDecision.status, decision);
      // A lawful reconciliation blocks B: approval cannot manufacture the
      // missing write evidence, and a denied approval is not successful work.
      assert.equal(finalizeDelegatedWorkflowStepFromCanonicalState({ store, workflowStepId: step.id,
        cause: "explicit_reconcile", now: "2026-08-12T17:25:05.000Z" }).status, "finalized");
      assert.equal(store.getChannelWorkflowStep(step.id).status, "blocked");
      reconcileWorkflowFromCanonicalState({ store, workflowId: fixture.workflow.id,
        cause: "explicit_reconcile", now: "2026-08-12T17:25:05.000Z" });
      assert.equal(store.getChannelWorkflow(fixture.workflow.id).status, "blocked");
      store.releaseResourceLease(b.lease.id, "workflow_step", step.id, "2026-08-12T17:25:06.000Z");

      const c = startFixtureStep(store, fixture.cwd, step.id, `run_post_replay_C_${decision}`, "2026-08-12T17:25:07.000Z");
      assert.notEqual(c.task.id, b.task.id);
      appendToolAction(store, c.run.id, "write_C", "write", { path: "app.js", content: "console.log('C')" }, false);
      store.markRunSucceeded(c.run.id, "2026-08-12T17:25:08.000Z");
      finalizeOrchestratedWorkflowStepRun(store, step.id, c.task.id, store.getRun(c.run.id), "2026-08-12T17:25:09.000Z");
      const waitingC = store.getChannelWorkflowStep(step.id);
      const cApproval = store.getApprovalRequest(waitingC.metadata.postStepApprovalId);
      assert.equal(waitingC.status, "waiting_for_approval");
      assert.equal(store.getChannelWorkflow(fixture.workflow.id).status, "waiting_for_approval");
      assert.equal(cApproval.status, "pending");
      assert.equal(cApproval.payload.runId, c.run.id);
      assert.notEqual(cApproval.id, oldDecision.id);
      assert.equal(waitingC.metadata.activeGateStage, "post");

      const observer = new DatabaseSync(store.paths.databasePath, { readOnly: true });
      const snapshot = () => Object.fromEntries(observer.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all().map(({ name }) => [name, observer.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
      try {
        const before = snapshot();
        // This is the same exported entry used by durable post-commit effect
        // recovery. A captured B decision must be a no-op against C's gate.
        syncWorkflowApprovalDecision(store, oldDecision, "2026-08-12T17:25:10.000Z");
        assert.deepEqual(snapshot(), before, "old approval replay must not mutate any current-generation durable facts");
      } finally { observer.close(); }
      assert.equal(store.getChannelWorkflowStep(step.id).status, "waiting_for_approval");
      assert.equal(store.getApprovalRequest(cApproval.id).status, "pending");

      const approvedC = store.approveApprovalRequest(cApproval.id, { resolvedBy: "local-user" }, "2026-08-12T17:25:11.000Z");
      assert.equal(approvedC.status, "approved");
      syncWorkflowApprovalDecision(store, approvedC, "2026-08-12T17:25:12.000Z");
      const completedC = store.getChannelWorkflowStep(step.id);
      assert.equal(completedC.runId, c.run.id);
      assert.equal(completedC.status, "succeeded");
      assert.equal(completedC.metadata.delegatedOutcome.kind, "completed");
      assert.equal(completedC.metadata.activeGateStage, undefined);
    } finally { await fixture.close(); }
  });
}

function workflowFinalizerDurableSnapshot(store) {
  const database = new DatabaseSync(store.paths.databasePath, { readOnly: true });
  try {
    return Object.fromEntries(["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions",
      "resource_leases", "approval_requests", "artifacts", "conversation_items", "state_transition_events"]
      .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  } finally { database.close(); }
}

test("delegated cancellation preserves cancelled workflow semantics", async () => {
  const fixture = await createMultiAgentOperationFixture("cancelled-run", { engineerPolicy: {
    onRunFailed: "fail_workflow", onRunCancelled: "cancel_workflow", onApprovalDenied: "block_for_user", retryable: false } });
  try {
    const step = fixture.store.getChannelWorkflowStep(fixture.engineerStep.id);
    fixture.store.markRunCancelled(fixture.engineerRun.id, "2026-08-12T17:30:10.000Z", "User cancelled.");
    reconcileWorkflowFromCanonicalState({
      store: fixture.store,
      workflowId: fixture.workflow.id,
      cause: "run_terminal",
      now: "2026-08-12T17:30:11.000Z",
    });
    const cancelledStep = fixture.store.getChannelWorkflowStep(step.id);
    assert.equal(cancelledStep.status, "cancelled");
    assert.equal(cancelledStep.metadata.delegatedOutcome.kind, "cancelled");
    assert.equal(fixture.store.getChannelWorkflow(fixture.workflow.id).status, "cancelled");
  } finally {
    await fixture.close();
  }
});

async function createOperationFixture(suffix, operations, policy) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-workflow-operation-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-12T12:00:00.000Z";
  const channel = store.createChannel({ name: `Operation ${suffix}`, boundPath: cwd }, now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Create and run app.js" }, now);
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Create and run",
    objective: "Create and run app.js",
    status: "running",
    createdBy: "ling_agent",
  }, now);
  const plan = { operations };
  const step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Create and run",
    prompt: "Create and run app.js",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "queued",
    metadata: {
      executionPlan: plan,
      executionOperationIds: operations.map((item) => item.id),
      policy: policy ?? { onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true },
    },
  }, now);
  const { task, run } = startFixtureStep(store, cwd, step.id, `run_operation_${suffix}`, now);
  return {
    store,
    cwd,
    workflow,
    step: store.getChannelWorkflowStep(step.id),
    task,
    run: store.getRun(run.id),
    close: async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function operation(id, kind, targetKind, label, dependsOn = [], commandMatchPolicy) {
  return {
    id,
    kind,
    targetKind,
    targetRef: { type: "operation", id: `target:${id}`, label },
    ...(kind === "run_command" && targetKind === "command"
      ? { commandMatchPolicy: commandMatchPolicy ?? { kind: "exact_command", command: label } }
      : {}),
    required: true,
    dependsOn,
  };
}

function projectionFor(item, assignment) {
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: item.threadId },
      { type: "turn", id: item.turnId },
      { type: "conversation_item", id: item.id },
    ],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}

async function createMultiAgentOperationFixture(suffix, { engineerPhase = "linked", engineerPolicy, engineerStartedAt } = {}) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-workflow-multi-operation-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-12T14:00:00.000Z";
  const channel = store.createChannel({ name: `Multi operation ${suffix}`, boundPath: cwd }, now);
  const engineerBinding = fixtureParticipantBinding(store, channel, cwd, "teammate_builtin_engineer", ["write"], now);
  const qaBinding = fixtureParticipantBinding(store, channel, cwd, "teammate_builtin_qa", ["bash"], now);
  const participantManifest = createRequiredParticipantManifestV1([{
    participantId: "teammate_builtin_engineer",
    role: "engineer",
    requirement: "required",
    expectedOutcome: "execution",
    requiredOperationIds: ["create_file"],
    requestedBy: "explicit_role",
  }, {
    participantId: "teammate_builtin_qa",
    role: "qa",
    requirement: "required",
    expectedOutcome: "verification",
    requiredOperationIds: ["run_command"],
    requestedBy: "explicit_role",
  }]);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Engineer then QA" }, now);
  const sourceItem = store.getConversationItem(source.id);
  const assignment = store.getEffectiveTurnContextAssignment(sourceItem.turnId);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: source.id,
    contextProjection: projectionFor(sourceItem, assignment),
    action: "execute",
    selectedTeammateIds: participantManifest.participants.map((participant) => participant.participantId),
    participantManifest,
    execution: {
      operations: [
        operation("create_file", "file_create", "file", "app.js"),
        operation("run_command", "run_command", "command", "node app.js", ["create_file"]),
      ],
    },
    reason: "Engineer then QA",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  const graph = {
    schemaVersion: 1,
    id: `graph_multi_${suffix}`,
    name: "Engineer then QA",
    entryNodeId: "engineer",
    nodes: [
      { id: "engineer", kind: "step", name: "Engineer write", prompt: "Create app.js", teammateId: "teammate_builtin_engineer",
        providerPresetId: engineerBinding.providerPresetId, providerBinding: engineerBinding },
      { id: "qa", kind: "step", name: "QA run", prompt: "Run node app.js", teammateId: "teammate_builtin_qa",
        providerPresetId: qaBinding.providerPresetId, providerBinding: qaBinding },
    ],
    edges: [{ id: "engineer_to_qa", fromNodeId: "engineer", toNodeId: "qa", condition: { kind: "all_succeeded" } }],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Engineer then QA",
    objective: "Create and run app.js",
    status: "running",
    createdBy: "ling_agent",
    metadata: {
      sourceIntentDecisionId: decision.id,
      requiredParticipantManifest: participantManifest,
      workflowGraph: graph,
      workflowGraphId: graph.id,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
      termination: graph.termination,
    },
  }, now);
  const plan = {
    operations: [
      operation("create_file", "file_create", "file", "app.js"),
      operation("run_command", "run_command", "command", "node app.js", ["create_file"]),
    ],
  };
  const engineerStep = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    position: 1,
    title: "Engineer write",
    prompt: "Create app.js",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "queued",
    metadata: { graphId: graph.id, graphNodeId: "engineer", executionPlan: plan, executionOperationIds: ["create_file"],
      providerPresetId: engineerBinding.providerPresetId, providerBinding: engineerBinding,
      ...(engineerPolicy ? { policy: engineerPolicy } : {}) },
  }, now);
  const qaStep = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    position: 2,
    title: "QA run",
    prompt: "Run node app.js",
    toParticipantId: "teammate_builtin_qa",
    toParticipantLabel: "QA",
    status: "queued",
    metadata: { graphId: graph.id, graphNodeId: "qa", executionPlan: plan, executionOperationIds: ["run_command"], dependsOnStepIds: [engineerStep.id],
      providerPresetId: qaBinding.providerPresetId, providerBinding: qaBinding },
  }, now);
  const [materializedEngineerStep, materializedQaStep] = materializeWorkflowDelegatedStepRequirements({
    store,
    workflow,
    manifest: participantManifest,
    now,
  });
  const engineer = engineerPhase === "queued" ? undefined : startFixtureStep(store, cwd, engineerStep.id,
    `run_multi_engineer_${suffix}`, engineerStartedAt ?? now, { ready: engineerPhase === "linked" });
  const fixture = {
    store,
    cwd,
    workflow,
    engineerStep: store.getChannelWorkflowStep(materializedEngineerStep.id),
    qaStep: materializedQaStep,
    engineerTask: engineer?.task,
    engineerRun: engineer?.run,
    engineerOwner: engineer?.owner,
    engineerLease: engineer?.lease,
    startQa(startedAt) {
      assert.equal(fixture.qaRun, undefined, "QA must have only one fixture-owned start");
      const qa = startFixtureStep(store, cwd, qaStep.id, `run_multi_qa_${suffix}`, startedAt);
      fixture.qaStep = store.getChannelWorkflowStep(qaStep.id);
      fixture.qaTask = qa.task;
      fixture.qaRun = qa.run;
      return qa;
    },
    close: async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
  return fixture;
}

async function createGenericDelegatedActionFixture(suffix) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-workflow-generic-action-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-12T14:05:00.000Z";
  const channel = store.createChannel({ name: "Generic delegated action", boundPath: cwd }, now);
  const providerBinding = fixtureParticipantBinding(store, channel, cwd, "teammate_builtin_engineer", ["read"], now);
  const participantManifest = createRequiredParticipantManifestV1([{
    participantId: "teammate_builtin_engineer",
    role: "engineer",
    requirement: "required",
    expectedOutcome: "execution",
    requiredOperationIds: [],
    requestedBy: "explicit_role",
  }]);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Inspect the workspace" }, now);
  const sourceItem = store.getConversationItem(source.id);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: source.id,
    contextProjection: projectionFor(sourceItem, store.getEffectiveTurnContextAssignment(sourceItem.turnId)),
    action: "execute",
    selectedTeammateIds: ["teammate_builtin_engineer"],
    participantManifest,
    execution: {
      operations: [{
        id: "workflow_execution",
        kind: "run_command",
        targetKind: "workspace",
        targetRef: { type: "operation", id: "generic-workflow", label: "Inspect the workspace" },
        required: false,
        dependsOn: [],
      }],
    },
    reason: "Inspect the workspace",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  const graph = {
    schemaVersion: 1,
    id: `graph_generic_action_${suffix}`,
    name: "Generic delegated action",
    entryNodeId: "engineer",
    nodes: [{ id: "engineer", kind: "step", name: "Inspect", prompt: "Inspect", teammateId: "teammate_builtin_engineer",
      providerPresetId: providerBinding.providerPresetId, providerBinding }],
    edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Inspect",
    objective: "Inspect the workspace",
    status: "running",
    createdBy: "ling_agent",
    metadata: {
      sourceIntentDecisionId: decision.id,
      requiredParticipantManifest: participantManifest,
      workflowGraph: graph,
      workflowGraphId: graph.id,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
      termination: graph.termination,
    },
  }, now);
  let step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Inspect",
    prompt: "Inspect",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "queued",
    metadata: { graphId: graph.id, graphNodeId: "engineer", providerPresetId: providerBinding.providerPresetId, providerBinding },
  }, now);
  [step] = materializeWorkflowDelegatedStepRequirements({ store, workflow, manifest: participantManifest, now });
  const { task, run } = startFixtureStep(store, cwd, step.id, `run_generic_action_${suffix}`, now);
  step = store.getChannelWorkflowStep(step.id);
  return {
    store,
    workflow,
    step,
    task,
    run: store.getRun(run.id),
    close: async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

/** Freeze the real binding producer once, before a start owns its authority basis. */
function fixtureParticipantBinding(store, channel, cwd, participantId, requiredTools, now) {
  store.updateWorkspaceSettings({ defaultProviderPresetId: "provider_workspace" }, now);
  const teammate = store.getAiTeammate(participantId);
  assert.ok(teammate, "fixture requires a real builtin participant");
  const preflight = preflightWorkflowParticipantProvider({ store, channel, teammate, cwd, requiredTools,
    validateRunRequest(request) {
      assert.equal(request.providerPresetId, "provider_workspace");
      assert.equal(request.teammateId, participantId);
      assert.deepEqual(request.tools, requiredTools);
    } });
  assert.equal(preflight.kind, "ready", JSON.stringify(preflight));
  return preflight.binding;
}

/** Begin owns a fresh Task; ready atomically owns both Task and Step Run links. */
function startFixtureStep(store, cwd, workflowStepId, runId, now, { ready = true } = {}) {
  const step = store.getChannelWorkflowStep(workflowStepId);
  const channel = store.getChannel(step.channelId);
  const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step",
    resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id, acquiredAt: now,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() });
  assert.ok(lease);
  const started = store.beginChannelWorkflowStepStart({ workflowStepId: step.id,
    expected: { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt }, leaseId: lease.id,
    task: { channelId: channel.id, title: step.title, prompt: step.prompt, assigneeTeammateId: step.toParticipantId }, now });
  assert.equal(started.status, "begun", JSON.stringify(started));
  assert.equal(store.getTask(started.task.id).currentRunId, undefined);
  if (!ready) return { ...started, lease };
  const run = readyFixtureStep(store, cwd, step.id, started, runId, now);
  return { ...started, task: store.getTask(started.task.id), run, lease };
}

function readyFixtureStep(store, cwd, workflowStepId, started, runId, now) {
  const step = store.getChannelWorkflowStep(workflowStepId);
  const task = store.getTask(started.task.id);
  assert.equal(store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim", actor: "system", now }).ok, true);
  const run = createFixtureRun(store, cwd, step.channelId, step.id, task, runId, now);
  assert.equal(store.getTask(task.id).currentRunId, undefined, "only ready may publish the Task Run link");
  assert.deepEqual(store.commitChannelWorkflowStepRunReady({ workflowStepId: step.id, owner: started.owner, runId: run.id, now }), { status: "linked" });
  assert.equal(store.getTask(task.id).currentRunId, run.id);
  assert.equal(store.getChannelWorkflowStep(step.id).metadata.startOwner.phase, "linked");
  return store.getRun(run.id);
}

function createFixtureRun(store, cwd, channelId, workflowStepId, task, id, now) {
  const step = store.getChannelWorkflowStep(workflowStepId);
  const delegatedRequirement = step?.metadata?.delegatedRequirement;
  const run = store.createRun({
    id,
    cwd,
    taskId: task.id,
    channelId,
    workflowStepId,
    teammateId: step?.toParticipantId,
    ...(step?.metadata?.providerPresetId ? { providerPresetId: step.metadata.providerPresetId } : {}),
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: task.id, title: task.title },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd, ...(delegatedRequirement ? { delegatedRequirement } : {}),
      ...(step?.metadata?.providerBinding ? { providerBinding: step.metadata.providerBinding } : {}) },
    createdAt: now,
  });
  store.markRunStarted(run.id, now);
  const workUnit = store.createWorkUnit({
    id: `work_unit_${id}`,
    workspaceId: "workspace_default",
    kind: "task_run",
    ownerType: "run",
    ownerId: run.id,
    channelId,
    taskId: task.id,
    teammateId: step?.toParticipantId,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    idempotencyKey: `fixture-work-unit:${id}`,
    createdByActor: "system",
    request: { workflowStepId },
    linkedRunId: run.id,
    now,
  });
  const attempt = store.createWorkUnitAttempt({
    id: `attempt_${id}`,
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: `fixture-runtime:${id}`,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    now,
  });
  store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: "queued",
    event: "claim",
    actor: "system",
    now,
    activeAttemptId: attempt.id,
  });
  store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: "claimed",
    event: "runner_started",
    actor: "runner",
    now,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  store.appendEvent(run.id, "run_created", {
    attemptId: attempt.id,
    workUnitId: workUnit.id,
  });
  return store.getRun(run.id);
}

async function waitForCondition(check, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw lastError ?? new Error(`Timed out waiting for ${message}.`);
}

async function createSynthesisFinalizationFixture(suffix) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-workflow-synthesis-finalization-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-12T14:25:00.000Z";
  const channel = store.createChannel({ name: "Synthesis finalization", boundPath: cwd }, now);
  const providerBinding = fixtureParticipantBinding(store, channel, cwd, "teammate_builtin_architect", [], now);
  const participantManifest = createRequiredParticipantManifestV1([{
    participantId: "teammate_builtin_architect",
    role: "architect",
    requirement: "required",
    expectedOutcome: "synthesis",
    requiredOperationIds: [],
    requestedBy: "explicit_role",
  }]);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "Synthesize" }, now);
  const sourceItem = store.getConversationItem(source.id);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: source.id,
    contextProjection: projectionFor(sourceItem, store.getEffectiveTurnContextAssignment(sourceItem.turnId)),
    action: "workflow_proposal",
    selectedTeammateIds: ["teammate_builtin_architect"],
    participantManifest,
    reason: "Synthesize",
    status: "accepted",
    createdBy: "deterministic",
  }, now);
  const graph = {
    schemaVersion: 1,
    id: `graph_synthesis_${suffix}`,
    name: "Synthesis",
    entryNodeId: "synthesis",
    nodes: [{ id: "synthesis", kind: "step", name: "Synthesis", prompt: "Synthesize", teammateId: "teammate_builtin_architect",
      providerPresetId: providerBinding.providerPresetId, providerBinding }],
    edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Synthesis",
    objective: "Synthesize",
    status: "running",
    createdBy: "ling_agent",
    metadata: {
      sourceIntentDecisionId: decision.id,
      sourceMessageId: source.id,
      sourceTurnId: sourceItem.turnId,
      requiredParticipantManifest: participantManifest,
      workflowGraph: graph,
      workflowGraphId: graph.id,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
      termination: graph.termination,
    },
  }, now);
  let step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    title: "Synthesis",
    prompt: "Synthesize",
    toParticipantId: "teammate_builtin_architect",
    toParticipantLabel: "Architect",
    status: "queued",
    metadata: { graphId: graph.id, graphNodeId: "synthesis", providerPresetId: providerBinding.providerPresetId, providerBinding },
  }, now);
  [step] = materializeWorkflowDelegatedStepRequirements({ store, workflow, manifest: participantManifest, now });
  const { task, run } = startFixtureStep(store, cwd, step.id, `run_synthesis_${suffix}`, now);
  step = store.getChannelWorkflowStep(step.id);
  return {
    store,
    cwd,
    workflow,
    step,
    task,
    run,
    close: async () => {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function appendToolAction(store, runId, toolCallId, toolName, args, isError) {
  store.appendEvent(runId, "tool_start", { toolCallId, toolName, args });
  store.appendEvent(runId, "tool_end", { toolCallId, toolName, isError });
}

function delegatedFinalizationCrashTrigger(boundary, workflowStepId) {
  return boundary === "step"
    ? `CREATE TRIGGER crash_delegated_step_update AFTER UPDATE OF status ON channel_workflow_steps WHEN NEW.id = '${workflowStepId}' AND NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected_delegated_finalization_crash'); END;`
    : `CREATE TRIGGER crash_delegated_step_transition AFTER INSERT ON state_transition_events WHEN NEW.entity_type = 'workflow_step' AND NEW.entity_id = '${workflowStepId}' AND NEW.event = 'succeed' BEGIN SELECT RAISE(ABORT, 'injected_delegated_finalization_crash'); END;`;
}

function delegatedFinalizationCrashTriggerName(boundary) {
  return boundary === "step" ? "crash_delegated_step_update" : "crash_delegated_step_transition";
}

function workflowCompletionCrashTrigger(boundary, workflowId) {
  return boundary === "workflow"
    ? `CREATE TRIGGER crash_workflow_completion_update AFTER UPDATE OF status ON channel_workflows WHEN NEW.id = '${workflowId}' AND NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected_workflow_completion_crash'); END;`
    : `CREATE TRIGGER crash_workflow_completion_transition AFTER INSERT ON state_transition_events WHEN NEW.entity_type = 'workflow' AND NEW.entity_id = '${workflowId}' AND NEW.event = 'all_steps_succeeded' BEGIN SELECT RAISE(ABORT, 'injected_workflow_completion_crash'); END;`;
}

function workflowCompletionCrashTriggerName(boundary) {
  return boundary === "workflow" ? "crash_workflow_completion_update" : "crash_workflow_completion_transition";
}

function appendRollbackRecoveryProbe(store, cwd, suffix, now) {
  const event = store.appendControlPlaneEvent({
    workspaceId: "workspace_default",
    cwd,
    domain: "runs",
    entityType: "run",
    entityId: `rollback_recovery_${suffix}`,
    action: "run.rollback_recovery_probe",
    data: {},
    idempotencyKey: `rollback-recovery:${suffix}`,
  }, now);
  assert.equal(event.entityId, `rollback_recovery_${suffix}`);
}

function appendBashAction(store, runId, command, result) {
  const toolCallId = `bash_${command.replaceAll(/\W+/gu, "_")}`;
  const started = store.appendEvent(runId, "tool_start", { toolCallId, toolName: "bash", args: { command } });
  store.appendEvent(runId, "tool_end", {
    toolCallId,
    toolName: "bash",
    isError: result.isError ?? (result.exitCode !== 0 || result.timedOut || result.cancelled),
    result: {
      details: {
        unifiedExec: {
          status: result.status ?? (result.exitCode === 0 && !result.timedOut && !result.cancelled ? "succeeded" : "failed"),
          command: { kind: "shell", command, shell: "bash" },
          cwd: "/workspace",
          startedAt: result.startedAt ?? started.ts,
          endedAt: result.endedAt ?? started.ts,
          durationMs: 1000,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          stdout: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          stderr: { byteCount: 0, lineCount: 0, preview: "", truncated: false },
          artifacts: [],
        },
      },
    },
  });
}

function appendLegacyPiBashAction(store, runId, command, result) {
  const toolCallId = `legacy_bash_${command.replaceAll(/\W+/gu, "_")}`;
  store.appendEvent(runId, "tool_start", { toolCallId, toolName: "bash", args: { command } });
  store.appendEvent(runId, "tool_update", {
    toolCallId,
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: result.output }] },
  });
  store.appendEvent(runId, "tool_end", {
    toolCallId,
    toolName: "bash",
    isError: result.isError,
    result: { content: [{ type: "text", text: result.output }] },
  });
}
