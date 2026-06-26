import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildChannelTeamEvaluationRunInput,
  buildChannelTeamMetricsProjection,
  diffChannelTeamSnapshots,
} from "@ling-stack/core";
import type {
  ChannelTeamEvaluationCase,
  ChannelTeamSnapshotState,
  RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

export async function handleChannelTeamSnapshots(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    if (request.method === "GET") {
      const baseSnapshotId = url.searchParams.get("baseSnapshotId");
      const targetSnapshotId = url.searchParams.get("targetSnapshotId");
      if (baseSnapshotId || targetSnapshotId) {
        const base = baseSnapshotId ? store.getChannelTeamSnapshot(baseSnapshotId) : undefined;
        const target = targetSnapshotId ? store.getChannelTeamSnapshot(targetSnapshotId) : undefined;
        if (!base || !target || base.channelId !== channelId || target.channelId !== channelId) {
          writeJson(response, 404, { error: "snapshot_not_found", message: "Snapshot diff requires two snapshots in this channel" });
          return;
        }
        writeJson(response, 200, { cwd, channelId, diff: diffChannelTeamSnapshots(base, target) });
        return;
      }
      writeJson(response, 200, {
        cwd,
        channelId,
        snapshots: store.listChannelTeamSnapshots({
          channelId,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, 32_000);
      const now = new Date().toISOString();
      const snapshot = store.createChannelTeamSnapshot(
        {
          channelId,
          reason: readSnapshotReason(body),
          createdBy: readSnapshotCreatedBy(body),
          state: buildCurrentSnapshotState(store, channelId, now),
        },
        now,
      );
      writeJson(response, 201, { cwd, channelId, snapshot });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel team snapshots` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelTeamEvaluations(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        evaluations: store.listChannelTeamEvaluationRuns({
          channelId,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, 64_000);
      const now = new Date().toISOString();
      const snapshotId = readOptionalStringField(body, "snapshotId");
      const snapshot = snapshotId ? store.getChannelTeamSnapshot(snapshotId) : undefined;
      if (snapshotId && (!snapshot || snapshot.channelId !== channelId)) {
        writeJson(response, 404, { error: "snapshot_not_found", message: `Snapshot not found: ${snapshotId}` });
        return;
      }
      const cases = [
        ...readEvaluationCases(body),
        ...readRecentMessageCases(store, channelId, body),
      ];
      const evaluation = store.createChannelTeamEvaluationRun(
        buildChannelTeamEvaluationRunInput({
          channelId,
          snapshotId,
          cases,
          now,
        }),
        now,
      );
      writeJson(response, 201, { cwd, channelId, evaluation });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel team evaluations` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildCurrentSnapshotState(store: RunStore, channelId: string, now: string): ChannelTeamSnapshotState {
  const messages = store.listChannelMessages({ channelId, limit: 200 });
  const evidence = store.listChannelTeamEvidenceItems({ channelId, now, limit: 500 });
  const reliabilityIncidents = store.listReliabilityIncidents({ now, limit: 200 });
  const availabilityIncidents = store.listAvailabilityIncidents({ now, limit: 200 });
  const patterns = store.listChannelTeamPatterns({ channelId, now, includeExpired: true, limit: 200 });
  const activeProvisionalRules = store.listActiveChannelTeamProvisionalRules({ channelId, now, limit: 200 });
  const protocol = store.getChannelCollaborationProtocolOverride(channelId);
  return {
    protocol: protocol ? {
      version: protocol.version,
      defaultWorkflowPreference: protocol.defaultWorkflowPreference,
      visibleMultiReplyMaxParticipants: protocol.visibleMultiReplyMaxParticipants,
      privacyRules: protocol.privacyRules,
      reviewRules: protocol.reviewRules,
      updatedAt: protocol.updatedAt,
    } : undefined,
    activeProvisionalRules,
    patterns,
    reliabilityIncidentIds: reliabilityIncidents.map((incident) => incident.id),
    availabilityIncidentIds: availabilityIncidents.map((incident) => incident.id),
    metrics: buildChannelTeamMetricsProjection({
      channelId,
      evidence,
      reliabilityIncidents,
      availabilityIncidents,
      patterns,
      now,
    }),
    messageCount: messages.length,
    latestMessageAt: messages.at(-1)?.updatedAt,
  };
}

function readSnapshotReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string" || value.reason.trim().length === 0) {
    throw new Error("snapshot reason is required");
  }
  return value.reason;
}

function readSnapshotCreatedBy(value: unknown): "system" | "local-user" | "ai-draft" | undefined {
  const createdBy = isRecord(value) ? value.createdBy : undefined;
  if (createdBy === undefined) {
    return undefined;
  }
  if (createdBy !== "system" && createdBy !== "local-user" && createdBy !== "ai-draft") {
    throw new Error("snapshot createdBy is not supported");
  }
  return createdBy;
}

function readEvaluationCases(value: unknown): ChannelTeamEvaluationCase[] {
  if (!isRecord(value)) {
    throw new Error("evaluation request body must be an object");
  }
  if (value.cases === undefined) {
    return [];
  }
  if (!Array.isArray(value.cases)) {
    throw new Error("evaluation cases must be an array");
  }
  return value.cases.map((item, index) => {
    if (!isRecord(item) || typeof item.input !== "string" || item.input.trim().length === 0) {
      throw new Error("evaluation case input is required");
    }
    const expectedRiskReviewStatus = readOptionalStringValue(item.expectedRiskReviewStatus);
    if (
      expectedRiskReviewStatus !== undefined &&
      expectedRiskReviewStatus !== "not_required" &&
      expectedRiskReviewStatus !== "required" &&
      expectedRiskReviewStatus !== "blocked"
    ) {
      throw new Error("evaluation expectedRiskReviewStatus is not supported");
    }
    return {
      id: readOptionalStringValue(item.id) ?? `case_${index + 1}`,
      input: item.input,
      expectedRiskReviewStatus,
      maxObserverCount: readOptionalIntegerValue(item.maxObserverCount),
    };
  });
}

function readRecentMessageCases(store: RunStore, channelId: string, value: unknown): ChannelTeamEvaluationCase[] {
  if (!isRecord(value) || readOptionalBooleanQueryFromBody(value.includeRecentMessages) !== true) {
    return [];
  }
  const limit = readOptionalIntegerValue(value.recentMessageLimit) ?? 10;
  return store
    .listChannelMessages({ channelId, limit })
    .filter((message) => message.authorType === "local-user")
    .map((message) => ({
      id: `historical:${message.id}`,
      input: message.body,
      maxObserverCount: 4,
    }));
}

function readOptionalStringField(value: unknown, field: string): string | undefined {
  return isRecord(value) ? readOptionalStringValue(value[field]) : undefined;
}

function readOptionalStringValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("optional string field must be a string");
  }
  return value;
}

function readOptionalIntegerValue(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("optional integer field must be a positive integer");
  }
  return value;
}

function readOptionalBooleanQueryFromBody(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("optional boolean field must be a boolean");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
