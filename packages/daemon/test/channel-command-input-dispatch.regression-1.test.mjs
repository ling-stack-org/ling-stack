import assert from "node:assert/strict";
import test from "node:test";
import { channelOperationPlanFingerprintV1, delegatedStepRequirementFingerprintV1 } from "@ling-stack/contracts";
import { createWorkflowOperationExecutionSnapshot } from "../dist/features/runs/workflow-operation-snapshot.js";
import { workflowOperationAuthorityRejection } from "../dist/features/runs/workflow-operation-effect-gate.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";

// Regression: inherited dependency reads must honor the actual Run read decision.
// Found by /qa on 2026-10-27
// Report: output/e6-20260928/channel-policy-command-inputs-implementation-20261027.md
// Synthetic immutable Run/step; backend availability is unrelated and stubbed.
function fixture(readDecision) {
  const sourceRefs = [{ itemId: "user", revision: 0, actorType: "local_user", quote: "run node project/cli.cjs" }];
  const command = "node project/cli.cjs";
  const scope = { kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [], policyAuthority: {
    kind: "channel_effective_policy_v1", channelId: "channel", workspaceId: "workspace", participantId: "owner",
    operationId: "op", sourceItemId: "user", sourceRevision: 0, workspaceCwd: "/workspace", executionCwd: "/workspace",
    workspaceRootIdentity: { device: "1", inode: "2" }, executionRootIdentity: { device: "1", inode: "2" },
    channelUpdatedAt: "2026-10-27T14:00:00.000Z", workspacePolicyUpdatedAt: "2026-10-27T14:00:00.000Z", policyFingerprint: "a".repeat(64),
  } };
  const operation = { id: "op", kind: "run_command", targetKind: "command", targetRef: { type: "operation", id: "op" },
    required: true, dependsOn: [], commandMatchPolicy: { kind: "exact_command", command }, binding: {
      schemaVersion: 1, ownerParticipantId: "owner", sourceRefs, inputRefs: [{ path: "project/cli.cjs", sourceRefs }],
      outputRefs: [], commandInputScope: scope,
      effectScope: { readPaths: ["project/cli.cjs"], writePaths: [], exactCommands: [command], allowEnvironmentAccess: false, allowNetworkAccess: false },
    } };
  const plan = { bindingVersion: 1, operations: [operation], fingerprint: channelOperationPlanFingerprintV1([operation]) };
  const requirement = { schemaVersion: 1, workflowId: "workflow", workflowStepId: "step", participantId: "owner",
    participantManifestFingerprint: "manifest", executionPlanFingerprint: plan.fingerprint, expectedOutcome: "execution",
    requiredOperationIds: ["op"], requiredDependencyStepIds: [], acceptedEvidenceKinds: ["execution_action"] };
  requirement.fingerprint = delegatedStepRequirementFingerprintV1(requirement);
  const step = { id: "step", workflowId: "workflow", toParticipantId: "owner", runId: "run", metadata: {
    executionPlan: plan, executionOperationIds: ["op"], delegatedRequirement: requirement } };
  const run = { id: "run", status: "running", cwd: "/workspace", channelId: "channel", teammateId: "owner", workflowStepId: "step",
    requestSnapshot: { workflowOperationExecution: createWorkflowOperationExecutionSnapshot(step), delegatedRequirement: requirement,
      effectivePolicySnapshot: { toolDecisions: { read: readDecision } } } };
  const store = { paths: { cwd: "/workspace" }, getRun: () => run, getChannelWorkflowStep: () => step };
  const runtime = new NativeRestrictedCommandRuntime({ inputHelper: {}, executables: {} });
  runtime.assertAvailable = () => ({ kind: "argv", argv: ["node", "project/cli.cjs"] });
  return { run, store, runtime, command };
}
for (const decision of ["ask", "deny", undefined]) test(`Run read=${decision} cannot inherit dependency reads`, () => {
  const f = fixture(decision);
  const result = workflowOperationAuthorityRejection({ store: f.store, run: f.run,
    request: { toolName: "bash", input: { command: f.command }, cwd: "/workspace" }, restrictedCommandRuntime: f.runtime });
  assert.equal(result?.code, "restricted_command_input_read_not_allowed");
});
