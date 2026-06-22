import type { IncomingMessage, ServerResponse } from "node:http";
import {
  analyzeSkillDuplicate,
  buildEffectiveTeammateSkills,
  buildSkillHealthReport,
  buildSkillSourceHealthReport,
  createProcedureObservationJobFromRecording,
  createProcedureObservationInputFromJob,
  DEFAULT_WORKSPACE_ID,
  previewGstackSkillSourceSync,
  resolveSkillSourceRoots,
  isExplicitObservationJob,
  procedureObservationHasTerminalStatus,
  procedureObservationHasJobKey,
  providerCapabilities,
  readOnlyRunTools,
  riskyRunTools,
  suggestSkillInvocations,
  type CreateSkillCandidateInput,
  type CreateSkillImportDraftInput,
  type CandidateGenerationDecision,
  type CandidateGenerationDecisionAction,
  type CandidateGenerationDecisionSource,
  type CandidateRoute,
  type ProviderCapability,
  type ProcedureObservation,
  type ProcedureObservationJobInput,
  type RunTool,
  type SkillCandidate,
  type SkillCandidateHealthInput,
  type SkillDefinition,
  type SkillDuplicateAnalysis,
  type SkillImportWarning,
  type SkillRegistryEntry,
  type SkillSourceScanRoot,
  type SkillSourceSyncPreviewRecord,
  type SkillSourceSyncPreviewReport,
  type SkillSourceSnapshot,
  type SkillWorkflowPhase,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { SkillRoute } from "../../server/routes.js";
import { readJsonBody, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listEffectiveSkillRegistryEntries, listExecutableSkillDefinitions, refreshEffectiveSkillRegistryEntries } from "./registry.js";
import {
  parseCreateSkillCandidateRequest,
  parseSkillInvocationSuggestionRequest,
  parseProcedureObservationJobRequest,
  parseProcedureObservationRequest,
  parseSkillRecordingObservationRequest,
  parseSkillCorrectionRequest,
  parseSkillCandidateReviewRequest,
  parseSkillImportDraftRequest,
  parseSkillSourceSyncPublishRequest,
  parseSkillSourceSyncRequest,
  readOptionalCandidateGenerationDecisionActionQuery,
  readOptionalCandidateRouteKindQuery,
  readOptionalProcedureObservationClusterStatusQuery,
  readOptionalSkillCandidateOriginQuery,
  readOptionalSkillCandidateStatusQuery,
  readOptionalSkillUsageEventKindQuery,
  type ParsedCreateSkillCandidateRequest,
} from "./schemas.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";

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

    if (url.pathname === "/skills/source-health") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/source-health` });
        return;
      }
      const report = buildSkillSourceHealthReport({
        workspaceId: DEFAULT_WORKSPACE_ID,
        skills: listEffectiveSkillRegistryEntries(store),
        snapshots: store.listSkillSourceSnapshots(),
        generatedAt: new Date().toISOString(),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      writeJson(response, 200, {
        cwd,
        report,
        snapshots: store.listSkillSourceSnapshots({ reviewStatus: "published" }),
      });
      return;
    }

    if (url.pathname === "/skills/sync/gstack/preview") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/sync/gstack/preview` });
        return;
      }
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const input = parseSkillSourceSyncRequest(body);
      const preview = await buildGstackSkillSourceSyncPreview(cwd, store, input);
      writeJson(response, 200, { cwd, preview });
      return;
    }

    if (url.pathname === "/skills/sync/gstack/refresh") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/sync/gstack/refresh` });
        return;
      }
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const input = parseSkillSourceSyncRequest(body);
      const refreshedAt = new Date().toISOString();
      const preview = await buildGstackSkillSourceSyncPreview(cwd, store, input, refreshedAt);
      writeJson(response, 200, { cwd, refreshedAt, preview });
      return;
    }

    if (url.pathname === "/skills/sync/gstack/publish") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/sync/gstack/publish` });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseSkillSourceSyncPublishRequest(body);
      const now = new Date().toISOString();
      const preview = await buildGstackSkillSourceSyncPreview(cwd, store, input, now);
      const result = publishGstackSkillSourceSync({
        store,
        controlPlaneEvents,
        cwd,
        preview,
        selectedSkillIds: input.selectedSkillIds,
        allowNewSkills: input.allowNewSkills,
        now,
      });
      writeJson(response, 200, { cwd, publishedAt: now, preview, skills: result.skills, snapshots: result.snapshots });
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

    if (url.pathname === "/skills/suggestions") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/suggestions` });
        return;
      }
      const now = new Date().toISOString();
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseSkillInvocationSuggestionRequest(body);
      const teammate = resolveAiTeammateReference(store, input.teammateId);
      if (!teammate) {
        writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${input.teammateId}` });
        return;
      }
      const channel = input.channelId ? store.getChannel(input.channelId) : undefined;
      if (input.channelId && !channel) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const providerPreset = input.providerPresetId ? store.getProviderPreset(input.providerPresetId) : undefined;
      if (input.providerPresetId && !providerPreset) {
        writeJson(response, 404, { error: "provider_preset_not_found", message: `Provider preset not found: ${input.providerPresetId}` });
        return;
      }
      const effectiveSkills = buildEffectiveTeammateSkills({
        teammate,
        bindings: store.listTeammateSkillBindings(teammate.id),
        skills: listExecutableSkillDefinitions(store),
        channelAllowedTools: channel?.allowedTools,
        providerCapabilities: providerPreset?.capabilities,
      });
      const healthReport = buildSkillHealthReport({
        workspaceId: DEFAULT_WORKSPACE_ID,
        skills: listEffectiveSkillRegistryEntries(store),
        candidates: store.listSkillCandidates({ limit: 500 }).map(skillCandidateHealthInputFromCandidate),
        usageStats: store.listSkillUsageStats(),
        generatedAt: now,
        limit: 100,
      });
      writeJson(response, 200, {
        cwd,
        suggestions: suggestSkillInvocations({
          context: input,
          effectiveSkills,
          healthFindings: healthReport.findings,
          limit: input.limit,
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

    if (url.pathname === "/candidate-generation-decisions") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /candidate-generation-decisions` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        decisions: store.listCandidateGenerationDecisions({
          observationId: url.searchParams.get("observationId") || undefined,
          clusterId: url.searchParams.get("clusterId") || undefined,
          decision: readOptionalCandidateGenerationDecisionActionQuery(url, "decision"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (url.pathname === "/procedure-observation-clusters") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /procedure-observation-clusters` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        clusters: store.listProcedureObservationClusters({
          channelId: url.searchParams.get("channelId") || undefined,
          routeKind: readOptionalCandidateRouteKindQuery(url, "routeKind"),
          status: readOptionalProcedureObservationClusterStatusQuery(url, "status"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    const clusterId = procedureObservationClusterIdFromPath(url.pathname);
    if (clusterId) {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /procedure-observation-clusters/:id` });
        return;
      }
      const cluster = store.getProcedureObservationCluster(clusterId);
      if (!cluster) {
        writeJson(response, 404, { error: "procedure_observation_cluster_not_found", message: `Procedure observation cluster not found: ${clusterId}` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        cluster,
        observations: store.listProcedureObservations({ clusterId, limit: 500 }),
      });
      return;
    }

    if (url.pathname === "/procedure-observations") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          observations: store.listProcedureObservations({
            clusterId: url.searchParams.get("clusterId") || undefined,
            channelId: url.searchParams.get("channelId") || undefined,
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
      const result = processProcedureObservationJob({ store, controlPlaneEvents, cwd, job, now });
      writeJson(response, result.statusCode, result.body);
      return;
    }

    if (url.pathname === "/skill-recordings") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skill-recordings` });
        return;
      }
      const policy = store.getWorkspaceSettings().skillGovernancePolicy;
      if (policy.recordingMode !== "user_initiated") {
        writeJson(response, 409, {
          error: "skill_recording_disabled",
          message: "Skill recording is disabled by the workspace skill governance policy.",
        });
        return;
      }
      const now = new Date().toISOString();
      const body = await readJsonBody(request, config.maxBodyBytes);
      const job = createProcedureObservationJobFromRecording(parseSkillRecordingObservationRequest(body));
      const result = processProcedureObservationJob({ store, controlPlaneEvents, cwd, job, now });
      writeJson(response, result.statusCode, {
        ...result.body,
        generationMode: policy.generationMode,
        recordingMode: policy.recordingMode,
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
        const generationDecision = persistGenerationDecision(store, {
          observation,
          route,
          source: generationSourceFromObservation(observation),
          decision: generationDecisionActionForRoute(route),
          reason: generationReasonForRoute(route),
          now,
        });
        writeJson(response, 202, { cwd, observation, route, action: route.blockers.length > 0 ? "blocked" : "routed_elsewhere", generationDecision });
        return;
      }
      if (route.blockers.length > 0) {
        const generationDecision = persistGenerationDecision(store, {
          observation,
          route,
          source: generationSourceFromObservation(observation),
          decision: "append_evidence",
          reason: `Skill candidate generation is blocked until gates are complete: ${route.blockers.join(", ")}.`,
          now,
        });
        writeJson(response, 202, { cwd, observation, route, action: "blocked", generationDecision });
        return;
      }
      const input = skillCandidateInputFromObservation(observation);
      const withAnalysis = withDuplicateAnalysis(input, store);
      if (withAnalysis.duplicateAnalysis.decision !== "no_overlap") {
        const generationDecision = persistGenerationDecision(store, {
          observation,
          route,
          source: generationSourceFromObservation(observation),
          decision: "append_evidence",
          duplicateAnalysis: withAnalysis.duplicateAnalysis,
          reason: `Duplicate analysis returned ${withAnalysis.duplicateAnalysis.decision}; evidence was retained without creating a new skill candidate.`,
          now,
        });
        writeJson(response, 202, {
          cwd,
          observation,
          route,
          action: "evidence_recorded",
          duplicateAnalysis: withAnalysis.duplicateAnalysis,
          generationDecision,
        });
        return;
      }
      const candidate = store.createSkillCandidate(withAnalysis, now);
      const generationDecision = persistGenerationDecision(store, {
        observation,
        route,
        source: generationSourceFromObservation(observation),
        decision: "create_skill_candidate",
        duplicateAnalysis: candidate.duplicateAnalysis,
        createdCandidateId: candidate.id,
        reason: "Observation passed routing gates and duplicate analysis, so a pending skill candidate was created.",
        now,
      });
      appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "observe_create", candidate.id, candidate.status);
      writeJson(response, 201, {
        cwd,
        observation,
        route,
        action: "candidate_created",
        candidate,
        duplicateAnalysis: candidate.duplicateAnalysis,
        generationDecision,
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

    if (route.kind === "skill" && route.action === "source") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/:id/source` });
        return;
      }
      if (!listEffectiveSkillRegistryEntries(store).some((skill) => skill.id === route.skillId)) {
        writeJson(response, 404, { error: "skill_not_found", message: `Skill not found: ${route.skillId}` });
        return;
      }
      const snapshot = store.getSkillSourceSnapshot(route.skillId);
      if (!snapshot) {
        writeJson(response, 404, { error: "skill_source_snapshot_not_found", message: `Skill source snapshot not found: ${route.skillId}` });
        return;
      }
      writeJson(response, 200, { cwd, snapshot });
      return;
    }

    if (route.kind === "skill" && route.action === "source-archive") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/:id/source/archive` });
        return;
      }
      if (!listEffectiveSkillRegistryEntries(store).some((skill) => skill.id === route.skillId)) {
        writeJson(response, 404, { error: "skill_not_found", message: `Skill not found: ${route.skillId}` });
        return;
      }
      const now = new Date().toISOString();
      const snapshot = store.archiveSkillSourceSnapshot(route.skillId, now);
      if (!snapshot) {
        writeJson(response, 404, { error: "skill_source_snapshot_not_found", message: `Skill source snapshot not found: ${route.skillId}` });
        return;
      }
      writeJson(response, 200, { cwd, snapshot });
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

function procedureObservationClusterIdFromPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "procedure-observation-clusters") {
    return segments[1];
  }
  return undefined;
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

type SkillRouteStore = ReturnType<RunStoreRegistry["getStore"]>;

async function buildGstackSkillSourceSyncPreview(
  cwd: string,
  store: SkillRouteStore,
  input: {
    readonly roots?: readonly SkillSourceScanRoot[];
    readonly skillRoots?: readonly string[];
    readonly gstackRepoRoots?: readonly string[];
    readonly codexSkillRoots?: readonly string[];
    readonly includeDetectedRoots?: boolean;
    readonly includeSkillIds?: readonly string[];
    readonly excludeSkillIds?: readonly string[];
    readonly maxSourceBytes?: number;
  },
  generatedAt = new Date().toISOString(),
): Promise<SkillSourceSyncPreviewReport> {
  const roots = input.roots?.length
    ? input.roots
    : await resolveSkillSourceRoots({
        workspaceRoot: hasExplicitSourceRootInputs(input) ? undefined : cwd,
        skillRoots: input.skillRoots,
        gstackRepoRoots: input.gstackRepoRoots,
        codexSkillRoots: input.codexSkillRoots,
        includeDetectedRoots: input.includeDetectedRoots ?? !hasExplicitSourceRootInputs(input),
      });
  return previewGstackSkillSourceSync({
    roots,
    registrySkills: listEffectiveSkillRegistryEntries(store),
    snapshots: store.listSkillSourceSnapshots({ includeArchived: true }),
    includeSkillIds: input.includeSkillIds,
    excludeSkillIds: input.excludeSkillIds,
    generatedAt,
    maxSourceBytes: input.maxSourceBytes,
  });
}

function publishGstackSkillSourceSync(input: {
  readonly store: SkillRouteStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly cwd: string;
  readonly preview: SkillSourceSyncPreviewReport;
  readonly selectedSkillIds: readonly string[];
  readonly allowNewSkills: boolean;
  readonly now: string;
}): { readonly skills: readonly SkillRegistryEntry[]; readonly snapshots: readonly SkillSourceSnapshot[] } {
  const selectedSkillIds = uniqueStrings(input.selectedSkillIds);
  const recordsBySkillId = new Map(input.preview.records.map((record) => [record.skillId, record]));
  const missingSelections = selectedSkillIds.filter((skillId) => !recordsBySkillId.has(skillId));
  if (missingSelections.length > 0) {
    throw new HttpError(400, "skill_source_sync_selection_not_found", `Selected skill source records were not found: ${missingSelections.join(", ")}`);
  }
  const selectedRecords = selectedSkillIds.map((skillId) => recordsBySkillId.get(skillId)).filter((record): record is SkillSourceSyncPreviewRecord => Boolean(record));
  const nonPublishable = selectedRecords.filter((record) => record.state === "blocked" || record.state === "missing" || record.state === "orphaned");
  if (nonPublishable.length > 0) {
    throw new HttpError(409, "skill_source_sync_not_publishable", `Selected records are not publishable: ${nonPublishable.map((record) => `${record.skillId}:${record.state}`).join(", ")}`);
  }
  const newRecords = selectedRecords.filter((record) => record.state === "new");
  if (newRecords.length > 0 && !input.allowNewSkills) {
    throw new HttpError(409, "skill_source_sync_new_skills_require_confirmation", `New skills require allowNewSkills=true: ${newRecords.map((record) => record.skillId).join(", ")}`);
  }

  if (newRecords.length > 0) {
    const draft = input.store.createSkillImportDraft({
      source: "gstack",
      packId: "gstack-source-sync",
      name: "GStack source sync",
      version: input.preview.upstreamVersions[0],
      description: "Source-backed gstack skills published through explicit source sync.",
      definitions: newRecords.map((record) => {
        if (!record.definitionPreview) {
          throw new HttpError(409, "skill_source_sync_missing_definition", `No normalized skill definition preview is available for ${record.skillId}.`);
        }
        return {
          definition: record.definitionPreview,
          visibility: {
            workspaceVisible: true,
            promotableToWorkspace: true,
          },
        };
      }),
    }, input.now);
    input.store.publishSkillImportDraft(draft.id, input.now);
  }

  const snapshots: SkillSourceSnapshot[] = [];
  for (const record of selectedRecords) {
    if (!record.snapshotPreview) {
      throw new HttpError(409, "skill_source_sync_missing_snapshot", `No source snapshot preview is available for ${record.skillId}.`);
    }
    snapshots.push(input.store.upsertSkillSourceSnapshot({
      ...record.snapshotPreview,
      id: record.existingSnapshotId,
      reviewStatus: "published",
    }, input.now));
  }

  const skillsById = new Map(listEffectiveSkillRegistryEntries(input.store).map((skill) => [skill.id, skill]));
  const skills = selectedSkillIds.map((skillId) => skillsById.get(skillId)).filter((skill): skill is SkillRegistryEntry => Boolean(skill));
  appendSkillRegistryChangedEvent(input.store, input.controlPlaneEvents, input.cwd, "source_publish", selectedSkillIds[0] ?? "default");
  return { skills, snapshots };
}

function hasExplicitSourceRootInputs(input: {
  readonly skillRoots?: readonly string[];
  readonly gstackRepoRoots?: readonly string[];
  readonly codexSkillRoots?: readonly string[];
}): boolean {
  return Boolean(input.skillRoots?.length || input.gstackRepoRoots?.length || input.codexSkillRoots?.length);
}

interface ProcedureObservationJobRouteResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

function processProcedureObservationJob(input: {
  readonly store: SkillRouteStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly cwd: string;
  readonly job: ProcedureObservationJobInput;
  readonly now: string;
}): ProcedureObservationJobRouteResult {
  const { store, controlPlaneEvents, cwd, job, now } = input;
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
  const existing = store.listProcedureObservations({ limit: 500 })
    .find((observation) => procedureObservationHasJobKey(observation, built.jobKey));
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
      appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "post_run_observation_create", candidate.id, candidate.status);
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
  appendSkillCandidateChangedEvent(store, controlPlaneEvents, cwd, "observation_job_create", candidate.id, candidate.status);
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

function persistGenerationDecision(
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

function generationSourceFromObservation(observation: ProcedureObservation): CandidateGenerationDecisionSource {
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

function generationDecisionActionForRoute(route: CandidateRoute): CandidateGenerationDecisionAction {
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

function generationReasonForRoute(route: CandidateRoute): string {
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
