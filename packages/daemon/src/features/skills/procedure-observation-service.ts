import {
  analyzeSkillDuplicate, createProcedureObservationInputFromJob, DEFAULT_WORKSPACE_ID,
  isExplicitObservationJob, procedureObservationHasTerminalStatus,
  type CandidateGenerationDecision, type CandidateGenerationDecisionAction,
  type CandidateGenerationDecisionSource, type CandidateRoute, type CreateSkillCandidateInput,
  type ProcedureObservation, type ProcedureObservationJobInput, type SkillCandidate,
  type SkillCandidateHealthInput, type SkillDuplicateAnalysis, type RunStore, type ControlPlaneEvent,
} from "@ling-stack/core";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { listEffectiveSkillRegistryEntries } from "./registry.js";
import type { ParsedCreateSkillCandidateRequest } from "./schemas.js";

type SkillRouteStore = RunStore;
interface DeferredCandidateEvents {
  readonly events: ControlPlaneEvent[];
  readonly appendEvent: RunStore["appendControlPlaneEvent"];
  readonly workspaceId: string;
}

export function routeFromObservation(observation: ProcedureObservation): CandidateRoute {
  return {
    kind: observation.routeKind ?? "reject",
    reasonCode: observation.routeReasonCode ?? "missing_route",
    confidence: observation.confidence,
    blockers: observation.routeBlockers,
  };
}

export interface ProcedureObservationJobRouteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export function processProcedureObservationJob(input: {
  readonly store: SkillRouteStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly cwd: string;
  readonly job: ProcedureObservationJobInput;
  readonly now: string;
}): ProcedureObservationJobRouteResult {
  const committedEvents: ControlPlaneEvent[] = [];
  const result = input.store.withProcedureObservationJobTransaction(events =>
    processProcedureObservationJobWithinTransaction({ ...input,
      committedEvents: { events: committedEvents, appendEvent: events.appendControlPlaneEvent,
        workspaceId: input.job.workspaceId ?? DEFAULT_WORKSPACE_ID } }));
  for (const event of committedEvents) input.controlPlaneEvents.publish(event);
  return result;
}

function processProcedureObservationJobWithinTransaction(input: {
  readonly store: SkillRouteStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly cwd: string;
  readonly job: ProcedureObservationJobInput;
  readonly now: string;
  readonly committedEvents: DeferredCandidateEvents;
}): ProcedureObservationJobRouteResult {
  const { store, controlPlaneEvents, cwd, job, now, committedEvents } = input;
  const policy = store.getWorkspaceSettings().skillGovernancePolicy;
  const generationSource = generationSourceFromJob(job);
  if ((job.source === "manual_recording" || job.signals.includes("user_approved_recording")) && policy.recordingMode !== "user_initiated") {
    return {
      statusCode: 409,
      body: {
        error: "skill_recording_disabled",
        message: "Skill recording is disabled by the workspace skill governance policy.",
      },
    };
  }

  const built = createProcedureObservationInputFromJob(job);
  const legacy = built.legacyJobKey ? store.getProcedureObservationByJobKey(built.legacyJobKey, job.workspaceId) : undefined;
  const sameLegacyScope = legacy && legacy.channelId === job.channelId && legacy.teammateId === job.teammateId && legacy.taskId === job.taskId;
  const existing = store.getProcedureObservationByJobKey(built.jobKey, job.workspaceId) ?? (sameLegacyScope ? legacy : undefined);
  if (existing) {
    const route = routeFromObservation(existing);
    const generationDecision = generationDecisionForExistingObservation(
      store,
      existing,
      generationSource,
      route,
      now,
    );
    return {
      statusCode: 200,
      body: {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: true,
        observation: existing,
        route,
        action: "evidence_recorded",
        generationDecision,
      },
    };
  }

  const observation = store.createProcedureObservation(built.observationInput, now);
  const route = routeFromObservation(observation);
  if (route.kind !== "skill") {
    const generationDecision = persistGenerationDecision(store, {
      observation,
      route,
      source: generationSource,
      decision: generationDecisionActionForRoute(route),
      reason: generationReasonForRoute(route),
      now,
    });
    return {
      statusCode: 202,
      body: {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: false,
        observation,
        route,
        action: route.blockers.length > 0 ? "blocked" : "routed_elsewhere",
        generationDecision,
      },
    };
  }

  if (route.blockers.length > 0) {
    const generationDecision = persistGenerationDecision(store, {
      observation,
      route,
      source: generationSource,
      decision: "append_evidence",
      reason: `Skill candidate generation is blocked until gates are complete: ${route.blockers.join(", ")}.`,
      now,
    });
    return {
      statusCode: 202,
      body: {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: false,
        observation,
        route,
        action: "blocked",
        generationDecision,
      },
    };
  }

  const explicitObservationJob = isExplicitObservationJob(job);
  if (policy.generationMode === "off") {
    const generationDecision = persistGenerationDecision(store, {
      observation,
      route,
      source: generationSource,
      decision: "append_evidence",
      reason: "Workspace skill governance policy is off, so the observation was retained without creating a candidate.",
      now,
    });
    return {
      statusCode: 202,
      body: {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: false,
        observation,
        route,
        action: "evidence_recorded",
        generationDecision,
      },
    };
  }

  if (!explicitObservationJob) {
    if (policy.generationMode === "approval_only") {
      const generationDecision = persistGenerationDecision(store, {
        observation,
        route,
        source: generationSource,
        decision: "append_evidence",
        reason: "Workspace skill governance policy is approval_only, so unconfirmed post-run observations stay evidence-only.",
        now,
      });
      return {
        statusCode: 202,
        body: {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: false,
          observation,
          route,
          action: "evidence_recorded",
          generationDecision,
        },
      };
    }
    const postRunGate = postRunCandidateGenerationGate(store, observation, job, route, policy.generationMode);
    if (postRunGate.ready) {
      const input = skillCandidateInputFromObservation(observation);
      const withAnalysis = withDuplicateAnalysis(input, store);
      if (withAnalysis.duplicateAnalysis.decision !== "no_overlap") {
        const generationDecision = persistGenerationDecision(store, {
          observation,
          route,
          source: "post_run_terminal",
          decision: "append_evidence",
          duplicateAnalysis: withAnalysis.duplicateAnalysis,
          reason: `Post-run evidence met generation gates, but duplicate analysis returned ${withAnalysis.duplicateAnalysis.decision}.`,
          now,
        });
        return {
          statusCode: 202,
          body: {
            cwd,
            jobKey: built.jobKey,
            reusedObservation: false,
            observation,
            route,
            action: "evidence_recorded",
            duplicateAnalysis: withAnalysis.duplicateAnalysis,
            generationDecision,
          },
        };
      }
      const candidate = store.createSkillCandidate(withAnalysis, now);
      const generationDecision = persistGenerationDecision(store, {
        observation,
        route,
        source: "post_run_terminal",
        decision: "create_skill_candidate",
        duplicateAnalysis: candidate.duplicateAnalysis,
        createdCandidateId: candidate.id,
        reason: postRunGate.reason,
        now,
      });
      appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "post_run_observation_create", candidate.id, candidate.status, committedEvents);
      return {
        statusCode: 201,
        body: {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: false,
          observation,
          route,
          action: "candidate_created",
          candidate,
          duplicateAnalysis: candidate.duplicateAnalysis,
          generationDecision,
        },
      };
    }
    const generationDecision = persistGenerationDecision(store, {
      observation,
      route,
      source: generationSource,
      decision: "append_evidence",
      reason: postRunGate.reason,
      now,
    });
    return {
      statusCode: 202,
      body: {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: false,
        observation,
        route,
        action: "evidence_recorded",
        generationDecision,
      },
    };
  }

  const candidateInput = skillCandidateInputFromObservation(observation);
  const withAnalysis = withDuplicateAnalysis(candidateInput, store);
  if (withAnalysis.duplicateAnalysis.decision !== "no_overlap") {
    const generationDecision = persistGenerationDecision(store, {
      observation,
      route,
      source: generationSource,
      decision: "append_evidence",
      duplicateAnalysis: withAnalysis.duplicateAnalysis,
      reason: `Duplicate analysis returned ${withAnalysis.duplicateAnalysis.decision}; evidence was retained without creating a new skill candidate.`,
      now,
    });
    return {
      statusCode: 202,
      body: {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: false,
        observation,
        route,
        action: "evidence_recorded",
        duplicateAnalysis: withAnalysis.duplicateAnalysis,
        generationDecision,
      },
    };
  }
  const candidate = store.createSkillCandidate(withAnalysis, now);
  const generationDecision = persistGenerationDecision(store, {
    observation,
    route,
    source: generationSource,
    decision: "create_skill_candidate",
    duplicateAnalysis: candidate.duplicateAnalysis,
    createdCandidateId: candidate.id,
    reason: "Explicit observation passed routing gates and duplicate analysis, so a pending skill candidate was created.",
    now,
  });
  appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "observation_job_create", candidate.id, candidate.status, committedEvents);
  return {
    statusCode: 201,
    body: {
      cwd,
      jobKey: built.jobKey,
      reusedObservation: false,
      observation,
      route,
      action: "candidate_created",
      candidate,
      duplicateAnalysis: candidate.duplicateAnalysis,
      generationDecision,
    },
  };
}

function generationDecisionForExistingObservation(
  store: SkillRouteStore,
  observation: ProcedureObservation,
  source: CandidateGenerationDecisionSource,
  route: CandidateRoute,
  now: string,
): CandidateGenerationDecision {
  const [existing] = store.listCandidateGenerationDecisions({
    observationId: observation.id,
    limit: 1,
  });
  if (existing) {
    return existing;
  }
  return persistGenerationDecision(store, {
    observation,
    route,
    source,
    decision: "append_evidence",
    reason: "Reused an existing idempotent observation job; no new candidate generation was attempted.",
    now,
  });
}

function postRunCandidateGenerationGate(
  store: SkillRouteStore,
  observation: ProcedureObservation,
  job: ProcedureObservationJobInput,
  route: CandidateRoute,
  generationMode: "semi_auto" | "auto_candidate",
): { readonly ready: boolean; readonly reason: string } {
  if (generationSourceFromJob(job) !== "post_run_terminal") {
    return {
      ready: false,
      reason: "Observation job was not explicitly confirmed as a save-as-skill request, so it stays evidence-only.",
    };
  }
  if (job.terminalStatus !== "succeeded") {
    return {
      ready: false,
      reason: `Post-run observation is evidence-only because terminal status is ${job.terminalStatus ?? "missing"}.`,
    };
  }
  if (route.kind !== "skill" || route.blockers.length > 0) {
    return {
      ready: false,
      reason: "Post-run observation did not pass skill routing gates, so it stays evidence-only.",
    };
  }
  const clusterObservations = store.listProcedureObservations({
    clusterId: observation.clusterId,
    routeKind: "skill",
    limit: 500,
  });
  const successfulObservations = clusterObservations.filter((item) =>
    procedureObservationHasTerminalStatus(item, "succeeded")
  );
  const requiredSuccessfulObservations = generationMode === "auto_candidate" ? 1 : 2;
  if (successfulObservations.length < requiredSuccessfulObservations) {
    return {
      ready: false,
      reason: `Post-run observation is evidence-only until at least ${requiredSuccessfulObservations} successful observation${requiredSuccessfulObservations === 1 ? "" : "s"} exist in the same cluster.`,
    };
  }
  const validationSignatures = uniqueStrings(successfulObservations.map(validationSignature));
  if (validationSignatures.length !== 1) {
    return {
      ready: false,
      reason: "Post-run observation is evidence-only until validation evidence is stable across the cluster.",
    };
  }
  return {
    ready: true,
    reason: `Post-run terminal evidence passed ${generationMode} generation gates with ${successfulObservations.length} successful observations and stable validation.`,
  };
}

export function persistGenerationDecision(
  store: SkillRouteStore,
  input: {
    readonly observation: ProcedureObservation;
    readonly route: CandidateRoute;
    readonly source: CandidateGenerationDecisionSource;
    readonly decision: CandidateGenerationDecisionAction;
    readonly duplicateAnalysis?: SkillDuplicateAnalysis;
    readonly createdCandidateId?: string;
    readonly reason: string;
    readonly now: string;
  },
): CandidateGenerationDecision {
  return store.createCandidateGenerationDecision({
    workspaceId: input.observation.workspaceId,
    observationId: input.observation.id,
    clusterId: input.observation.clusterId,
    source: input.source,
    route: input.route,
    decision: input.decision,
    blockers: input.route.blockers,
    duplicateDecision: input.duplicateAnalysis?.decision,
    reason: input.reason,
    createdCandidateId: input.createdCandidateId,
  }, input.now);
}

function validationSignature(observation: ProcedureObservation): string {
  return observation.validationSteps
    .map((step) => [step.title, step.commandOrCheck ?? "", step.expectedResult ?? ""].join("|").trim().toLowerCase())
    .sort()
    .join(";");
}

function generationSourceFromJob(job: ProcedureObservationJobInput): CandidateGenerationDecisionSource {
  if (job.source === "manual_recording" || job.signals.includes("user_approved_recording")) {
    return "approved_recording";
  }
  if (job.signals.includes("save_as_skill")) {
    return "explicit_user_save";
  }
  if (job.source === "workflow_step_output" || job.source === "multi_agent_handoff" || job.signals.includes("handoff_stabilized")) {
    return "workflow_fanin";
  }
  if (job.runId || job.terminalStatus) {
    return "post_run_terminal";
  }
  if (job.source === "user_correction" || job.signals.includes("correction_phrase")) {
    return "correction_health";
  }
  if (job.userConfirmed) {
    return "explicit_user_save";
  }
  return "selected_transcript_snippet";
}

export function generationSourceFromObservation(observation: ProcedureObservation): CandidateGenerationDecisionSource {
  if (observation.source === "manual_recording" || observation.signals.includes("user_approved_recording")) {
    return "approved_recording";
  }
  if (observation.signals.includes("save_as_skill")) {
    return "explicit_user_save";
  }
  if (observation.source === "workflow_step_output" || observation.source === "multi_agent_handoff" || observation.signals.includes("handoff_stabilized")) {
    return "workflow_fanin";
  }
  if (observation.runId) {
    return "post_run_terminal";
  }
  if (observation.source === "user_correction" || observation.signals.includes("correction_phrase")) {
    return "correction_health";
  }
  return "selected_transcript_snippet";
}

export function generationDecisionActionForRoute(route: CandidateRoute): CandidateGenerationDecisionAction {
  if (route.kind === "approval_policy_review" || route.blockers.includes("permission_expansion")) {
    return "policy_review";
  }
  if (route.kind === "reject") {
    return "reject";
  }
  if (route.blockers.length > 0) {
    return "append_evidence";
  }
  if (route.kind === "channel_protocol") {
    return "create_channel_protocol_candidate";
  }
  if (route.kind === "playbook") {
    return "create_playbook_candidate";
  }
  if (route.kind === "memory") {
    return "create_memory_candidate";
  }
  if (route.kind === "automation") {
    return "create_automation_candidate";
  }
  return "create_skill_candidate";
}

export function generationReasonForRoute(route: CandidateRoute): string {
  if (route.kind === "approval_policy_review" || route.blockers.includes("permission_expansion")) {
    return "Observation requested permission or approval expansion, so it was routed to policy review.";
  }
  if (route.kind === "reject") {
    return `Observation was rejected by the router: ${route.reasonCode}.`;
  }
  if (route.blockers.length > 0) {
    return `Observation was routed to ${route.kind} but blocked by: ${route.blockers.join(", ")}.`;
  }
  return `Observation was routed to ${route.kind} candidate handling: ${route.reasonCode}.`;
}

export function skillCandidateInputFromObservation(observation: ProcedureObservation): ParsedCreateSkillCandidateRequest {
  const requiredTools = uniqueStrings(observation.procedureSteps.flatMap((step) => step.requiredTools ?? []));
  return {
    workspaceId: observation.workspaceId,
    origin: observation.source === "manual_recording" ? "recording" : "ling-generated",
    proposedAction: "create",
    title: observation.title,
    summary: observation.summary,
    definition: {
      positiveTriggers: observation.positiveTriggers.length > 0 ? observation.positiveTriggers : [observation.normalizedGoal],
      negativeTriggers: observation.negativeTriggers,
      procedureSteps: observation.procedureSteps.map((step) => ({
        title: step.title,
        instruction: step.instruction,
        requiredTools: step.requiredTools,
      })),
      validationSteps: observation.validationSteps.map((step) => ({
        title: step.title,
        commandOrCheck: step.commandOrCheck,
        expectedResult: step.expectedResult,
      })),
      requiredTools: requiredTools.length > 0 ? requiredTools : ["read"],
      requiredProviderCapabilities: ["chat"],
    },
    sourceRefs: observation.sourceRefs,
    reviewNotes: [`Created from procedure observation ${observation.id}.`],
  };
}

export function withDuplicateAnalysis(
  input: ParsedCreateSkillCandidateRequest,
  store: SkillRouteStore,
): CreateSkillCandidateInput {
  const duplicateAnalysis = input.duplicateAnalysis ?? analyzeSkillDuplicate({
    candidate: skillCandidateHealthInputFromCreateRequest(input),
    activeSkills: listEffectiveSkillRegistryEntries(store),
    pendingCandidates: store.listSkillCandidates({ workspaceId: input.workspaceId, limit: 500 }).map(skillCandidateHealthInputFromCandidate),
  });
  return {
    ...input,
    duplicateAnalysis,
  };
}

function skillCandidateHealthInputFromCreateRequest(input: ParsedCreateSkillCandidateRequest): SkillCandidateHealthInput {
  return {
    id: input.id ?? "skill_candidate_preview",
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    origin: input.origin,
    status: input.status ?? "pending",
    targetSkillId: input.targetSkillId,
    title: input.title,
    summary: input.summary,
    positiveTriggers: input.definition.positiveTriggers,
    negativeTriggers: input.definition.negativeTriggers,
    procedureSteps: input.definition.procedureSteps,
    validationSteps: input.definition.validationSteps,
    requiredTools: input.definition.requiredTools,
    requiredProviderCapabilities: input.definition.requiredProviderCapabilities,
    createdAt: new Date(0).toISOString(),
    expiresAt: input.expiresAt,
    supersededBy: input.supersededBy,
  };
}

export function skillCandidateHealthInputFromCandidate(candidate: SkillCandidate): SkillCandidateHealthInput {
  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    origin: candidate.origin,
    status: candidate.status,
    targetSkillId: candidate.targetSkillId,
    title: candidate.title,
    summary: candidate.summary,
    positiveTriggers: candidate.definition.positiveTriggers,
    negativeTriggers: candidate.definition.negativeTriggers,
    procedureSteps: candidate.definition.procedureSteps,
    validationSteps: candidate.definition.validationSteps,
    requiredTools: candidate.definition.requiredTools,
    requiredProviderCapabilities: candidate.definition.requiredProviderCapabilities,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    expiresAt: candidate.expiresAt,
    supersededBy: candidate.supersededBy,
  };
}

export function appendSkillCandidateChangedEvent(
  store: SkillRouteStore,
  controlPlaneEvents: ControlPlaneEventHub,
  cwd: string,
  changeType: string,
  candidateId: string,
  status: string,
  committedEvents?: DeferredCandidateEvents,
): void {
  const eventInput = {
    workspaceId: committedEvents?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "skills" as const,
    entityType: "candidate",
    entityId: candidateId,
    action: "skill.candidate_changed",
    data: {
      changeType,
      candidateId,
      status,
    },
  };
  if (committedEvents) committedEvents.events.push(committedEvents.appendEvent(eventInput, new Date().toISOString()));
  else appendControlPlaneEvent(store, controlPlaneEvents, eventInput);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
