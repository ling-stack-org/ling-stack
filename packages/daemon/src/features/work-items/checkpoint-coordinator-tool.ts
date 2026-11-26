import {
  checkpointCoordinationRequestKey, digestHarnessToolValue, LING_AGENT_ID, redactSecrets, stageCoordinationToolReceiptId,
  type HostOperationSource, type RunSession, type RunStore, type WorkItem, type WorkItemCheckpointToolReceipt,
} from "@ling-stack/core";
import type { PiRunnerRunOptions, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import { normalizeWorkspaceRoot } from "../../runtime/store-registry.js";
import { coordinationDecisionInput, registerCoordinationDecision } from "../../server/app-server-deliberation.js";
import type { AppServerDeliberationPolicy } from "../../server/app-server-deliberation-config.js";
import { listEffectiveChannelAiTeammates } from "../channels/channel-teammate-availability.js";
import { readCheckpointChannelEvidence } from "./checkpoint-channel-evidence.js";
import { readWorkItemWorkflowBinding, readWorkItemWorkflowStages } from "./workflow-stages.js";

const workItemId = coordinationDecisionInput.shape.workItemId;
const offset = z.number().int().nonnegative().default(0);
const checkpointInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("read_checkpoints"), workItemId: workItemId.optional(), stageOffset: offset, afterEvidenceSequence: offset }),
  z.strictObject({ action: z.literal("submit_decision"), workItemId, decision: coordinationDecisionInput.omit({ workItemId: true, idempotencyKey: true }) }),
]);

export function readCoordinatorWorkItems(store: RunStore, source: Pick<RunSession, "threadId" | "teammateId">): (WorkItem & { planRevision: string; channelId: string })[] {
  const { threadId } = source;
  if (source.teammateId !== LING_AGENT_ID || !threadId) return [];
  const thread = store.getLingThread(threadId);
  const channelId = thread?.channelId;
  if (thread?.kind !== "channel_discussion" || !channelId || thread.status === "archived" || thread.archivedAt
    || store.getLingThreadConversationMode(threadId)?.mode === "plan") return [];
  return store.listProposedPlanArtifacts({ threadId, statuses: ["accepted"], limit: 50 }).flatMap(plan => {
    const workflowId = plan.acceptedWorkflowId;
    const binding = workflowId && readWorkItemWorkflowBinding(store, workflowId);
    if (!binding || binding.threadId !== threadId || binding.planId !== plan.id) return [];
    const item = store.getWorkItem(binding.workItemId);
    const planRevision = `${plan.id}:${binding.planRevision}`;
    const successor = plan.supersededByPlanId ? store.getProposedPlanArtifact(plan.supersededByPlanId) : undefined;
    return item && item.channelId === channelId && item.workflowId === workflowId && item.planRevision === planRevision
      && !(successor?.status === "accepted" && successor.acceptedWorkflowId)
      && item.control.state === "active" && !item.control.unresolvedEffectIds.length
      && !["done", "cancelled", "archived", "superseded"].includes(item.status) ? [{ ...item, planRevision, channelId }] : [];
  });
}

export function createCheckpointCoordinatorTool(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly source: HostOperationSource;
  readonly assertCurrent: () => void;
  readonly planRevisions: readonly string[];
  readonly policies: readonly AppServerDeliberationPolicy[];
  readonly extraSecrets: readonly (string | undefined)[];
}): NonNullable<PiRunnerRunOptions["onWorkItemCoordinationCall"]> {
  const { store, run, source, extraSecrets } = input;
  const threadId = run.threadId!;
  const cwd = normalizeWorkspaceRoot(store.paths.cwd);
  const redactText = (text: string) => String(redactSecrets(text, extraSecrets));
  const result = (value: unknown): PiRunnerToolHandledResult =>
    ({ content: [{ type: "text", text: JSON.stringify(redactSecrets(value, extraSecrets)) }] });
  const readCurrent = () => {
    input.assertCurrent();
    return readCoordinatorWorkItems(store, run).filter(item => input.planRevisions.includes(item.planRevision));
  };
  const assertScope = (id: string, planRevision: string | undefined) => {
    if (!readCurrent().some(item => item.id === id && item.planRevision === planRevision)) {
      throw new HttpError(409, "stale_revision", "This decision is outside the coordinator's current Work Item and accepted Plan.");
    }
  };
  return ({ toolCallId, input: raw }) => {
    input.assertCurrent();
    const safeInput = redactSecrets(raw ?? null, extraSecrets);
    const requestDigest = digestHarnessToolValue(safeInput);
    const recordId = stageCoordinationToolReceiptId(run.id, source.attemptId, toolCallId);
    const prior = store.getAppServerState("work_item_stage_tool_receipt", recordId)?.payload as WorkItemCheckpointToolReceipt | undefined;
    if (prior && (prior.scope !== "coordinator" || prior.requestDigest !== requestDigest)) {
      return result({ status: "rejected", code: "idempotency_conflict" });
    }
    const now = new Date().toISOString();
    const metadata = { source, threadId, toolCallId, requestDigest };
    const remember = (outcome: WorkItemCheckpointToolReceipt["outcome"]) => {
      if (prior) return;
      const payload = { ...metadata, scope: "coordinator", outcome } satisfies WorkItemCheckpointToolReceipt;
      if (!store.putAppServerState({ kind: "work_item_stage_tool_receipt", recordId, expectedRevision: 0, payload }, now)) {
        throw new Error("The coordinator tool receipt changed before commit.");
      }
    };
    const reject = (code: string) => {
      const outcome = { status: "rejected", code } as const;
      remember(outcome);
      return result(outcome);
    };
    if (prior?.outcome.status === "rejected") return result(prior.outcome);
    const parsed = checkpointInput.safeParse(safeInput);
    if (!parsed.success) return reject("invalid_params");
    const request = parsed.data;
    try {
      if (request.action === "read_checkpoints") {
        const snapshot = store.readSnapshot(() => {
          const items = readCurrent();
          const item = items.find(entry => entry.id === request.workItemId);
          if (!item) return { workItems: items.map(entry => ({ workItemId: entry.id, planRevision: entry.planRevision })) };
          const rounds = store.listOpenScheduledCoordinationRounds().filter(round => round.workItemId === item.id && round.kind === "checkpoint"
            && round.controlGeneration === item.control.generation && round.deadlineAt > now && store.getCurrentScheduledCoordinationAutomationDigest(round.recordId));
          const evidence = store.listWorkItemEvidence({ workItemId: item.id, afterSequence: request.afterEvidenceSequence, limit: 20 });
          const stages = readWorkItemWorkflowStages(store, item, false, request.stageOffset);
          const channel = store.getChannel(item.channelId);
          return {
            workItemId: item.id, workItemRevision: item.revision, planRevision: item.planRevision,
            stages: stages && { status: stages.status, nextOffset: stages.nextOffset,
              steps: stages.steps.map(({ stepId, stageId, status, dependencyIds }) => ({ stepId, stageId, status, dependencyIds })) },
            checkpoints: rounds.map(round => ({ roundId: round.recordId })),
            participants: channel ? listEffectiveChannelAiTeammates(store, channel).slice(0, 50)
              .map(({ id, roleKey }) => ({ id, role: roleKey })) : [],
            evidence: readCheckpointChannelEvidence(store, threadId, item.channelId,
              evidence.filter(entry => entry.subjectRevision === item.planRevision)).map(entry => ({
              id: entry.id, kind: entry.kind, summary: redactText(entry.content).slice(0, 500),
            })),
            nextAfterEvidenceSequence: evidence.length === 20 ? evidence.at(-1)?.sequence : undefined,
          };
        });
        remember({ status: "read" });
        return result(snapshot);
      }
      const { workItemId: id, decision } = request;
      const assertDecisionInputs = () => assertScope(id, decision.subject.planRevision);
      assertDecisionInputs();
      const idempotencyKey = checkpointCoordinationRequestKey(run.id, source.attemptId, toolCallId);
      const saved = registerCoordinationDecision(store, { ...decision, workItemId: id, idempotencyKey }, now,
        cwd, input.policies, { ...metadata, assertCurrent: assertDecisionInputs });
      return result(saved.receipt);
    } catch (error) {
      if (error instanceof HttpError) return reject(error.code);
      if (error instanceof Error && ["coordination_subject_unavailable", "coordination_round_stale", "coordination_decision_limit",
        "coordination_decision_idempotency_conflict"].includes(error.message)) return reject(error.message);
      throw error;
    }
  };
}
