import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ChannelPlaybookCandidate,
  ChannelPlaybookCandidateStatus,
  ProcedureObservation,
  ProcedureObservationCluster,
  ProcedureObservationStep,
  ProcedureObservationValidationStep,
  RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";

export async function handleChannelPlaybookCandidates(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  action?: "candidates" | "candidate-from-cluster" | "review-candidate",
  candidateId?: string,
  clusterId?: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if ((action === "candidates" || !action) && request.method === "GET") {
      const status = readPlaybookCandidateStatusFilter(url.searchParams.get("status"));
      writeJson(response, 200, {
        cwd,
        channelId,
        candidates: store.listChannelPlaybookCandidates({
          channelId,
          status,
          limit: readLimit(url.searchParams.get("limit")),
        }),
      });
      return;
    }

    if (action === "candidate-from-cluster" && request.method === "POST") {
      if (!clusterId) {
        writeJson(response, 400, { error: "bad_request", message: "Procedure observation cluster id is required." });
        return;
      }
      const cluster = store.getProcedureObservationCluster(clusterId);
      if (!cluster) {
        writeJson(response, 404, { error: "procedure_observation_cluster_not_found", message: `Procedure observation cluster not found: ${clusterId}` });
        return;
      }
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const input = parsePlaybookCandidateFromClusterInput(body);
      const observations = store.listProcedureObservations({ clusterId: cluster.id, limit: 100 });
      const built = playbookCandidateInputFromCluster(cluster, observations, channelId, input);
      if ("error" in built) {
        writeJson(response, built.statusCode, built.error);
        return;
      }
      const existing = store.listChannelPlaybookCandidates({ channelId, limit: 200 })
        .find((candidate) => isReusablePlaybookCandidate(candidate, built));
      if (existing) {
        writeJson(response, 200, { cwd, channelId, candidate: existing });
        return;
      }
      const candidate = store.createChannelPlaybookCandidate({
        channelId,
        ...built,
        createdBy: "ai-draft",
      }, new Date().toISOString());
      writeJson(response, 201, { cwd, channelId, candidate });
      return;
    }

    if (action === "review-candidate" && request.method === "POST") {
      if (!candidateId) {
        writeJson(response, 400, { error: "bad_request", message: "Playbook candidate id is required." });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const reviewAction = readPlaybookCandidateReviewAction(body);
      const reviewed = reviewPlaybookCandidate(store, channelId, candidateId, reviewAction);
      if ("error" in reviewed) {
        writeJson(response, reviewed.statusCode, reviewed.error);
        return;
      }
      writeJson(response, 200, { cwd, channelId, candidate: reviewed.candidate });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel playbook candidates` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

type PlaybookCandidateFromClusterInput = {
  readonly title?: string;
  readonly summary?: string;
  readonly normalizedGoal?: string;
  readonly procedureSteps?: readonly ProcedureObservationStep[];
  readonly validationSteps?: readonly ProcedureObservationValidationStep[];
  readonly positiveTriggers?: readonly string[];
  readonly negativeTriggers?: readonly string[];
  readonly reason?: string;
  readonly expiresAt?: string;
};

function playbookCandidateInputFromCluster(
  cluster: ProcedureObservationCluster,
  observations: readonly ProcedureObservation[],
  channelId: string,
  input: PlaybookCandidateFromClusterInput,
):
  | {
    readonly title: string;
    readonly summary: string;
    readonly normalizedGoal: string;
    readonly procedureSteps: readonly ProcedureObservationStep[];
    readonly validationSteps: readonly ProcedureObservationValidationStep[];
    readonly positiveTriggers: readonly string[];
    readonly negativeTriggers: readonly string[];
    readonly sourceRefs: ProcedureObservationCluster["sourceRefs"];
    readonly reason: string;
    readonly expiresAt?: string;
  }
  | { readonly statusCode: number; readonly error: Record<string, unknown> } {
  if (cluster.channelId !== channelId) {
    return {
      statusCode: 400,
      error: {
        error: "procedure_observation_cluster_channel_mismatch",
        message: `Procedure observation cluster ${cluster.id} does not belong to channel ${channelId}.`,
      },
    };
  }
  if (cluster.routeKind !== "playbook") {
    return {
      statusCode: 400,
      error: {
        error: "unsupported_procedure_observation_cluster_route",
        message: `Only playbook clusters can create channel playbook candidates. Cluster route is ${cluster.routeKind}.`,
      },
    };
  }
  if (cluster.status !== "ready_for_review" || cluster.routeBlockers.length > 0) {
    return {
      statusCode: 400,
      error: {
        error: "procedure_observation_cluster_not_ready",
        message: `Procedure observation cluster ${cluster.id} is ${cluster.status}.`,
        blockers: cluster.routeBlockers,
      },
    };
  }
  const procedureSteps = input.procedureSteps ?? uniqueProcedureSteps(observations.flatMap((observation) => observation.procedureSteps));
  if (procedureSteps.length === 0) {
    return {
      statusCode: 400,
      error: {
        error: "procedure_observation_cluster_missing_steps",
        message: `Procedure observation cluster ${cluster.id} does not include procedure steps.`,
      },
    };
  }
  return {
    title: input.title ?? cluster.title,
    summary: input.summary ?? cluster.summary,
    normalizedGoal: input.normalizedGoal ?? cluster.normalizedGoal,
    procedureSteps,
    validationSteps: input.validationSteps ?? uniqueValidationSteps(observations.flatMap((observation) => observation.validationSteps)),
    positiveTriggers: input.positiveTriggers ?? cluster.positiveTriggers,
    negativeTriggers: input.negativeTriggers ?? cluster.negativeTriggers,
    sourceRefs: cluster.sourceRefs,
    reason: input.reason ?? `Created from procedure observation cluster ${cluster.id}: ${cluster.title}`,
    expiresAt: input.expiresAt,
  };
}

function uniqueProcedureSteps(steps: readonly ProcedureObservationStep[]): readonly ProcedureObservationStep[] {
  const seen = new Set<string>();
  const unique: ProcedureObservationStep[] = [];
  for (const step of steps) {
    const key = `${step.title}\n${step.instruction ?? ""}\n${(step.requiredTools ?? []).join(",")}\n${step.expectedEvidence ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(step);
  }
  return unique;
}

function uniqueValidationSteps(steps: readonly ProcedureObservationValidationStep[]): readonly ProcedureObservationValidationStep[] {
  const seen = new Set<string>();
  const unique: ProcedureObservationValidationStep[] = [];
  for (const step of steps) {
    const key = `${step.title}\n${step.commandOrCheck ?? ""}\n${step.expectedResult ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(step);
  }
  return unique;
}

function reviewPlaybookCandidate(
  store: RunStore,
  channelId: string,
  candidateId: string,
  action: "approve" | "reject",
):
  | { readonly candidate: ChannelPlaybookCandidate }
  | { readonly statusCode: number; readonly error: Record<string, unknown> } {
  const candidate = store.getChannelPlaybookCandidate(candidateId);
  if (!candidate || candidate.channelId !== channelId) {
    return {
      statusCode: 404,
      error: { error: "playbook_candidate_not_found", message: `Channel playbook candidate not found: ${candidateId}` },
    };
  }
  if (candidate.status !== "draft") {
    return {
      statusCode: 409,
      error: { error: "playbook_candidate_not_reviewable", message: `Channel playbook candidate is ${candidate.status}.`, candidate },
    };
  }
  const now = new Date().toISOString();
  const updated = store.updateChannelPlaybookCandidate(candidate.id, {
    status: action === "approve" ? "active" : "cancelled",
    activatedAt: action === "approve" ? now : null,
  }, now);
  if (!updated) {
    return {
      statusCode: 404,
      error: { error: "playbook_candidate_not_found", message: `Channel playbook candidate not found: ${candidateId}` },
    };
  }
  return { candidate: updated };
}

function isReusablePlaybookCandidate(
  candidate: ChannelPlaybookCandidate,
  built: { readonly normalizedGoal: string; readonly sourceRefs: ProcedureObservationCluster["sourceRefs"] },
): boolean {
  if (candidate.status !== "draft" && candidate.status !== "active") {
    return false;
  }
  if (candidate.normalizedGoal === built.normalizedGoal) {
    return true;
  }
  const sourceRefKeys = new Set(built.sourceRefs.map((sourceRef) => `${sourceRef.type}:${sourceRef.id}`));
  return candidate.sourceRefs.some((sourceRef) => sourceRefKeys.has(`${sourceRef.type}:${sourceRef.id}`));
}

function parsePlaybookCandidateFromClusterInput(value: unknown): PlaybookCandidateFromClusterInput {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("channel playbook candidate input must be an object");
  }
  return {
    title: readOptionalNonEmptyString(value.title, "title"),
    summary: readOptionalNonEmptyString(value.summary, "summary"),
    normalizedGoal: readOptionalNonEmptyString(value.normalizedGoal, "normalizedGoal"),
    procedureSteps: readOptionalProcedureSteps(value.procedureSteps),
    validationSteps: readOptionalValidationSteps(value.validationSteps),
    positiveTriggers: readOptionalStringList(value.positiveTriggers, "positiveTriggers"),
    negativeTriggers: readOptionalStringList(value.negativeTriggers, "negativeTriggers"),
    reason: readOptionalNonEmptyString(value.reason, "reason"),
    expiresAt: readOptionalNonEmptyString(value.expiresAt, "expiresAt"),
  };
}

function readPlaybookCandidateReviewAction(value: unknown): "approve" | "reject" {
  if (!isRecord(value) || (value.action !== "approve" && value.action !== "reject")) {
    throw new Error("channel playbook candidate review action must be approve or reject");
  }
  return value.action;
}

function readPlaybookCandidateStatusFilter(value: string | null): ChannelPlaybookCandidateStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== "draft" && value !== "active" && value !== "cancelled" && value !== "stale") {
    throw new Error("channel playbook candidate status filter is not supported");
  }
  return value;
}

function readLimit(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("limit must be a positive integer");
  }
  return parsed;
}

function readOptionalProcedureSteps(value: unknown): readonly ProcedureObservationStep[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("procedureSteps must be an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("procedureSteps must contain objects");
    }
    return {
      title: readRequiredNonEmptyString(item.title, "procedureSteps.title"),
      instruction: readOptionalNonEmptyString(item.instruction, "procedureSteps.instruction"),
      requiredTools: readOptionalStringList(item.requiredTools, "procedureSteps.requiredTools"),
      expectedEvidence: readOptionalNonEmptyString(item.expectedEvidence, "procedureSteps.expectedEvidence"),
    };
  });
}

function readOptionalValidationSteps(value: unknown): readonly ProcedureObservationValidationStep[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("validationSteps must be an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("validationSteps must contain objects");
    }
    return {
      title: readRequiredNonEmptyString(item.title, "validationSteps.title"),
      commandOrCheck: readOptionalNonEmptyString(item.commandOrCheck, "validationSteps.commandOrCheck"),
      expectedResult: readOptionalNonEmptyString(item.expectedResult, "validationSteps.expectedResult"),
    };
  });
}

function readOptionalStringList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function readOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredNonEmptyString(value, label);
}

function readRequiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
