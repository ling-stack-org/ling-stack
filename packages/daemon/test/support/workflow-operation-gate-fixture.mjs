import { channelOperationPlanFingerprintV1 } from "../../../contracts/dist/index.js";
import { createDelegatedStepRequirement } from "../../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../../dist/features/runs/workflow-operation-snapshot.js";

export const gateOwner = "teammate_builtin_engineer";

export function typedOperation(kind, path, id = "operation", dependsOn = []) {
  const sourceRefs = [{ itemId: "source", quote: "Explicit operation fixture" }];
  const writes = kind === "file_create" || kind === "file_edit";
  const command = kind === "run_command";
  const readPaths = kind === "file_read" || kind === "file_edit" || kind === "open_local_target" ? [path] : [];
  return {
    id, kind, targetKind: command ? "command" : "file",
    targetRef: { type: "operation", id: "target:" + id, label: path },
    required: true, dependsOn,
    ...(command ? { commandMatchPolicy: { kind: "exact_command", command: path } } : {}),
    binding: {
      schemaVersion: 1, ownerParticipantId: gateOwner, sourceRefs,
      inputRefs: readPaths.map((path) => ({ path, sourceRefs })),
      outputRefs: writes ? [{ path, sourceRefs }] : [],
      ...(writes ? { contentSource: { kind: "generated_objective", text: "Create requested output", inputOperationIds: [], sourceRefs } } : {}),
      effectScope: { readPaths, writePaths: writes ? [path] : [], exactCommands: command ? [path] : [], allowEnvironmentAccess: false, allowNetworkAccess: false },
    },
  };
}

export function createTypedWorkflowBasis(store, cwd, operations, now) {
  const channel = store.createChannel({ name: "Typed effect gate", boundPath: cwd }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Typed effects", objective: "Bound effects", status: "running", createdBy: "ling_agent" }, now);
  const plan = { bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations) };
  let step = store.createChannelWorkflowStep({
    workflowId: workflow.id, title: "Bound effects", prompt: "Execute only bound effects",
    toParticipantId: gateOwner, toParticipantLabel: "Engineer", status: "running",
    metadata: { executionPlan: plan, executionOperationIds: operations.map((operation) => operation.id) },
  }, now);
  const requirement = createDelegatedStepRequirement({ workflow, step, participant: { expectedOutcome: "execution" }, manifestFingerprint: "manifest:effect-gate" });
  step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
  return { channel, workflow, step, requirement, snapshot: createWorkflowOperationExecutionSnapshot(step) };
}
