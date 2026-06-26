import type { IncomingMessage, ServerResponse } from "node:http";
import {
  channelTeamPatternCreatedByValues,
  channelTeamPatternStatuses,
  channelTeamProvisionalRuleEffects,
} from "@ling-stack/core";
import type {
  ChannelTeamPatternCreatedBy,
  ChannelTeamPatternStatus,
  ChannelTeamProvisionalRuleEffect,
  CreateChannelTeamPatternInput,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalBooleanQuery, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

export async function handleChannelTeamPatterns(
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

    const now = new Date().toISOString();
    if (request.method === "GET") {
      const status = readOptionalPatternStatusQuery(url);
      const patterns = store.listChannelTeamPatterns({
        channelId,
        status,
        includeExpired: readOptionalBooleanQuery(url, "includeExpired"),
        now,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      writeJson(response, 200, { cwd, channelId, patterns });
      return;
    }

    if (request.method === "POST") {
      const pattern = store.createChannelTeamPattern(parseCreateChannelTeamPatternInput(channelId, await readJsonBody(request, 64_000)), now);
      writeJson(response, 201, { cwd, channelId, pattern });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel team patterns` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function readOptionalPatternStatusQuery(url: URL): ChannelTeamPatternStatus | undefined {
  const rawStatus = url.searchParams.get("status");
  if (rawStatus === null) {
    return undefined;
  }
  if (!channelTeamPatternStatuses.includes(rawStatus as ChannelTeamPatternStatus)) {
    throw new Error("status is not supported");
  }
  return rawStatus as ChannelTeamPatternStatus;
}

function parseCreateChannelTeamPatternInput(channelId: string, value: unknown): CreateChannelTeamPatternInput {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const status = readOptionalPatternStatus(value.status);
  return {
    channelId,
    pattern: readRequiredString(value.pattern, "pattern"),
    summary: readRequiredString(value.summary, "summary"),
    evidenceCount: readOptionalNonNegativeInteger(value.evidenceCount, "evidenceCount"),
    adoptedCount: readOptionalNonNegativeInteger(value.adoptedCount, "adoptedCount"),
    failureCount: readOptionalNonNegativeInteger(value.failureCount, "failureCount"),
    sourceRefs: readOptionalSourceRefs(value.sourceRefs),
    status,
    createdBy: readOptionalCreatedBy(value.createdBy),
    provisionalEffect: readOptionalProvisionalEffect(value.provisionalEffect),
    provisionalRationale: readOptionalString(value.provisionalRationale),
    verifyBeforeUse: readOptionalBoolean(value.verifyBeforeUse, "verifyBeforeUse"),
    supersededByPatternId: readOptionalString(value.supersededByPatternId),
    lastSeenAt: readOptionalString(value.lastSeenAt),
    expiresAt: readOptionalString(value.expiresAt),
  };
}

function readOptionalPatternStatus(value: unknown): Extract<ChannelTeamPatternStatus, "candidate" | "provisional"> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "candidate" && value !== "provisional") {
    throw new Error("pattern status can only be candidate or provisional on create");
  }
  return value;
}

function readOptionalCreatedBy(value: unknown): ChannelTeamPatternCreatedBy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!channelTeamPatternCreatedByValues.includes(value as ChannelTeamPatternCreatedBy)) {
    throw new Error("createdBy is not supported");
  }
  return value as ChannelTeamPatternCreatedBy;
}

function readOptionalProvisionalEffect(value: unknown): ChannelTeamProvisionalRuleEffect | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!channelTeamProvisionalRuleEffects.includes(value as ChannelTeamProvisionalRuleEffect)) {
    throw new Error("provisionalEffect is not supported");
  }
  return value as ChannelTeamProvisionalRuleEffect;
}

function readOptionalSourceRefs(value: unknown): CreateChannelTeamPatternInput["sourceRefs"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("sourceRefs must be an array");
  }
  return value as CreateChannelTeamPatternInput["sourceRefs"];
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("optional string field must be a string");
  }
  return value;
}

function readOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
