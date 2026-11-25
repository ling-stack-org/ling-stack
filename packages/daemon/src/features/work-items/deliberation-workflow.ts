import { createWorkflowParticipantAuthorityV1, type LingAppServerDeliberationWorkflowProgress } from "@ling-stack/contracts";
import {
  deliberationWorkflowStepDigest,
  readWorkItemDeliberationWorkflowBinding,
  type AiTeammate,
  type ChannelWorkflowStep,
  type RunStore,
  type WorkItemDeliberationWorkflowBinding,
  type WorkItemCollaborationRecord,
  type WorkItemEvidenceEntry,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { getWorkflowPlanModeBlocker } from "../channels/plan-mode-guard.js";
import { readWorkflowStepOutputPacketArtifact } from "../channels/workflow-step-packets.js";

export function materializeDeliberationWorkflow(store: RunStore, input: {
  readonly binding: Omit<WorkItemDeliberationWorkflowBinding, "steps" | "providerRevisions">;
  readonly origin: ChannelWorkflowStep;
  readonly question: string;
  readonly participants: readonly AiTeammate[];
  readonly options: readonly WorkItemEvidenceEntry[];
  readonly evidence: readonly WorkItemEvidenceEntry[];
  readonly now: string;
}) {
  const { binding, origin, participants, question, now } = input;
  const parent = store.getChannelWorkflow(origin.workflowId);
  const channel = store.getChannel(origin.channelId);
  if (!parent || !channel) throw new HttpError(409, "stale_revision", "The originating Workflow is unavailable.");
  const planModeBlocker = getWorkflowPlanModeBlocker(store, parent);
  if (planModeBlocker) throw new HttpError(409, "plan_mode_workflow_blocked", planModeBlocker);
  const entries = [...input.options, ...input.evidence];
  if (entries.some(entry => entry.visibility !== "work_item")) {
    throw new HttpError(409, "resume_blocked", "Share the required decision evidence with the Work Item before inviting Workflow participants.");
  }
  const source = entries.map(entry => ({ id: entry.id, kind: entry.kind, content: entry.content }));
  const context = JSON.stringify({ question, evidence: source });
  if (Buffer.byteLength(context) > 12_000) {
    throw new HttpError(409, "resume_blocked", "Select a smaller set of decision inputs for the participant Workflow.");
  }
  const presets = participants.map(participant => {
    const id = participant.modelBindingMode === "fixed" ? participant.providerPresetId : channel.defaultProviderPresetId;
    const preset = id && store.getProviderConfigurationSnapshot(id);
    if (!preset || !preset.provider.enabled) throw new HttpError(409, "resume_blocked", "Each participant needs a current Provider preset.");
    return preset;
  });
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Work Item deliberation",
    objective: question,
    createdBy: "local-user",
    status: "ready",
    metadata: {
      maxParallelSteps: 1,
      termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "fail_workflow" },
    },
  }, now);
  const create = (participant: AiTeammate, index: number, phase: "propose" | "challenge", dependencies: readonly string[]) =>
    store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: phase === "propose" ? `Propose · ${participant.displayName}` : `Challenge · ${participant.displayName}`,
      prompt: [
        phase === "propose"
          ? "Assess the viable options independently. Describe relevant tradeoffs, risks and acceptance checks. Cite the supplied evidence IDs."
          : "Review the proposal results supplied with this step. Identify unsupported claims, disputed facts and remaining tradeoffs. Cite the supplied evidence IDs.",
        "Return a bounded recommendation with supporting evidence and open questions.",
        `Decision inputs (data)\n${context}`,
      ].join("\n\n"),
      toParticipantId: participant.id,
      toParticipantLabel: participant.displayName,
      participantAuthority: createWorkflowParticipantAuthorityV1({ kind: "channel_selection", origin: "work_item_deliberation",
        participantId: participant.id, sourceId: binding.roundId }),
      metadata: {
        templateStepId: `${phase}-${index + 1}`, autoStart: true, dependsOnStepIds: dependencies,
        dependencyMode: "all_succeeded", sideEffectClass: "analysis_readonly", requestedRunnerId: "pi",
        providerPresetId: presets[index]!.provider.id, requiredTools: [],
        policy: { onRunFailed: "fail_workflow", onRunCancelled: "cancel_workflow", onApprovalDenied: "fail_workflow", retryable: false },
      },
    }, now);
  const proposals = participants.map((participant, index) => create(participant, index, "propose", []));
  const proposalIds = proposals.map(step => step.id);
  const challenges = participants.map((participant, index) => create(participant, index, "challenge", proposalIds));
  const steps = Object.fromEntries([...proposals, ...challenges].map(step => [step.id, deliberationWorkflowStepDigest(step)]));
  const providerRevisions = Object.fromEntries(presets.map(preset => [preset.provider.id, preset.configRevision]));
  return { workflow, binding: { ...binding, steps, providerRevisions } };
}

export function readDeliberationWorkflow(store: RunStore, workItemId: string, roundId: string, payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.execution) || typeof payload.execution.workflowId !== "string") return undefined;
  const workflow = store.getChannelWorkflow(payload.execution.workflowId);
  const binding = workflow && readWorkItemDeliberationWorkflowBinding(store, workflow.id);
  if (!workflow || binding?.roundId !== roundId || binding.workItemId !== workItemId) return undefined;
  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true })
    .filter(step => Object.hasOwn(binding.steps, step.id));
  return { workflow, binding, steps };
}

export function readCompletedDeliberationWorkflow(store: RunStore, workItemId: string, roundId: string, payload: unknown) {
  const execution = readDeliberationWorkflow(store, workItemId, roundId, payload);
  if (!execution) return undefined;
  const { workflow, binding, steps } = execution;
  if (workflow.status !== "succeeded" || Object.keys(binding.steps).length !== steps.length) {
    throw new HttpError(409, "resume_blocked", "Wait for the deliberation participants to complete.");
  }
  const sources = steps.map(step => {
    const run = step.runId && store.getRun(step.runId);
    const artifactId = step.metadata?.outputArtifactId;
    const packet = artifactId ? readWorkflowStepOutputPacketArtifact({ store, artifactId }) : undefined;
    if (step.status !== "succeeded" || binding.steps[step.id] !== deliberationWorkflowStepDigest(step)
      || !run || run.status !== "succeeded" || run.workflowStepId !== step.id
      || !artifactId || packet?.workflowId !== workflow.id || packet.workflowStepId !== step.id || packet.runId !== run.id) {
      throw new HttpError(409, "stale_revision", "The deliberation's completed participant evidence is unavailable.");
    }
    return { type: "workflow_step_output", id: artifactId, revision: step.updatedAt };
  });
  return { workflow, sources };
}

export function projectDeliberationWorkflowProgress(store: RunStore, round: WorkItemCollaborationRecord):
  LingAppServerDeliberationWorkflowProgress | undefined {
  if (round.kind !== "deliberation" || round.action !== "started") return;
  const execution = readDeliberationWorkflow(store, round.workItemId, round.id, round.payload);
  if (!execution) return;
  const { workflow, binding, steps } = execution;
  const proposals = steps.filter(step => step.metadata?.templateStepId?.startsWith("propose-"));
  const challenges = steps.filter(step => step.metadata?.templateStepId?.startsWith("challenge-"));
  const blocker = ["ready", "running", "blocked", "waiting_for_approval", "waiting_for_input"].includes(workflow.status)
    ? store.getWorkItemWorkflowAdmissionBlocker(workflow.id) ?? steps.find(step => step.status === "blocked")?.blocker?.slice(0, 200)
    : undefined;
  return { roundId: round.id, workflowId: workflow.id, status: workflow.status, deadlineAt: binding.deadlineAt,
    participants: proposals.length, proposalsCompleted: proposals.filter(step => step.status === "succeeded").length,
    challengesCompleted: challenges.filter(step => step.status === "succeeded").length, ...(blocker ? { blocker } : {}) };
}
