import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  RunnerFallbackPolicy,
  ResourceLease,
  RunEventEnvelope,
  RunSession,
  RunStore,
  RuntimeExtensionView,
  RuntimeEvent,
  RuntimeSemaphoreSlot,
  WorkUnit,
  WorkUnitAttempt,
  WorkUnitKind,
  WorkUnitStatus,
} from "@ling-stack/core";
import { DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import type { LingExtensionMetadata, LingExtensionRegistry } from "@ling-stack/plugin-sdk";
import type { ResolvedDaemonConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { appendControlPlaneEvent } from "../features/control-plane/events.js";
import type { ControlPlaneEventHub } from "../features/control-plane/events.js";
import type { WorkUnitRoute } from "../server/routes.js";
import { readOptionalIntegerQuery, readOptionalJsonBody } from "../shared/request.js";
import { writeJson } from "../shared/response.js";
import { isRecord, readOptionalString, readOptionalStringArray, removeUndefined } from "../shared/validation.js";
import type { ActiveRunRegistry } from "./active-runs.js";
import {
  listRunnerItems,
  loadWorkspaceRuntimeSettings,
  patchWorkspaceRuntimeSettings,
  type WorkspaceRuntimeSettingsPatch,
} from "./runner-settings.js";
import {
  buildRunnerReadinessReport,
  listRunnerReadinessSummaries,
} from "./runner-readiness.js";
import type { RunnerRegistry } from "./runners.js";
import type { RunStoreRegistry } from "./store-registry.js";
import type { RuntimeSupervisor } from "./supervisor.js";
import {
  cancelStandaloneWorkUnit,
  isActiveWorkUnitStatus,
  isStuckWorkUnit,
  listActiveWorkUnits,
  markWorkUnitStale,
  releaseWorkUnitRuntimeResources,
} from "./work-units.js";

export type RuntimeRunCanceller = (input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt?: string;
  readonly reason: string;
  readonly active: boolean;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
}) => { readonly event?: RunEventEnvelope };

export function handleListStateTransitions(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const entityType = url.searchParams.get("entityType") ?? undefined;
  if (entityType !== undefined && !["task", "run", "approval", "media_job", "workflow", "workflow_step", "work_unit"].includes(entityType)) {
    writeJson(response, 400, { error: "bad_request", message: "entityType is invalid" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      transitions: store.listStateTransitionEvents({
        entityType: entityType as NonNullable<Parameters<RunStore["listStateTransitionEvents"]>[0]>["entityType"] | undefined,
        entityId: url.searchParams.get("entityId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export function handleListResourceLeases(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !["active", "released", "expired"].includes(status)) {
    writeJson(response, 400, { error: "bad_request", message: "status is invalid" });
    return;
  }
  const ownerType = url.searchParams.get("ownerType") ?? undefined;
  if (ownerType !== undefined && !["run", "workflow_step", "work_unit_attempt", "system"].includes(ownerType)) {
    writeJson(response, 400, { error: "bad_request", message: "ownerType is invalid" });
    return;
  }
  const resourceType = url.searchParams.get("resourceType") ?? undefined;

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      leases: store.listResourceLeases({
        status: status as NonNullable<Parameters<RunStore["listResourceLeases"]>[0]>["status"] | undefined,
        ownerType: ownerType as NonNullable<Parameters<RunStore["listResourceLeases"]>[0]>["ownerType"] | undefined,
        ownerId: url.searchParams.get("ownerId") ?? undefined,
        resourceType: resourceType as NonNullable<Parameters<RunStore["listResourceLeases"]>[0]>["resourceType"] | undefined,
        resourceKey: url.searchParams.get("resourceKey") ?? undefined,
        workUnitId: url.searchParams.get("workUnitId") ?? undefined,
        attemptId: url.searchParams.get("attemptId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export function handleGetRuntime(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runtimeSupervisor: RuntimeSupervisor,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  try {
    writeJson(response, 200, {
      cwd: resolved.cwd,
      runtime: runtimeSupervisor.getRuntime(resolved.cwd, resolved.store),
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleGetRuntimeSupervisor(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runtimeSupervisor: RuntimeSupervisor,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  try {
    writeJson(response, 200, {
      cwd: resolved.cwd,
      ...runtimeSupervisor.getDiagnostics(resolved.cwd, resolved.store),
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleListRuntimeActive(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  writeJson(response, 200, { cwd: resolved.cwd, workUnits: listActiveWorkUnits(resolved.store) });
}

export function handleListRuntimeStuck(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const now = new Date();
  writeJson(response, 200, {
    cwd: resolved.cwd,
    workUnits: listActiveWorkUnits(resolved.store).filter((workUnit) => isStuckWorkUnit(workUnit, now)),
  });
}

export function handleListRuntimeSemaphores(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  writeJson(response, 200, {
    cwd: resolved.cwd,
    semaphoreSlots: resolved.store.listRuntimeSemaphoreSlots({ status: "active", limit: readOptionalIntegerQuery(url, "limit", 1) }),
  });
}

export function handleListWorkUnits(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !isWorkUnitStatus(status)) {
    writeJson(response, 400, { error: "bad_request", message: "status is invalid" });
    return;
  }
  const kind = url.searchParams.get("kind") ?? undefined;
  if (kind !== undefined && !isWorkUnitKind(kind)) {
    writeJson(response, 400, { error: "bad_request", message: "kind is invalid" });
    return;
  }
  writeJson(response, 200, {
    cwd: resolved.cwd,
    workUnits: resolved.store.listWorkUnits({
      status: status as WorkUnitStatus | undefined,
      kind: kind as WorkUnitKind | undefined,
      ownerType: url.searchParams.get("ownerType") ?? undefined,
      ownerId: url.searchParams.get("ownerId") ?? undefined,
      channelId: url.searchParams.get("channelId") ?? undefined,
      linkedRunId: url.searchParams.get("linkedRunId") ?? undefined,
      limit: readOptionalIntegerQuery(url, "limit", 1),
    }),
  });
}

export function handleListRunners(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  config: ResolvedDaemonConfig,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  writeJson(response, 200, {
    cwd: resolved.cwd,
    runners: listRunnerItems(runnerRegistry, {
      readinessByRunnerId: listRunnerReadinessSummaries(runnerRegistry, config),
    }),
  });
}

export async function handleGetRunnerReadiness(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  config: ResolvedDaemonConfig,
  runnerId: string,
): Promise<void> {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  const runner = runnerRegistry.get(runnerId);
  if (!runner) {
    writeJson(response, 404, { error: "runner_not_found", message: `Runner not found: ${runnerId}` });
    return;
  }
  try {
    writeJson(response, 200, {
      cwd: resolved.cwd,
      readiness: await buildRunnerReadinessReport(runner, config),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export function handleListRuntimeExtensions(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  extensionRegistry: LingExtensionRegistry,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  writeJson(response, 200, {
    cwd: resolved.cwd,
    extensions: extensionRegistry.list().map(toRuntimeExtensionView).sort(compareRuntimeExtensionViews),
  });
}

export async function handleRuntimeSettings(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  maxBodyBytes: number,
  controlPlaneEvents: ControlPlaneEventHub,
): Promise<void> {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  try {
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd: resolved.cwd,
        settings: loadWorkspaceRuntimeSettings(resolved.store, runnerRegistry),
      });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readOptionalJsonBody(request, maxBodyBytes);
      const now = new Date().toISOString();
      const settings = patchWorkspaceRuntimeSettings(
        resolved.store,
        runnerRegistry,
        parseWorkspaceRuntimeSettingsPatch(body),
        now,
      );
      appendControlPlaneEvent(resolved.store, controlPlaneEvents, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        cwd: resolved.cwd,
        domain: "runners",
        entityType: "runtime_settings",
        entityId: settings.workspaceId,
        action: "runner.settings_updated",
        data: {
          defaultRunnerId: settings.defaultRunnerId,
          allowedRunnerCount: settings.allowedRunnerIds.length,
        },
      }, now);
      writeJson(response, 200, {
        cwd: resolved.cwd,
        settings,
      });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for runtime settings` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleWorkUnitRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runtimeSupervisor: RuntimeSupervisor,
  route: WorkUnitRoute,
  cancelRun: RuntimeRunCanceller,
  controlPlaneEvents: ControlPlaneEventHub,
): void {
  const resolved = getCwdStoreOrWriteError(response, url, storeRegistry);
  if (!resolved) {
    return;
  }
  runtimeSupervisor.getRuntime(resolved.cwd, resolved.store);
  const workUnit = resolved.store.getWorkUnit(route.workUnitId);
  if (!workUnit) {
    writeJson(response, 404, { error: "work_unit_not_found", message: `Work unit not found: ${route.workUnitId}` });
    return;
  }

  if (route.kind === "detail") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for work unit detail` });
      return;
    }
    writeJson(response, 200, buildWorkUnitDetailResponse(resolved.cwd, resolved.store, workUnit));
    return;
  }

  if (route.kind === "events") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for work unit events` });
      return;
    }
    const afterSeq = readOptionalIntegerQuery(url, "afterSeq", 0);
    const events = resolved.store.listRuntimeEvents(workUnit.id, { afterSeq, limit: readOptionalIntegerQuery(url, "limit", 1) });
    const lastEvent = events.at(-1);
    writeJson(response, 200, {
      cwd: resolved.cwd,
      workUnitId: workUnit.id,
      events,
      nextSeq: lastEvent ? lastEvent.seq + 1 : (afterSeq ?? 0) + 1,
    });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for work unit ${route.kind}` });
    return;
  }

  if (route.kind === "cancel") {
    const previousStatus = workUnit.status;
    const runId = workUnit.linkedRunId;
    const activeRun = runId ? activeRuns.get(runId) : undefined;
    if (runId) {
      const run = resolved.store.getRun(runId);
      if (run) {
        cancelRun({
          store: resolved.store,
          runId,
          taskId: run.taskId,
          startedAt: run.startedAt,
          reason: "work_unit_cancel_requested",
          active: Boolean(activeRun),
          streamEnvelope: activeRun?.streamEnvelope,
        });
      } else {
        cancelStandaloneWorkUnit(resolved.store, workUnit, "work_unit_cancel_requested");
      }
      activeRun?.abortController.abort();
    } else {
      cancelStandaloneWorkUnit(resolved.store, workUnit, "work_unit_cancel_requested");
    }
    const latest = resolved.store.getWorkUnit(workUnit.id) ?? workUnit;
    appendWorkUnitTransitionControlPlaneEvent(
      resolved.store,
      controlPlaneEvents,
      resolved.cwd,
      workUnit,
      previousStatus,
      latest.status,
      "work_unit_cancel_requested",
    );
    writeJson(response, 200, {
      cwd: resolved.cwd,
      workUnit: latest,
    });
    return;
  }

  if (route.kind === "retry") {
    const now = new Date().toISOString();
    const current = resolved.store.getWorkUnit(workUnit.id) ?? workUnit;
    const transition = resolved.store.transitionWorkUnitStatus({
      workUnitId: current.id,
      expectedStatus: current.status,
      event: "retry",
      actor: "local-user",
      reason: "manual_retry",
      now,
      activeAttemptId: null,
      endedAt: null,
      errorCode: null,
      errorMessage: null,
    });
    if (!transition.ok) {
      writeJson(response, 409, { error: transition.code, message: `Work unit retry failed: ${transition.code}`, workUnit: current });
      return;
    }
    const latest = resolved.store.getWorkUnit(current.id) ?? current;
    appendWorkUnitTransitionControlPlaneEvent(
      resolved.store,
      controlPlaneEvents,
      resolved.cwd,
      current,
      transition.from,
      latest.status,
      "manual_retry",
    );
    const event = resolved.store.appendRuntimeEvent({
      workUnitId: current.id,
      type: "work_unit_queued",
      actor: "local-user",
      ts: now,
      data: { reason: "manual_retry" },
    });
    writeJson(response, 200, {
      cwd: resolved.cwd,
      workUnit: latest,
      event,
    });
    return;
  }

  const now = new Date().toISOString();
  const previousStatus = workUnit.status;
  const reconciled = isActiveWorkUnitStatus(workUnit.status)
    ? markWorkUnitStale(resolved.store, workUnit, now, "manual_reconcile")
    : releaseWorkUnitRuntimeResources(resolved.store, workUnit, now, "manual_reconcile");
  appendWorkUnitTransitionControlPlaneEvent(
    resolved.store,
    controlPlaneEvents,
    resolved.cwd,
    workUnit,
    previousStatus,
    reconciled.status,
    "manual_reconcile",
  );
  writeJson(response, 200, {
    cwd: resolved.cwd,
    workUnit: resolved.store.getWorkUnit(reconciled.id) ?? reconciled,
  });
}

function buildWorkUnitDetailResponse(cwd: string, store: RunStore, workUnit: WorkUnit): {
  readonly cwd: string;
  readonly workUnit: WorkUnit;
  readonly attempts: readonly WorkUnitAttempt[];
  readonly events: readonly RuntimeEvent[];
  readonly leases: readonly ResourceLease[];
  readonly semaphoreSlots: readonly RuntimeSemaphoreSlot[];
  readonly run?: RunSession;
} {
  return removeUndefined({
    cwd,
    workUnit,
    attempts: store.listWorkUnitAttempts(workUnit.id),
    events: store.listRuntimeEvents(workUnit.id, { limit: 500 }),
    leases: store.listResourceLeases({ workUnitId: workUnit.id, limit: 500 }),
    semaphoreSlots: store.listRuntimeSemaphoreSlots({ workUnitId: workUnit.id, limit: 500 }),
    run: workUnit.linkedRunId ? store.getRun(workUnit.linkedRunId) : undefined,
  });
}

function appendWorkUnitTransitionControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub,
  cwd: string,
  workUnit: WorkUnit,
  previousStatus: WorkUnitStatus,
  status: WorkUnitStatus,
  reason: string,
): void {
  if (previousStatus === status) {
    return;
  }
  appendControlPlaneEvent(store, hub, {
    workspaceId: workUnit.workspaceId,
    cwd,
    domain: "work_units",
    entityType: "work_unit",
    entityId: workUnit.id,
    action: "work_unit.transitioned",
    data: {
      previousStatus,
      status,
      reason,
      runId: workUnit.linkedRunId ?? null,
      attemptId: workUnit.activeAttemptId ?? null,
    },
  });
}

function toRuntimeExtensionView(extension: LingExtensionMetadata): RuntimeExtensionView {
  const view: RuntimeExtensionView = {
    id: extension.manifest.id,
    name: extension.manifest.name,
    version: extension.manifest.version,
    kind: extension.manifest.kind,
    trustLevel: extension.manifest.trustLevel,
    capabilities: extension.manifest.capabilities,
  };
  return removeUndefined({
    ...view,
    defaultApproval: "defaultApproval" in extension ? extension.defaultApproval : undefined,
    sideEffectLevel: "sideEffectLevel" in extension ? extension.sideEffectLevel : undefined,
  });
}

function compareRuntimeExtensionViews(left: RuntimeExtensionView, right: RuntimeExtensionView): number {
  const byKind = left.kind.localeCompare(right.kind);
  return byKind === 0 ? left.id.localeCompare(right.id) : byKind;
}

function parseWorkspaceRuntimeSettingsPatch(value: unknown): WorkspaceRuntimeSettingsPatch {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Runtime settings patch must be a JSON object");
  }
  return removeUndefined({
    defaultRunnerId: readOptionalString(value, "defaultRunnerId"),
    allowedRunnerIds: readOptionalStringArray(value, "allowedRunnerIds"),
    explicitRunnerFallback: readOptionalRunnerFallbackPolicy(value, "explicitRunnerFallback"),
    implicitRunnerFallback: readOptionalRunnerFallbackPolicy(value, "implicitRunnerFallback"),
  });
}

function readOptionalRunnerFallbackPolicy(record: Record<string, unknown>, key: string): RunnerFallbackPolicy | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "disabled" && value !== "allow_to_default") {
    throw new Error(`${key} must be disabled or allow_to_default`);
  }
  return value;
}

function getCwdStoreOrWriteError(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): { readonly cwd: string; readonly store: RunStore } | undefined {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return undefined;
  }
  return { cwd, store: storeRegistry.getStore(cwd) };
}

function isWorkUnitStatus(value: string): value is WorkUnitStatus {
  return (
    value === "queued" ||
    value === "claimed" ||
    value === "running" ||
    value === "waiting_for_approval" ||
    value === "cancelling" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "stale"
  );
}

function isWorkUnitKind(value: string): value is WorkUnitKind {
  return (
    value === "task_run" ||
    value === "channel_ai_reply" ||
    value === "teammate_direct_reply" ||
    value === "external_work_step" ||
    value === "external_work_action" ||
    value === "media_job"
  );
}
