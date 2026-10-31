import { createScopedLearningCandidate } from "./scoped-candidates.js";
import { toRuntimeAttemptFence, type RunStore, type SecretResolver, type LearningReviewJob,
  type ControlPlaneEvent, type RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import { startRuntimeWorkUnit, transitionWorkUnitCancelled, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { processProcedureObservationJobWithinTransaction } from "../skills/procedure-observation-service.js";
import { runMemoryConsolidationJob } from "../memory/consolidation.js";
import { captureDecisionLearningEvidence, captureLearningEvidence, learningEvidenceCurrent } from "./evidence.js";
import { executeLearningModel, prepareLearningModelRequest } from "./model.js";
import { parseLearningDraft, type LearningDraft } from "./extractor.js";

export interface LearningReviewCoordinatorOptions {
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly secretResolver: SecretResolver;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly scanIntervalMs?: number;
  /** Host-only test seam. Production always uses the isolated one-request HTTP transport. */
  readonly extract?: (input: { readonly job: LearningReviewJob; readonly prompt: string; readonly signal: AbortSignal }) => Promise<LearningDraft>;
}
export function foregroundWorkActive(store: RunStore): boolean {
  return (["claimed", "running"] as const).some(status => store.listWorkUnits({ status, limit: 100 })
    .some(unit => unit.kind !== "learning_review"));
}

function learningGenerationAllowed(store: RunStore, job: LearningReviewJob): boolean {
  const governance = store.getWorkspaceSettings().skillGovernancePolicy;
  return governance.generationMode !== "off" && (job.mode !== "explicit" || governance.recordingMode === "user_initiated");
}

/** Source/policy checks and candidate publication share one synchronous owning transaction. */
export function commitLearningDraft(input: { readonly store: RunStore; readonly job: LearningReviewJob;
  readonly fence: RuntimeAttemptFenceV1; readonly draft: LearningDraft; readonly hub: ControlPlaneEventHub }): LearningReviewJob {
  const { store, job, fence, hub } = input;
  const events: ControlPlaneEvent[] = [];
  const result = store.withProcedureObservationJobTransaction(writer => {
    if (!learningEvidenceCurrent(store, job.evidence) || foregroundWorkActive(store)) throw new Error("learning_source_or_foreground_changed");
    if (!learningGenerationAllowed(store, job)) throw new Error("learning_generation_disabled");
    // Also validate Host/test adapter output; the returned object cannot mint an entitlement.
    const draft = parseLearningDraft(JSON.stringify(input.draft), job.evidence);
    const ids: string[] = [];
    let reason: string | undefined;
    if (draft.kind === "none") reason = draft.reason;
    else if (draft.kind === "memory") {
      const evidence = job.evidence;
      const sourceRefs = [{ type: evidence.decisionId ? "decision" as const : "run-event" as const,
        id: evidence.decisionId ?? draft.evidence.evidenceId, label: `Evidence ${evidence.decisionId ?? evidence.runId}` }];
      const scopeType = evidence.taskId ? "task" : evidence.channelId ? "channel" : evidence.teammateId ? "teammate" : "run";
      const ownerId = evidence.taskId ?? evidence.channelId ?? evidence.teammateId ?? evidence.runId;
      if (!ownerId) throw new Error("learning_source_scope_unavailable");
      const consolidated = runMemoryConsolidationJob(store, { kind: evidence.decisionId ? "channel_decision_summary" : evidence.taskId ? "task_run_lesson" : "private_chat_summary",
        sourceKind: evidence.decisionId ? "channel_decision" : evidence.taskId ? "task_run_summary" : "private_chat",
        confidence: "medium", candidate: { scopeType, ownerId,
          title: draft.title, body: draft.body, sourceRefs, sensitivity: job.evidence.channelId ? "normal" : "private" } }, new Date().toISOString());
      ids.push(...consolidated.candidates.map(candidate => candidate.id));
      events.push(writer.appendControlPlaneEvent({ workspaceId: job.workspaceId, cwd: store.paths.cwd, domain: "memory",
        entityType: "memory", entityId: consolidated.candidates[0]!.id, action: "memory.changed",
        idempotencyKey: `learning-memory:${job.id}`, data: { jobId: job.id, reviewState: "candidate" } }, new Date().toISOString()));
    } else if (draft.destination !== "skill") {
      const id = createScopedLearningCandidate(store, job, draft, new Date().toISOString());
      ids.push(id); reason = `${draft.destination}_draft_created`;
      events.push(writer.appendControlPlaneEvent({ workspaceId: job.workspaceId, cwd: store.paths.cwd,
        domain: "skills", entityType: "channel", entityId: job.evidence.channelId!, action: "channel.learning_draft_created",
        idempotencyKey: `learning-scoped:${job.id}`, data: { jobId: job.id, candidateId: id, destination: draft.destination } }, new Date().toISOString()));
    } else {
      const correction = job.evidence.items.some(item => item.kind === "correction");
      const outcome = processProcedureObservationJobWithinTransaction({ store, controlPlaneEvents: hub, cwd: store.paths.cwd,
        now: new Date().toISOString(), committedEvents: { events, appendEvent: writer.appendControlPlaneEvent, workspaceId: job.workspaceId },
        job: { learningReviewJobId: job.id, workspaceId: job.workspaceId, runId: job.evidence.runId, effectiveAttemptId: job.evidence.sourceAttemptId,
          evidenceVersion: job.evidence.digest, taskId: job.evidence.taskId, channelId: job.evidence.channelId,
          teammateId: job.evidence.teammateId, selectedSkillId: job.evidence.selectedSkillId,
          source: correction ? "user_correction" : job.mode === "explicit" ? "manual_recording" : "successful_tool_chain",
          signals: correction ? ["correction_phrase"] : job.mode === "explicit" ? ["save_as_skill", "user_approved_recording"] : ["long_successful_sequence"],
          userConfirmed: job.mode === "explicit", destinationHint: draft.destination, terminalStatus: job.evidence.runStatus,
          title: draft.title, summary: draft.summary, normalizedGoal: draft.title,
          positiveTriggers: [...draft.appliesWhen, ...draft.prerequisites.map(item => `Prerequisite: ${item}`)],
          negativeTriggers: draft.doesNotApplyWhen,
          procedureSteps: draft.steps.map((step, index) => ({ title: `Step ${index + 1}`, instruction: step.instruction,
            expectedEvidence: `${step.evidence.evidenceId}: ${step.evidence.quote}` })),
          validationSteps: draft.checks.map(check => ({ title: check.check, commandOrCheck: check.check,
            expectedResult: `${check.expected}; evidence ${check.evidence.evidenceId}: ${check.evidence.quote}` })),
        } });
      if (outcome.statusCode >= 400) throw new Error("learning_generation_disabled");
      const candidate = outcome.body.candidate;
      if (candidate && typeof candidate === "object" && "id" in candidate && typeof candidate.id === "string") ids.push(candidate.id);
      reason = typeof outcome.body.action === "string" ? outcome.body.action : undefined;
    }
    return store.finishLearningReviewJob(job.id, fence, "succeeded", ids, reason, new Date().toISOString());
  });
  for (const event of events) hub.publish(event);
  return result;
}

export class LearningReviewCoordinator {
  private readonly entries = new Map<RunStore, ReturnType<typeof setInterval>>();
  private readonly active = new Map<RunStore, { readonly controller: AbortController; readonly done: Promise<void> }>();
  private stopped = false;
  constructor(private readonly options: LearningReviewCoordinatorOptions) {}
  registerStore(store: RunStore): void {
    if (this.stopped || this.entries.has(store)) return;
    const runtime = this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store);
    for (const job of store.listLearningReviewJobs("running", 100)) {
      if (job.fence?.runtimeInstanceId === runtime.runtimeInstanceId) continue;
      store.cancelLearningReviewJob(job.id, "learning_daemon_restarted", new Date().toISOString());
      if (job.fence) transitionWorkUnitCancelled(store, job.fence.workUnitId, job.fence.attemptId, "learning_daemon_restarted");
    }
    const timer = setInterval(() => this.wake(store), this.options.scanIntervalMs ?? 30_000);
    timer.unref(); this.entries.set(store, timer); this.wake(store);
  }
  wake(store: RunStore): void {
    if (this.stopped || this.active.has(store)) return;
    if (!this.entries.has(store)) { this.registerStore(store); return; }
    if (foregroundWorkActive(store)) return;
    this.enqueueAutomatic(store);
    const job = store.listLearningReviewJobs("queued", 1)[0];
    if (!job) return;
    const controller = new AbortController();
    // Defer execution until its lifetime is retained, including synchronous re-entry from a Host seam.
    const done = Promise.resolve().then(() => this.process(store, job, controller)).catch(() => {
      console.warn("learning_review_failed: persisted status remains available");
    }).finally(() => { this.active.delete(store); });
    this.active.set(store, { controller, done });
  }
  beginShutdown(): void {
    this.stopped = true;
    for (const timer of this.entries.values()) clearInterval(timer);
    this.entries.clear();
    for (const entry of this.active.values()) entry.controller.abort();
  }
  async drain(): Promise<void> { await Promise.all([...this.active.values()].map(entry => entry.done)); }
  private enqueueAutomatic(store: RunStore): void {
    const policy = store.getLearningReviewPolicy();
    if (policy.mode !== "propose" || !policy.providerPresetId || store.getWorkspaceSettings().skillGovernancePolicy.generationMode === "off") return;
    for (const run of store.listRuns({ status: "succeeded", limit: 10 })) {
      if (!run.endedAt || !policy.updatedAt || run.endedAt < policy.updatedAt) continue;
      try {
        const evidence = captureLearningEvidence(store, run.id);
        if (evidence.items.filter(item => item.verified).length < 2) continue;
        store.enqueueLearningReview({ mode: "automatic", evidence, providerPresetId: policy.providerPresetId }, new Date().toISOString());
      } catch { /* Ineligible lineage or exhausted automatic quota is a safe skip. */ }
    }
    for (const channel of store.listChannels({ archived: false, limit: 20 })) {
      for (const decision of store.listChannelDecisions({ channelId: channel.id, status: "active", limit: 10 })) {
        if (!policy.updatedAt || decision.createdAt < policy.updatedAt || decision.createdBy !== "local-user") continue;
        try { store.enqueueLearningReview({ mode: "automatic", evidence: captureDecisionLearningEvidence(store, decision.id),
          providerPresetId: policy.providerPresetId }, new Date().toISOString()); } catch { /* Changed scope or quota. */ }
      }
    }
  }
  private async process(store: RunStore, selected: LearningReviewJob, controller: AbortController): Promise<void> {
    if (this.stopped || controller.signal.aborted || foregroundWorkActive(store)) return;
    if (!learningGenerationAllowed(store, selected)) {
      store.cancelLearningReviewJob(selected.id, "learning_generation_disabled", new Date().toISOString()); return;
    }
    if (!learningEvidenceCurrent(store, selected.evidence)) {
      store.cancelLearningReviewJob(selected.id, "learning_source_changed", new Date().toISOString()); return;
    }
    const started = startRuntimeWorkUnit({ store, runtimeSupervisor: this.options.runtimeSupervisor, kind: "learning_review",
      ownerType: "learning_review", ownerId: selected.id, channelId: selected.evidence.channelId,
      teammateId: selected.evidence.teammateId, providerPresetId: selected.providerPresetId,
      effectiveRunnerId: "learning-extractor", idempotencyKey: selected.id,
      request: { jobId: selected.id, evidenceDigest: selected.evidence.digest } });
    const fence = toRuntimeAttemptFence(started.attempt);
    let job: LearningReviewJob | undefined;
    try { job = store.claimLearningReviewJob(selected.id, fence, new Date().toISOString()); }
    catch { transitionWorkUnitCancelled(store, fence.workUnitId, fence.attemptId, "learning_claim_lost"); return; }
    if (!job) { transitionWorkUnitCancelled(store, fence.workUnitId, fence.attemptId, "learning_claim_lost"); return; }
    const providerRevision = store.getProviderPreset(selected.providerPresetId)?.updatedAt;
    const stop = (): void => { controller.abort(); };
    const timeout = setTimeout(stop, job.limits.timeoutMs);
    const monitor = setInterval(() => {
      try {
        const preset = store.getProviderPreset(selected.providerPresetId);
        if ((!this.options.extract && (!preset?.enabled || preset.updatedAt !== providerRevision)) ||
          !learningGenerationAllowed(store, selected) ||
          foregroundWorkActive(store) || store.getLearningReviewJob(selected.id)?.status !== "running" ||
          !learningEvidenceCurrent(store, selected.evidence) || this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store).runtimeInstanceId !== fence.runtimeInstanceId) stop();
      } catch { stop(); }
    }, 250);
    const heartbeat = setInterval(() => {
      try { store.recordRuntimeHeartbeat({ ...fence, source: "supervisor", ts: new Date().toISOString() }); }
      catch { stop(); }
    }, 10_000);
    try {
      const provider = this.options.extract ? undefined : resolveProviderForRun(store, { cwd: store.paths.cwd,
        workspaceCwd: store.paths.cwd, providerPresetId: job.providerPresetId, tools: [],
        task: { id: job.id, title: "Review selected experience", prompt: "Extract reviewable candidates only." } }, this.options.secretResolver);
      if (provider && (provider.api !== "openai-completions" || !provider.baseUrl || provider.reasoning)) throw new Error("learning_provider_unsupported");
      const prepared = prepareLearningModelRequest(job.evidence);
      let draft: LearningDraft | undefined;
      for (let requestIndex = 0; requestIndex < job.limits.maxRequests; requestIndex += 1) {
        if (foregroundWorkActive(store) || !learningEvidenceCurrent(store, job.evidence)) throw new Error("learning_source_or_foreground_changed");
        // A queued selection or retry cannot outlive the user's current recording authority.
        if (!learningGenerationAllowed(store, job)) throw new Error("learning_generation_disabled");
        job = store.reserveLearningReviewModelRequest(job.id, fence, prepared.inputTokens, new Date().toISOString());
        controller.signal.throwIfAborted();
        try {
          draft = this.options.extract ? await this.options.extract({ job, prompt: prepared.prompt, signal: controller.signal })
            : await executeLearningModel({ provider: provider!, evidence: job.evidence, prompt: prepared.prompt, signal: controller.signal,
              outputTokens: job.limits.perRequestOutputTokens });
          break;
        } catch (error) {
          if (requestIndex + 1 >= job.limits.maxRequests || !(error instanceof Error) || !/^learning_provider_http_(429|502|503|504)$/.test(error.message)) throw error;
          await new Promise<void>((resolve, reject) => {
            const aborted = (): void => { clearTimeout(timer); reject(new Error("learning_cancelled")); };
            const timer = setTimeout(() => { controller.signal.removeEventListener("abort", aborted); resolve(); }, 1000);
            if (controller.signal.aborted) aborted(); else controller.signal.addEventListener("abort", aborted, { once: true });
          });
        }
      }
      controller.signal.throwIfAborted();
      if (!draft) throw new Error("learning_extraction_failed");
      if (this.options.runtimeSupervisor.getRuntime(store.paths.cwd, store).runtimeInstanceId !== fence.runtimeInstanceId) throw new Error("learning_attempt_stale");
      if (!this.options.extract && (!store.getProviderPreset(job.providerPresetId)?.enabled ||
        store.getProviderPreset(job.providerPresetId)?.updatedAt !== providerRevision)) throw new Error("learning_provider_changed");
      commitLearningDraft({ store, job, fence, draft, hub: this.options.controlPlaneEvents });
      transitionWorkUnitTerminal(store, { ...fence, event: "runner_succeeded", attemptStatus: "succeeded",
        runtimeEventType: "work_unit_succeeded", actor: "runner", now: new Date().toISOString() });
    } catch (error) {
      if (store.getLearningReviewJob(job.id)?.status === "cancelled") controller.abort();
      const reason = controller.signal.aborted ? "learning_cancelled" : error instanceof Error && /^learning_[a-z_0-9]+$/.test(error.message) ? error.message : "learning_extraction_failed";
      if (controller.signal.aborted) store.cancelLearningReviewJob(job.id, reason, new Date().toISOString());
      else {
        try { store.finishLearningReviewJob(job.id, fence, "failed", [], reason, new Date().toISOString()); }
        catch { store.cancelLearningReviewJob(job.id, reason, new Date().toISOString()); }
      }
      if (controller.signal.aborted) transitionWorkUnitCancelled(store, fence.workUnitId, fence.attemptId, reason);
      else transitionWorkUnitTerminal(store, { ...fence, event: "runner_failed", attemptStatus: "failed",
        runtimeEventType: "work_unit_failed", actor: "runner", now: new Date().toISOString(), errorCode: reason });
    } finally { clearTimeout(timeout); clearInterval(monitor); clearInterval(heartbeat); }
  }
}
