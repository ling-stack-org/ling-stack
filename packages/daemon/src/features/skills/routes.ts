import type { IncomingMessage, ServerResponse } from "node:http";
import {
  analyzeSkillDuplicate,
  buildSkillHealthReport,
  createProcedureObservationInputFromJob,
  DEFAULT_WORKSPACE_ID,
  isExplicitObservationJob,
  procedureObservationHasJobKey,
  providerCapabilities,
  readOnlyRunTools,
  riskyRunTools,
  type CreateSkillCandidateInput,
  type CreateSkillImportDraftInput,
  type CandidateRoute,
  type ProviderCapability,
  type ProcedureObservation,
  type RunTool,
  type SkillCandidate,
  type SkillCandidateHealthInput,
  type SkillDefinition,
  type SkillImportWarning,
  type SkillRegistryEntry,
  type SkillWorkflowPhase,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { SkillRoute } from "../../server/routes.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listEffectiveSkillRegistryEntries, refreshEffectiveSkillRegistryEntries } from "./registry.js";
import {
  parseCreateSkillCandidateRequest,
  parseProcedureObservationJobRequest,
  parseProcedureObservationRequest,
  parseSkillCorrectionRequest,
  parseSkillCandidateReviewRequest,
  parseSkillImportDraftRequest,
  readOptionalCandidateRouteKindQuery,
  readOptionalSkillCandidateOriginQuery,
  readOptionalSkillCandidateStatusQuery,
  readOptionalSkillUsageEventKindQuery,
  type ParsedCreateSkillCandidateRequest,
} from "./schemas.js";

export async function handleSkillRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
  route: SkillRoute | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (url.pathname === "/skills/health") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/health` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        report: buildSkillHealthReport({
          workspaceId: DEFAULT_WORKSPACE_ID,
          skills: listEffectiveSkillRegistryEntries(store),
          candidates: store.listSkillCandidates({ limit: 500 }).map(skillCandidateHealthInputFromCandidate),
          usageStats: store.listSkillUsageStats(),
          generatedAt: new Date().toISOString(),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (url.pathname === "/skills/usage-events") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/usage-events` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        events: store.listSkillUsageEvents({
          skillId: url.searchParams.get("skillId") || undefined,
          candidateId: url.searchParams.get("candidateId") || undefined,
          runId: url.searchParams.get("runId") || undefined,
          kind: readOptionalSkillUsageEventKindQuery(url, "kind"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (url.pathname === "/skills/usage-stats") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/usage-stats` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        stats: store.listSkillUsageStats({
          skillId: url.searchParams.get("skillId") || undefined,
        }),
      });
      return;
    }

    if (url.pathname === "/skill-candidates") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          candidates: store.listSkillCandidates({
            status: readOptionalSkillCandidateStatusQuery(url, "status"),
            origin: readOptionalSkillCandidateOriginQuery(url, "origin"),
            limit: readOptionalIntegerQuery(url, "limit", 1),
          }),
        });
        return;
      }
      if (request.method === "POST") {
        const now = new Date().toISOString();
        const body = await readJsonBody(request, config.maxBodyBytes);
        const input = parseCreateSkillCandidateRequest(body);
        const candidate = store.createSkillCandidate(withDuplicateAnalysis(input, store), now);
        appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "create", candidate.id, candidate.status);
        writeJson(response, 201, { cwd, candidate, reviewRecords: [] });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skill-candidates` });
      return;
    }

    if (url.pathname === "/procedure-observations") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          observations: store.listProcedureObservations({
            clusterId: url.searchParams.get("clusterId") || undefined,
            routeKind: readOptionalCandidateRouteKindQuery(url, "routeKind"),
            limit: readOptionalIntegerQuery(url, "limit", 1),
          }),
        });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const observation = store.createProcedureObservation(parseProcedureObservationRequest(body), new Date().toISOString());
        writeJson(response, 201, {
          cwd,
          observation,
          route: routeFromObservation(observation),
        });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /procedure-observations` });
      return;
    }

    if (url.pathname === "/procedure-observations/jobs") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /procedure-observations/jobs` });
        return;
      }
      const now = new Date().toISOString();
      const body = await readJsonBody(request, config.maxBodyBytes);
      const job = parseProcedureObservationJobRequest(body);
      const built = createProcedureObservationInputFromJob(job);
      const existing = store.listProcedureObservations({ limit: 500 })
        .find((observation) => procedureObservationHasJobKey(observation, built.jobKey));
      if (existing) {
        writeJson(response, 200, {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: true,
          observation: existing,
          route: routeFromObservation(existing),
          action: "evidence_recorded",
        });
        return;
      }
      const observation = store.createProcedureObservation(built.observationInput, now);
      const route = routeFromObservation(observation);
      if (route.kind !== "skill") {
        writeJson(response, 202, {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: false,
          observation,
          route,
          action: route.blockers.length > 0 ? "blocked" : "routed_elsewhere",
        });
        return;
      }
      if (route.blockers.length > 0) {
        writeJson(response, 202, {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: false,
          observation,
          route,
          action: "blocked",
        });
        return;
      }
      if (!isExplicitObservationJob(job)) {
        writeJson(response, 202, {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: false,
          observation,
          route,
          action: "evidence_recorded",
        });
        return;
      }
      const input = skillCandidateInputFromObservation(observation);
      const withAnalysis = withDuplicateAnalysis(input, store);
      if (withAnalysis.duplicateAnalysis.decision !== "no_overlap") {
        writeJson(response, 202, {
          cwd,
          jobKey: built.jobKey,
          reusedObservation: false,
          observation,
          route,
          action: "evidence_recorded",
          duplicateAnalysis: withAnalysis.duplicateAnalysis,
        });
        return;
      }
      const candidate = store.createSkillCandidate(withAnalysis, now);
      appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "observation_job_create", candidate.id, candidate.status);
      writeJson(response, 201, {
        cwd,
        jobKey: built.jobKey,
        reusedObservation: false,
        observation,
        route,
        action: "candidate_created",
        candidate,
        duplicateAnalysis: candidate.duplicateAnalysis,
      });
      return;
    }

    if (url.pathname === "/skill-candidates/observe") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skill-candidates/observe` });
        return;
      }
      const now = new Date().toISOString();
      const body = await readJsonBody(request, config.maxBodyBytes);
      const observation = store.createProcedureObservation(parseProcedureObservationRequest(body), now);
      const route = routeFromObservation(observation);
      if (route.kind !== "skill") {
        writeJson(response, 202, { cwd, observation, route, action: route.blockers.length > 0 ? "blocked" : "routed_elsewhere" });
        return;
      }
      if (route.blockers.length > 0) {
        writeJson(response, 202, { cwd, observation, route, action: "blocked" });
        return;
      }
      const input = skillCandidateInputFromObservation(observation);
      const withAnalysis = withDuplicateAnalysis(input, store);
      if (withAnalysis.duplicateAnalysis.decision !== "no_overlap") {
        writeJson(response, 202, {
          cwd,
          observation,
          route,
          action: "evidence_recorded",
          duplicateAnalysis: withAnalysis.duplicateAnalysis,
        });
        return;
      }
      const candidate = store.createSkillCandidate(withAnalysis, now);
      appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "observe_create", candidate.id, candidate.status);
      writeJson(response, 201, {
        cwd,
        observation,
        route,
        action: "candidate_created",
        candidate,
        duplicateAnalysis: candidate.duplicateAnalysis,
      });
      return;
    }

    if (url.pathname === "/skills") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills` });
        return;
      }
      writeJson(response, 200, { cwd, skills: listEffectiveSkillRegistryEntries(store) });
      return;
    }

    if (url.pathname === "/skills/refresh") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/refresh` });
        return;
      }
      const refreshed = refreshEffectiveSkillRegistryEntries(store);
      appendSkillRegistryChangedEvent(store, controlPlaneEvents, cwd, "refresh", "default", refreshed.registryGeneration);
      writeJson(response, 200, { cwd, ...refreshed });
      return;
    }

    if (url.pathname === "/skills/import-draft") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/import-draft` });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const draftInput = parseSkillImportDraftRequest(body, listEffectiveSkillRegistryEntries(store));
      const draft = store.createSkillImportDraft(draftInput, new Date().toISOString());
      writeJson(response, 201, { cwd, draft });
      return;
    }

    if (!route) {
      writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
      return;
    }

    if (route.kind === "draft") {
      if (request.method === "GET") {
        const draft = store.getSkillImportDraft(route.draftId);
        if (!draft) {
          writeJson(response, 404, { error: "skill_import_draft_not_found", message: `Skill import draft not found: ${route.draftId}` });
          return;
        }
        writeJson(response, 200, { cwd, draft });
        return;
      }
      if (request.method === "POST" && route.action === "publish") {
        const now = new Date().toISOString();
        const draft = store.getSkillImportDraft(route.draftId);
        const skills = store.publishSkillImportDraft(route.draftId, now);
        const candidateId = candidateIdFromSkillSourcePath(draft?.sourcePath);
        if (candidateId) {
          for (const skill of skills) {
            store.appendSkillUsageEvent({
              candidateId,
              skillId: skill.id,
              kind: "published",
              reason: `Published import draft ${route.draftId}.`,
            }, now);
          }
        }
        appendSkillRegistryChangedEvent(store, controlPlaneEvents, cwd, "publish", skills[0]?.id ?? route.draftId);
        writeJson(response, 200, { cwd, draftId: route.draftId, skills });
        return;
      }
    }

    if (route.kind === "skill" && route.action === "corrections") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/:id/corrections` });
        return;
      }
      if (!listEffectiveSkillRegistryEntries(store).some((skill) => skill.id === route.skillId)) {
        writeJson(response, 404, { error: "skill_not_found", message: `Skill not found: ${route.skillId}` });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const now = new Date().toISOString();
      const event = store.appendSkillUsageEvent({
        ...parseSkillCorrectionRequest(body),
        skillId: route.skillId,
        kind: "user_corrected",
      }, now);
      writeJson(response, 201, { cwd, event });
      return;
    }

    if (route.kind === "skill" && request.method === "DELETE") {
      const now = new Date().toISOString();
      const archived = store.archiveSkillRegistryEntry(route.skillId, now);
      if (!archived) {
        writeJson(response, 404, { error: "skill_not_found", message: `Skill not found: ${route.skillId}` });
        return;
      }
      appendSkillRegistryChangedEvent(store, controlPlaneEvents, cwd, "archive", route.skillId);
      writeJson(response, 200, { cwd, skill: archived });
      return;
    }

    if (route.kind === "candidate") {
      if (request.method === "GET" && !route.action) {
        const candidate = store.getSkillCandidate(route.candidateId);
        if (!candidate) {
          writeJson(response, 404, { error: "skill_candidate_not_found", message: `Skill candidate not found: ${route.candidateId}` });
          return;
        }
        writeJson(response, 200, {
          cwd,
          candidate,
          reviewRecords: store.listSkillCandidateReviewRecords(candidate.id),
        });
        return;
      }
      if (request.method === "POST" && route.action === "review") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const review = parseSkillCandidateReviewRequest(body);
        const reviewed = store.applySkillCandidateReviewAction({
          candidateId: route.candidateId,
          actor: "user",
          ...review,
        }, new Date().toISOString());
        appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, review.action, reviewed.candidate.id, reviewed.candidate.status);
        writeJson(response, 200, { cwd, ...reviewed });
        return;
      }
      if (request.method === "POST" && route.action === "draft") {
        const candidate = store.getSkillCandidate(route.candidateId);
        if (!candidate) {
          writeJson(response, 404, { error: "skill_candidate_not_found", message: `Skill candidate not found: ${route.candidateId}` });
          return;
        }
        const now = new Date().toISOString();
        const draftInput = createImportDraftInputFromCandidate(candidate, listEffectiveSkillRegistryEntries(store));
        const draft = store.createSkillImportDraft(draftInput, now);
        store.appendSkillUsageEvent({
          candidateId: candidate.id,
          kind: "draft_created",
          reason: `Created import draft ${draft.id}.`,
        }, now);
        appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "create_draft", candidate.id, candidate.status);
        writeJson(response, 201, { cwd, candidate, draft });
        return;
      }
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for skill route` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function appendSkillRegistryChangedEvent(
  store: ReturnType<RunStoreRegistry["getStore"]>,
  controlPlaneEvents: ControlPlaneEventHub,
  cwd: string,
  changeType: string,
  entityId: string,
  registryGeneration?: number,
): void {
  appendControlPlaneEvent(store, controlPlaneEvents, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "skills",
    entityType: "registry",
    entityId,
    action: "skill.registry_changed",
    data: {
      changeType,
      registryGeneration,
      skillId: entityId === "default" ? undefined : entityId,
    },
  });
}

function routeFromObservation(observation: ProcedureObservation): CandidateRoute {
  return {
    kind: observation.routeKind ?? "reject",
    reasonCode: observation.routeReasonCode ?? "missing_route",
    confidence: observation.confidence,
    blockers: observation.routeBlockers,
  };
}

function skillCandidateInputFromObservation(observation: ProcedureObservation): ParsedCreateSkillCandidateRequest {
  const requiredTools = uniqueStrings(observation.procedureSteps.flatMap((step) => step.requiredTools ?? []));
  return {
    origin: observation.source === "manual_recording" ? "recording" : "ling-generated",
    proposedAction: "create",
    title: observation.title,
    summary: observation.summary,
    definition: {
      workflowPhase: "operate",
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

function withDuplicateAnalysis(
  input: ParsedCreateSkillCandidateRequest,
  store: ReturnType<RunStoreRegistry["getStore"]>,
): CreateSkillCandidateInput {
  const duplicateAnalysis = input.duplicateAnalysis ?? analyzeSkillDuplicate({
    candidate: skillCandidateHealthInputFromCreateRequest(input),
    activeSkills: listEffectiveSkillRegistryEntries(store),
    pendingCandidates: store.listSkillCandidates({ limit: 500 }).map(skillCandidateHealthInputFromCandidate),
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
    workflowPhase: input.definition.workflowPhase,
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

function skillCandidateHealthInputFromCandidate(candidate: SkillCandidate): SkillCandidateHealthInput {
  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    origin: candidate.origin,
    status: candidate.status,
    targetSkillId: candidate.targetSkillId,
    title: candidate.title,
    summary: candidate.summary,
    workflowPhase: candidate.definition.workflowPhase,
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

function appendSkillCandidateChangedEvent(
  store: ReturnType<RunStoreRegistry["getStore"]>,
  controlPlaneEvents: ControlPlaneEventHub,
  cwd: string,
  changeType: string,
  candidateId: string,
  status: string,
): void {
  appendControlPlaneEvent(store, controlPlaneEvents, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "skills",
    entityType: "candidate",
    entityId: candidateId,
    action: "skill.candidate_changed",
    data: {
      changeType,
      candidateId,
      status,
    },
  });
}

function createImportDraftInputFromCandidate(
  candidate: SkillCandidate,
  existingSkills: readonly SkillRegistryEntry[],
): CreateSkillImportDraftInput {
  if (candidate.status !== "approved_for_draft") {
    throw new Error("Skill candidate must be approved_for_draft before creating a registry draft");
  }
  if (
    candidate.duplicateAnalysis.decision === "update_existing" ||
    candidate.duplicateAnalysis.decision === "conflict_review" ||
    candidate.duplicateAnalysis.decision === "reject_duplicate"
  ) {
    throw new Error(`Skill candidate duplicate analysis requires review before draft creation: ${candidate.duplicateAnalysis.decision}`);
  }
  const warnings: SkillImportWarning[] = [];
  const definition = candidate.definition.skillDefinition && isCompleteSkillDefinition(candidate.definition.skillDefinition)
    ? candidate.definition.skillDefinition
    : synthesizeSkillDefinitionFromCandidate(candidate, existingSkills, warnings);
  const definitionWarnings = skillDefinitionWarnings(definition, existingSkills);
  return {
    source: "custom",
    sourcePath: `skill-candidates/${candidate.id}`,
    packId: "ling-generated",
    name: candidate.title,
    description: candidate.summary,
    definitions: [{
      definition,
      warnings: definitionWarnings,
      visibility: {
        workspaceVisible: true,
        promotableToWorkspace: true,
      },
    }],
    warnings,
  };
}

function synthesizeSkillDefinitionFromCandidate(
  candidate: SkillCandidate,
  existingSkills: readonly SkillRegistryEntry[],
  warnings: SkillImportWarning[],
): SkillDefinition {
  const requestedId = slugSkillId(candidate.title);
  const id = uniqueSkillId(requestedId, candidate.id, existingSkills);
  const workflowPhase = normalizeWorkflowPhase(candidate.definition.workflowPhase, warnings);
  const requiredTools = normalizeRunTools(candidate.definition.requiredTools, warnings);
  const requiredProviderCapabilities = normalizeProviderCapabilities(candidate.definition.requiredProviderCapabilities, warnings);
  return {
    id,
    name: candidate.title,
    summary: candidate.summary,
    roleAffinity: ["custom"],
    workflowPhase,
    promptFragments: [candidatePromptFragment(candidate)],
    requiredTools,
    requiredProviderCapabilities,
    approvalProfile: { mode: "none" },
    stateEffects: [],
  };
}

function skillDefinitionWarnings(
  definition: SkillDefinition,
  existingSkills: readonly SkillRegistryEntry[],
): SkillImportWarning[] {
  const warnings: SkillImportWarning[] = [];
  if (existingSkills.some((skill) => skill.id === definition.id)) {
    warnings.push({
      code: "duplicate_skill_id",
      severity: "error",
      message: `Skill id already exists: ${definition.id}`,
    });
  }
  for (const tool of definition.requiredTools) {
    if (!supportedRunTools().includes(tool)) {
      warnings.push({
        code: "unknown_tool",
        severity: "error",
        message: `Required tool is unsupported: ${tool}`,
      });
    }
  }
  for (const capability of definition.requiredProviderCapabilities) {
    if (!(providerCapabilities as readonly string[]).includes(capability)) {
      warnings.push({
        code: "unknown_provider_capability",
        severity: "error",
        message: `Provider capability is unsupported: ${capability}`,
      });
    }
  }
  return warnings;
}

function isCompleteSkillDefinition(value: SkillDefinition): boolean {
  return Boolean(
    value.id &&
    value.name &&
    value.summary &&
    Array.isArray(value.roleAffinity) &&
    Array.isArray(value.promptFragments) &&
    Array.isArray(value.requiredTools) &&
    Array.isArray(value.requiredProviderCapabilities) &&
    value.approvalProfile &&
    Array.isArray(value.stateEffects),
  );
}

function candidatePromptFragment(candidate: SkillCandidate): string {
  const lines = [
    `# ${candidate.title}`,
    "",
    candidate.summary,
    "",
    "Use when:",
    ...candidate.definition.positiveTriggers.map((trigger) => `- ${trigger}`),
    "",
    "Do not use when:",
    ...candidate.definition.negativeTriggers.map((trigger) => `- ${trigger}`),
    "",
    "Procedure:",
    ...candidate.definition.procedureSteps.map((step, index) => `- ${index + 1}. ${step.title}${step.instruction ? `: ${step.instruction}` : ""}`),
    "",
    "Validation:",
    ...candidate.definition.validationSteps.map((step) => `- ${step.title}${step.commandOrCheck ? `: ${step.commandOrCheck}` : ""}${step.expectedResult ? ` -> ${step.expectedResult}` : ""}`),
  ];
  return lines.join("\n").slice(0, 12_000);
}

function normalizeWorkflowPhase(value: string, warnings: SkillImportWarning[]): SkillWorkflowPhase {
  const phases = ["discover", "plan", "design", "implement", "review", "test", "secure", "ship", "document", "operate"] as const;
  if ((phases as readonly string[]).includes(value)) {
    return value as SkillWorkflowPhase;
  }
  warnings.push({
    code: "unsupported_section",
    severity: "warning",
    message: `Unsupported workflow phase "${value}" was normalized to operate.`,
  });
  return "operate";
}

function normalizeRunTools(values: readonly (RunTool | string)[], warnings: SkillImportWarning[]): RunTool[] {
  const supported = supportedRunTools();
  const accepted: RunTool[] = [];
  for (const value of values) {
    if (supported.includes(value as RunTool)) {
      accepted.push(value as RunTool);
    } else {
      warnings.push({
        code: "unknown_tool",
        severity: "error",
        message: `Required tool is unsupported: ${value}`,
      });
    }
  }
  return accepted.length > 0 ? [...new Set(accepted)] : [...readOnlyRunTools];
}

function normalizeProviderCapabilities(
  values: readonly (ProviderCapability | string)[],
  warnings: SkillImportWarning[],
): ProviderCapability[] {
  const accepted: ProviderCapability[] = [];
  for (const value of values) {
    if ((providerCapabilities as readonly string[]).includes(value)) {
      accepted.push(value as ProviderCapability);
    } else {
      warnings.push({
        code: "unknown_provider_capability",
        severity: "error",
        message: `Provider capability is unsupported: ${value}`,
      });
    }
  }
  return accepted.length > 0 ? [...new Set(accepted)] : ["chat", "reasoning"];
}

function supportedRunTools(): readonly RunTool[] {
  return [...readOnlyRunTools, ...riskyRunTools];
}

function uniqueSkillId(requestedId: string, candidateId: string, existingSkills: readonly SkillRegistryEntry[]): string {
  const existingIds = new Set(existingSkills.map((skill) => skill.id));
  if (!existingIds.has(requestedId)) {
    return requestedId;
  }
  const suffix = candidateId.replace(/^skill_candidate_/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 20) || "candidate";
  return `${requestedId}-${suffix}`;
}

function slugSkillId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill-candidate";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function candidateIdFromSkillSourcePath(sourcePath: string | undefined): string | undefined {
  const prefix = "skill-candidates/";
  if (!sourcePath?.startsWith(prefix)) {
    return undefined;
  }
  return sourcePath.slice(prefix.length) || undefined;
}
