import { getMemorySemanticService } from "./semantic-registry.js";
import { recallMemory } from "./recall-service.js";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  buildMemoryHealthReport,
  buildMemoryMarkdownExport,
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  memoryCandidateGovernanceNotificationDedupeKey,
  memoryCandidateGovernanceNotificationInput,
  parseMemoryMarkdownImport,
  type GovernanceNotificationSurface,
  type MemoryObject,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalBooleanQuery, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { runMemoryConsolidationJob } from "./consolidation.js";
import {
  parseApplyMemoryReviewActionInput,
  parseCreateMemoryConsolidationJobRequest,
  parseCreateMemoryObjectInput,
  parseMemoryReviewPolicyUpdateInput,
  parseMemoryObjectUpdateInput,
  parseMemoryHealthQuery,
  parseMemoryRecallRequest,
  readOptionalMemoryConsolidationJobKindQuery,
  readOptionalMemoryConsolidationJobStatusQuery,
  readOptionalMemoryReviewStateQuery,
  readOptionalMemoryScopeTypeQuery,
  readOptionalMemorySensitivityQuery,
} from "./schemas.js";

export function handleMemoryHealth(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const query = parseMemoryHealthQuery(url);
    const store = storeRegistry.getStore(cwd);
    const memories = store.listMemoryObjects({
      scopeType: query.scopeType,
      ownerId: query.ownerId,
      limit: 500,
    });
    const latestDecisionsByMemoryId = new Map(memories.map((memory) => [memory.id, store.getLatestMemoryReviewDecision(memory.id)]));
    const metadataByMemoryId = new Map(
      store
        .listMemorySelfImprovingMetadata({ limit: 1000 })
        .filter((metadata) => memories.some((memory) => memory.id === metadata.memoryId))
        .map((metadata) => [metadata.memoryId, metadata]),
    );
    writeJson(response, 200, {
      cwd,
      report: buildMemoryHealthReport({
        memories,
        latestDecisionsByMemoryId,
        metadataByMemoryId,
        generatedAt: new Date().toISOString(),
        staleCandidateDays: query.staleCandidateDays,
        limit: query.limit,
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        memories: store.listMemoryObjects({
          scopeType: readOptionalMemoryScopeTypeQuery(url),
          ownerId: url.searchParams.get("ownerId") ?? undefined,
          reviewState: readOptionalMemoryReviewStateQuery(url),
          enabled: readOptionalBooleanQuery(url, "enabled"),
          sensitivity: readOptionalMemorySensitivityQuery(url),
          tag: url.searchParams.get("tag") ?? undefined,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
        vectorRetrieval: getMemorySemanticService(store)?.status() ?? { status: "not_configured", optional: true },
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateMemoryObjectInput(body);
      const now = new Date().toISOString();
      const memory = store.createMemoryObject(input, now);
      upsertMemoryCandidateGovernanceNotification(store, memory, now);
      appendControlPlaneEvent(store, controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "memory",
        entityType: "memory",
        entityId: memory.id,
        action: "memory.candidate_created",
        data: {
          scopeType: memory.scopeType,
          ownerId: memory.ownerId,
          confidence: readOptionalStringField(body, "confidence") ?? "unknown",
          reasonCode: readOptionalStringField(body, "reasonCode") ?? "manual_create",
        },
      }, now);
      writeJson(response, 201, { memory });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryConsolidationJobs(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        jobs: store.listMemoryConsolidationJobs({
          kind: readOptionalMemoryConsolidationJobKindQuery(url),
          status: readOptionalMemoryConsolidationJobStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const now = new Date().toISOString();
      const result = runMemoryConsolidationJob(store, parseCreateMemoryConsolidationJobRequest(body), now);
      for (const candidate of result.candidates) {
        upsertMemoryCandidateGovernanceNotification(store, candidate, now);
      }
      writeJson(response, 201, { cwd, ...result });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/consolidation-jobs` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryExport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const queryOptions = parseMemoryExportQuery(url);
    const bodyOptions = request.method === "POST"
      ? parseMemoryExportBody(await readOptionalJsonBody(request, config.maxBodyBytes))
      : {};
    const exportOptions = { ...queryOptions, ...bodyOptions };
    const store = storeRegistry.getStore(cwd);
    const memories = store.listMemoryObjects({
      scopeType: exportOptions.scopeType,
      ownerId: exportOptions.ownerId,
      reviewState: exportOptions.reviewState,
      sensitivity: exportOptions.sensitivity,
      tag: exportOptions.tag,
      limit: exportOptions.limit,
    });
    const markdownExport = buildMemoryMarkdownExport({
      memories,
      latestDecisionsByMemoryId: new Map(memories.map((memory) => [memory.id, store.getLatestMemoryReviewDecision(memory.id)])),
      metadataByMemoryId: new Map(
        store
          .listMemorySelfImprovingMetadata({ limit: 1000 })
          .filter((metadata) => memories.some((memory) => memory.id === metadata.memoryId))
          .map((metadata) => [metadata.memoryId, metadata]),
      ),
      options: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        generatedAt: exportOptions.generatedAt,
        includeSecretAdjacent: exportOptions.includeSecretAdjacent,
      },
    });

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        export: exportOptions.includeMarkdown === false ? omitMarkdown(markdownExport) : markdownExport,
      });
      return;
    }

    if (request.method === "POST") {
      const fileName = exportOptions.fileName ?? markdownExport.suggestedFileName;
      assertSafeMemoryExportFileName(fileName);
      await mkdir(store.paths.memoryExportsDir, { recursive: true });
      const filePath = join(store.paths.memoryExportsDir, fileName);
      await writeFile(filePath, markdownExport.markdown, "utf8");
      writeJson(response, 201, {
        cwd,
        filePath,
        export: exportOptions.includeMarkdown === true ? markdownExport : omitMarkdown(markdownExport),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/export` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryImport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/import` });
    return;
  }

  try {
    const body = parseMemoryImportBody(await readJsonBody(request, config.maxBodyBytes));
    const now = new Date().toISOString();
    const plan = parseMemoryMarkdownImport(body.markdown, {
      sourceId: body.sourceId ?? body.fileName ?? body.sourceLabel,
      sourceLabel: body.sourceLabel ?? body.fileName,
      importedAt: now,
      limit: body.limit,
    });
    const store = storeRegistry.getStore(cwd);
    const memories = body.dryRun
      ? []
      : plan.candidates.map((candidate) => store.createMemoryObject(candidate.createInput, now));
    if (!body.dryRun) {
      for (const memory of memories) {
        upsertMemoryCandidateGovernanceNotification(store, memory, now);
        appendControlPlaneEvent(store, controlPlaneEvents, {
          workspaceId: DEFAULT_WORKSPACE_ID,
          cwd,
          domain: "memory",
          entityType: "memory",
          entityId: memory.id,
          action: "memory.candidate_imported",
          data: {
            scopeType: memory.scopeType,
            ownerId: memory.ownerId,
            sensitivity: memory.sensitivity,
            sourceId: plan.source.id,
          },
        }, now);
      }
    }
    writeJson(response, body.dryRun ? 200 : 201, {
      cwd,
      dryRun: body.dryRun,
      importedCount: memories.length,
      plan,
      memories,
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  memoryId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const memory = store.getMemoryObject(memoryId);
    if (!memory) {
      writeJson(response, 404, { error: "memory_not_found", message: `Memory object not found: ${memoryId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { memory });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.updateMemoryObject(memoryId, parseMemoryObjectUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { memory: updated ?? memory });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for memory item` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryReviewPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, policy: store.getMemoryReviewPolicy() });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseMemoryReviewPolicyUpdateInput(body);
      const now = new Date().toISOString();
      const policy = store.updateMemoryReviewPolicy(input, now);
      appendControlPlaneEvent(store, controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd,
        domain: "memory",
        entityType: "memory_review_policy",
        entityId: policy.workspaceId,
        action: "memory.policy_updated",
        data: {
          mode: policy.mode,
          changedFields: Object.keys(input),
        },
      }, now);
      writeJson(response, 200, { cwd, policy });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/review-policy` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleMemoryPromotionInbox(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      items: store.listMemoryPromotionInbox({
        scopeType: readOptionalMemoryScopeTypeQuery(url),
        ownerId: url.searchParams.get("ownerId") ?? undefined,
        sensitivity: readOptionalMemorySensitivityQuery(url),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryReviewAction(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents: ControlPlaneEventHub,
  memoryId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for memory review` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getMemoryObject(memoryId);
    if (!existing) {
      writeJson(response, 404, { error: "memory_not_found", message: `Memory object not found: ${memoryId}` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseApplyMemoryReviewActionInput(memoryId, body);
    const now = new Date().toISOString();
    const result = store.applyMemoryReviewAction(input, now);
    if (input.action !== "keep_candidate") {
      resolveMemoryCandidateGovernanceNotification(store, existing, now);
    }
    appendControlPlaneEvent(store, controlPlaneEvents, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "memory",
      entityType: "memory",
      entityId: memoryId,
      action: "memory.reviewed",
      data: {
        previousStatus: existing.reviewState,
        status: result.memory.reviewState,
        decision: input.action,
        reviewedBy: input.actor,
      },
    }, now);
    writeJson(response, 200, result);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

type MemoryNotificationStore = ReturnType<RunStoreRegistry["getStore"]>;

function upsertMemoryCandidateGovernanceNotification(
  store: MemoryNotificationStore,
  memory: MemoryObject,
  now: string,
): void {
  const surface = governanceSurfaceForMemory(store, memory, now);
  const input = memoryCandidateGovernanceNotificationInput(memory, surface);
  if (!input) {
    return;
  }
  store.upsertGovernanceNotification(input, now);
}

function resolveMemoryCandidateGovernanceNotification(
  store: MemoryNotificationStore,
  memory: MemoryObject,
  now: string,
): void {
  const surface = governanceSurfaceForMemory(store, memory, now);
  const dedupeKey = memoryCandidateGovernanceNotificationDedupeKey(memory, surface);
  store.resolveGovernanceNotificationByDedupeKey(memory.workspaceId, dedupeKey, now);
}

function governanceSurfaceForMemory(
  store: MemoryNotificationStore,
  memory: MemoryObject,
  now: string,
): GovernanceNotificationSurface {
  if (memory.scopeType === "channel") {
    return { kind: "channel", channelId: memory.ownerId };
  }
  if (memory.scopeType === "teammate") {
    try {
      const thread = store.getOrCreateTeammateDirectThread(memory.ownerId, now);
      return { kind: "teammate_direct", teammateId: memory.ownerId, threadId: thread.id };
    } catch {
      return { kind: "ling_agent", teammateId: LING_AGENT_ID };
    }
  }
  return { kind: "ling_agent", teammateId: LING_AGENT_ID };
}

function readOptionalStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

interface MemoryExportOptions {
  readonly scopeType?: ReturnType<typeof readOptionalMemoryScopeTypeQuery>;
  readonly ownerId?: string;
  readonly reviewState?: ReturnType<typeof readOptionalMemoryReviewStateQuery>;
  readonly sensitivity?: ReturnType<typeof readOptionalMemorySensitivityQuery>;
  readonly tag?: string;
  readonly limit?: number;
  readonly includeSecretAdjacent?: boolean;
  readonly includeMarkdown?: boolean;
  readonly fileName?: string;
  readonly generatedAt?: string;
}

interface MemoryImportOptions {
  readonly markdown: string;
  readonly dryRun: boolean;
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly fileName?: string;
  readonly limit?: number;
}

function parseMemoryExportQuery(url: URL): MemoryExportOptions {
  return {
    scopeType: readOptionalMemoryScopeTypeQuery(url),
    ownerId: url.searchParams.get("ownerId") ?? undefined,
    reviewState: readOptionalMemoryReviewStateQuery(url),
    sensitivity: readOptionalMemorySensitivityQuery(url),
    tag: url.searchParams.get("tag") ?? undefined,
    limit: readOptionalIntegerQuery(url, "limit", 1),
    includeSecretAdjacent: readOptionalBooleanQuery(url, "includeSecretAdjacent"),
    includeMarkdown: readOptionalBooleanQuery(url, "includeMarkdown"),
    fileName: url.searchParams.get("fileName") ?? undefined,
    generatedAt: url.searchParams.get("generatedAt") ?? undefined,
  };
}

function parseMemoryImportBody(value: unknown): MemoryImportOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "bad_request", "Memory import body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const markdown = readOptionalStringBody(record, "markdown");
  if (!markdown?.trim()) {
    throw new HttpError(400, "bad_request", "markdown must be a non-empty string.");
  }
  return {
    markdown,
    dryRun: readOptionalBooleanBody(record, "dryRun") ?? false,
    sourceId: readOptionalStringBody(record, "sourceId"),
    sourceLabel: readOptionalStringBody(record, "sourceLabel"),
    fileName: readOptionalStringBody(record, "fileName"),
    limit: readOptionalIntegerBody(record, "limit"),
  };
}

function parseMemoryExportBody(value: unknown): MemoryExportOptions {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "bad_request", "Memory export body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  return {
    scopeType: readOptionalStringUnion(record, "scopeType", ["workspace", "channel", "teammate", "task", "run"]),
    ownerId: readOptionalStringBody(record, "ownerId"),
    reviewState: readOptionalStringUnion(record, "reviewState", ["candidate", "active", "disabled", "archived", "rejected"]),
    sensitivity: readOptionalStringUnion(record, "sensitivity", ["normal", "private", "secret-adjacent"]),
    tag: readOptionalStringBody(record, "tag"),
    limit: readOptionalIntegerBody(record, "limit"),
    includeSecretAdjacent: readOptionalBooleanBody(record, "includeSecretAdjacent"),
    includeMarkdown: readOptionalBooleanBody(record, "includeMarkdown"),
    fileName: readOptionalStringBody(record, "fileName"),
    generatedAt: readOptionalStringBody(record, "generatedAt"),
  };
}

function assertSafeMemoryExportFileName(fileName: string): void {
  if (!fileName.endsWith(".md") || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw new HttpError(400, "bad_export_file_name", "Memory export fileName must be a simple .md file name.");
  }
}

function omitMarkdown<T extends { readonly markdown: string }>(value: T): Omit<T, "markdown"> {
  const { markdown: _markdown, ...rest } = value;
  return rest;
}

function readOptionalStringBody(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "bad_request", `${key} must be a string.`);
  }
  return value;
}

function readOptionalBooleanBody(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "bad_request", `${key} must be a boolean.`);
  }
  return value;
}

function readOptionalIntegerBody(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "bad_request", `${key} must be an integer greater than or equal to 1.`);
  }
  return value;
}

function readOptionalStringUnion<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = readOptionalStringBody(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new HttpError(400, "bad_request", `${key} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export async function handleMemoryRecall(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/recall` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const result = await recallMemory(storeRegistry.getStore(cwd), parseMemoryRecallRequest(body));
    writeJson(response, 200, {
      cwd,
      memories: result.memories,
      policyVersion: result.policyVersion,
      audit: result.audit,
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleListUsedMemoryEvents(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      events: store.listUsedMemoryEvents({
        teammateId: url.searchParams.get("teammateId") ?? undefined,
        channelId: url.searchParams.get("channelId") ?? undefined,
        taskId: url.searchParams.get("taskId") ?? undefined,
        runId: url.searchParams.get("runId") ?? undefined,
        responseId: url.searchParams.get("responseId") ?? undefined,
        memoryId: url.searchParams.get("memoryId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
