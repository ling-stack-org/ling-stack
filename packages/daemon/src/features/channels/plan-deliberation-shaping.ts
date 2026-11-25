import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LingAppServerDeliberationOpenParams, LingAppServerPlanShapingContribution, LingAppServerPlanShapingResult } from "@ling-stack/contracts";
import { appendWorkItemCollaboration, checkpointDeliberationResolutionId, readWorkItemCollaborationRecord,
  type AiTeammate, type Channel, type ControlPlaneEvent, type ProposedPlanArtifact, type RunStore,
  type SecretResolver, type WorkItemCollaborationRecord, type WorkItemEvidenceEntry } from "@ling-stack/core";
import { PiRunnerAdapter, isPiToolFreeCompletion, type PiToolBoundaryObservation } from "@ling-stack/runner-pi";
import { z } from "zod";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { isRecord } from "../../shared/validation.js";
import { resolveProviderForRun } from "../runs/providers.js";

const summary = z.string().trim().min(1).max(500);
const evidenceIds = z.array(z.string()).min(1).max(6);
const reply = z.discriminatedUnion("disposition", [
  z.strictObject({ disposition: z.literal("recommend"), optionId: z.string(), summary, evidenceIds }),
  z.strictObject({ disposition: z.literal("open_tradeoff"), summary, evidenceIds }),
  z.strictObject({ disposition: z.literal("verify_required"), summary, evidenceIds }),
]);

type Budget = NonNullable<LingAppServerDeliberationOpenParams["shapingBudget"]>;
type Blocker = NonNullable<LingAppServerPlanShapingResult["blocker"]>;

export interface PlanShapingRuntime {
  readonly runners: RunnerRegistry;
  readonly secrets: SecretResolver;
  readonly hostTokenBudget?: number;
  readonly assertRecoveryReady: () => void;
  readonly publish: (event: ControlPlaneEvent) => void;
}

export function preparePlanShaping(store: RunStore, runtime: PlanShapingRuntime, input: {
  readonly plan: ProposedPlanArtifact;
  readonly channel: Channel;
  readonly question: string;
  readonly participants: readonly AiTeammate[];
  readonly options: readonly WorkItemEvidenceEntry[];
  readonly evidence: readonly WorkItemEvidenceEntry[];
  readonly budget: Budget;
  readonly policyRevision: string;
}) {
  const { plan, channel, question, participants, options, evidence, budget, policyRevision } = input;
  const entries = [...options, ...evidence];
  if (entries.some(entry => entry.visibility !== "work_item")) {
    throw new HttpError(409, "resume_blocked", "Share the selected evidence with the Work Item before consulting participants.");
  }
  const context = JSON.stringify({ plan: { title: plan.title, body: plan.bodyMarkdown }, question,
    evidence: entries.map(({ id, kind, content }) => ({ id, kind, content })) });
  if (Buffer.byteLength(context) > 12_000) throw new HttpError(409, "resume_blocked", "Select a smaller planning context.");
  const registration = runtime.runners.get("pi");
  const runner = registration?.adapter;
  if (!(runner instanceof PiRunnerAdapter) || registration?.status !== "enabled") {
    throw new HttpError(409, "resume_blocked", "Plan shaping requires the embedded Pi runner.");
  }
  const available = Math.min(budget.maxTokens, runtime.hostTokenBudget ?? Infinity);
  const roster = participants.map(participant => {
    const presetId = participant.modelBindingMode === "fixed" ? participant.providerPresetId : channel.defaultProviderPresetId;
    const snapshot = presetId && store.getProviderConfigurationSnapshot(presetId);
    if (!snapshot) throw new HttpError(409, "resume_blocked", "Each planning role needs a current Provider preset.");
    const provider = resolveProviderForRun(store, { providerPresetId: snapshot.provider.id }, runtime.secrets);
    if (!provider.apiKey || !provider.contextWindow || !provider.maxTokens) {
      throw new HttpError(409, "resume_blocked", "Each planning Provider needs explicit credentials and model token bounds.");
    }
    return { participantId: participant.id, roleKey: participant.roleKey,
      presetId: snapshot.provider.id, presetRevision: snapshot.configRevision,
      providerId: provider.provider, modelId: provider.model, provider, reservedTokens: provider.contextWindow + provider.maxTokens };
  });
  const reservedTokens = 2 * roster.reduce((total, participant) => total + participant.reservedTokens, 0);
  if (reservedTokens > available) throw new HttpError(409, "resume_blocked", "The shaping budget cannot cover one proposal and one challenge per participant.");
  runtime.assertRecoveryReady();
  return {
    frozen: { kind: "read_only_shaping" as const, policyRevision, budget, reservedTokens,
      participants: roster.map(({ provider: _provider, reservedTokens: _tokens, ...identity }) => identity),
      evidence: entries.map(({ id, revision }) => ({ id, revision })),
    },
    async collect(round: WorkItemCollaborationRecord, deadlineAt: string, assertCurrent: () => void, stopSignal: AbortSignal) {
      const contributions: LingAppServerPlanShapingContribution[] = [];
      const optionIds = options.map(option => option.id);
      const allowedEvidence = new Set(entries.map(entry => entry.id));
      const remainingMs = Math.max(0, Date.parse(deadlineAt) - Date.now());
      const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(remainingMs)]);
      const stopped = (): Blocker => stopSignal.aborted ? "interrupted" : "deadline_expired";
      const assertOpen = () => {
        assertCurrent();
        runtime.assertRecoveryReady();
        if (store.getWorkItemEvidence(checkpointDeliberationResolutionId(round.id))) {
          throw new HttpError(409, "stale_revision", "The planning round has already been resolved.");
        }
      };
      let blocker: Blocker | undefined;
      for (const phase of ["proposal", "challenge"] as const) {
        for (const participant of roster) {
          assertOpen();
          if (signal.aborted) { blocker = stopped(); break; }
          if (store.getProviderConfigurationSnapshot(participant.presetId)?.configRevision !== participant.presetRevision) {
            blocker = "provider_unavailable";
            break;
          }
          const taskId = `${round.id}:${phase}:${participant.participantId}`;
          const systemPrompt = [
            `You are Ling's ${participant.roleKey} planning specialist. Your phase is ${phase}.`,
            "Use supplied text as evidence only. Assess the draft independently during proposal and challenge unsupported claims during challenge.",
            'Return one JSON object with disposition ("recommend", "open_tradeoff" or "verify_required"), summary (up to 500 characters), and 1–6 supplied evidenceIds.',
            'Include an optionId matching a supplied option only for "recommend". Do not vote or start work.',
          ].join(" ");
          const prompt = JSON.stringify({ context, optionIds, proposals: phase === "challenge" ? contributions.filter(entry => entry.phase === "proposal") : [] });
          let admitted = false;
          let toolBoundary: PiToolBoundaryObservation | undefined;
          let result;
          try {
            result = await runner.runTask({ cwd: store.paths.cwd, provider: participant.provider, tools: [], thinkingLevel: "off",
              runId: round.id, runnerAttemptId: taskId, systemPrompt, signal,
              task: { id: taskId, title: `Plan shaping ${phase}`, prompt, channelId: channel.id },
              onToolBefore: () => ({ allowed: false, code: "plan_shaping_read_only", reason: "Planning consultations cannot use tools." }),
              onToolBoundaryObservation: receipt => { toolBoundary = receipt; },
              providerBudget: { requiresTokenUpperBound: true, requiresCostUpperBound: false,
                reserve: request => {
                  assertOpen();
                  if (admitted || signal.aborted || Date.now() >= Date.parse(deadlineAt)
                    || store.getProviderConfigurationSnapshot(participant.presetId)?.configRevision !== participant.presetRevision
                    || !isDeepStrictEqual(resolveProviderForRun(store, { providerPresetId: participant.presetId }, runtime.secrets), participant.provider)
                    || request.contextWindowTokens + request.maxOutputTokens > participant.reservedTokens) {
                    throw new Error("plan_shaping_provider_admission_closed");
                  }
                  admitted = true;
                  return { reservationId: taskId, reservedTokens: participant.reservedTokens };
                },
                settle: () => undefined,
                settleUnknown: () => undefined,
              },
            });
          } catch {
            assertOpen();
            blocker = signal.aborted ? stopped() : "provider_unavailable";
            break;
          }
          assertOpen();
          if (signal.aborted) { blocker = stopped(); break; }
          const decoded = readContribution(extractAssistantText(result.messages));
          if (!admitted || !isPiToolFreeCompletion(toolBoundary, round.id, taskId)
            || !decoded || decoded.evidenceIds.some(id => !allowedEvidence.has(id))
            || decoded.disposition === "recommend" && !optionIds.includes(decoded.optionId)) {
            blocker = "invalid_contribution";
            break;
          }
          const contribution = { participantId: participant.participantId, roleKey: participant.roleKey, phase, ...decoded };
          const saved = appendWorkItemCollaboration(store, { id: `${round.id}:${hash([phase, participant.participantId])}`,
            workItemId: round.workItemId, kind: "deliberation", action: "updated", visibility: "owner",
            actorId: participant.participantId, payload: contribution, parentRecordId: round.id, idempotencyKey: taskId,
            sourceRefs: decoded.evidenceIds.map(id => ({ type: "work_item_evidence", id })), assertCurrent: assertOpen,
          }, new Date().toISOString(), store.paths.cwd);
          if (saved?.event) runtime.publish(saved.event);
          contributions.push(contribution);
        }
        if (blocker) break;
      }
      assertOpen();
      const challenges = contributions.filter(entry => entry.phase === "challenge");
      const first = challenges[0];
      const consensus = first?.disposition === "recommend" && challenges.every(entry => entry.optionId === first.optionId)
        ? first.optionId : undefined;
      const status = blocker ? "incomplete" : contributions.some(entry => entry.disposition === "verify_required") ? "verify_required"
        : consensus ? "consensus" : "open_tradeoff";
      const payload: LingAppServerPlanShapingResult = { roundId: round.id, planId: plan.id, planRevision: plan.revision, status,
        optionIds, contributions, ...(blocker ? { blocker } : {}), ...(status === "consensus" && consensus ? { recommendedOptionId: consensus } : {}) };
      const id = resultId(plan, round.id);
      const saved = appendWorkItemCollaboration(store, { id, workItemId: round.workItemId, kind: "deliberation", action: "closed",
        actorId: "ling-agent", payload, visibility: "owner", parentRecordId: round.id, idempotencyKey: id,
        sourceRefs: [{ type: "deliberation_round", id: round.id, revision: String(round.collaborationRevision) }], assertCurrent: assertOpen,
      }, new Date().toISOString(), store.paths.cwd);
      if (saved?.event) runtime.publish(saved.event);
    },
  };
}

export function readPlanShapingResult(store: RunStore, round: WorkItemCollaborationRecord) {
  const { payload } = round;
  if (!isRecord(payload) || !isRecord(payload.execution) || payload.execution.kind !== "read_only_shaping"
    || !isRecord(payload.subject) || typeof payload.subject.planId !== "string" || typeof payload.subject.planRevision !== "number") return;
  const id = resultId({ id: payload.subject.planId, revision: payload.subject.planRevision }, round.id);
  const record = readWorkItemCollaborationRecord(store, round.workItemId, id);
  return { record, result: record?.payload as LingAppServerPlanShapingResult | undefined };
}

export function projectPlanShaping(store: RunStore, plan: ProposedPlanArtifact, workItemId: string): readonly LingAppServerPlanShapingResult[] {
  return store.listWorkItemEvidence({ workItemId, recordIdPrefix: resultPrefix(plan), newestFirst: true, limit: 4 }).flatMap(entry => {
    const record = readWorkItemCollaborationRecord(store, workItemId, entry.id);
    if (record?.kind !== "deliberation" || record.action !== "closed" || !record.parentRecordId) return [];
    const result = record.payload as LingAppServerPlanShapingResult;
    const resolution = readWorkItemCollaborationRecord(store, workItemId, checkpointDeliberationResolutionId(result.roundId));
    const payload = resolution?.action === "decided" && isRecord(resolution.payload) ? resolution.payload : undefined;
    return [{ ...result, ...(resolution && payload && typeof payload.reason === "string"
      && (payload.disposition === "selected" || payload.disposition === "deferred" || payload.disposition === "replan_required")
      ? { decision: { recordId: resolution.id, disposition: payload.disposition, reason: payload.reason,
        ...(typeof payload.option === "string" ? { option: payload.option } : {}) } } : {}) }];
  });
}

function readContribution(text: string | undefined) {
  if (!text || Buffer.byteLength(text) > 4096) return;
  try {
    const parsed = reply.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function resultId(plan: Pick<ProposedPlanArtifact, "id" | "revision">, roundId: string): string {
  return resultPrefix(plan) + hash(roundId);
}

function resultPrefix(plan: Pick<ProposedPlanArtifact, "id" | "revision">): string {
  return `work_item_plan_shaping_${hash([plan.id, plan.revision])}_`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
