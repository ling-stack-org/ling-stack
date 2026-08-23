import type {
  ControlPlaneDomain,
  ControlPlaneEvent,
  ControlPlaneReplayWindow,
  ControlPlaneSubscribeResult,
  ControlPlaneSnapshotResponse,
  RunnerListItem,
  RunnersDomainSnapshot,
  WorkUnit,
  WorkUnitsDomainSnapshot,
} from "../types.js";

export const controlPlaneSummaryDomains = [
  "runs",
  "work_units",
  "memory",
  "skills",
  "teammates",
  "approvals",
  "providers",
  "mcp",
  "runners",
  "artifacts",
] as const satisfies readonly ControlPlaneDomain[];

export function readControlPlaneDomainData<T>(
  snapshot: ControlPlaneSnapshotResponse | undefined,
  domain: ControlPlaneDomain,
): T | undefined {
  const domainSnapshot = snapshot?.domains[domain];
  if (!domainSnapshot?.ok) {
    return undefined;
  }
  return domainSnapshot.data as T;
}

export function controlPlaneStreamUrl(
  baseUrl: string,
  cwd: string,
  options: {
    readonly afterSeq?: number;
    readonly domains?: readonly ControlPlaneDomain[];
  } = {},
): string {
  const url = new URL("/control-plane/stream", normalizedBaseUrl(baseUrl));
  url.searchParams.set("cwd", cwd);
  if (options.afterSeq !== undefined) {
    url.searchParams.set("afterSeq", String(options.afterSeq));
  }
  if (options.domains?.length) {
    url.searchParams.set("domains", options.domains.join(","));
  }
  return url.toString();
}

export function controlPlaneRpcStreamUrl(baseUrl: string, cwd: string): string {
  const url = new URL("/rpc/stream", normalizedBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cwd", cwd);
  return url.toString();
}

export function parseControlPlaneEventMessage(data: string): ControlPlaneEvent | undefined {
  try {
    const parsed = JSON.parse(data) as Partial<ControlPlaneEvent>;
    if (
      typeof parsed.seq !== "number" ||
      typeof parsed.domain !== "string" ||
      typeof parsed.action !== "string" ||
      !controlPlaneSummaryDomains.includes(parsed.domain as ControlPlaneDomain)
    ) {
      return undefined;
    }
    return parsed as ControlPlaneEvent;
  } catch {
    return undefined;
  }
}

export function parseControlPlaneRpcEventMessage(data: string): ControlPlaneEvent | undefined {
  try {
    const parsed = JSON.parse(data) as {
      readonly method?: unknown;
      readonly params?: unknown;
    };
    if (parsed.method !== "$/control_plane_event" || !parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params)) {
      return undefined;
    }
    const event = (parsed.params as { readonly event?: unknown }).event;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return undefined;
    }
    return parseControlPlaneEventObject(event);
  } catch {
    return undefined;
  }
}

export function parseControlPlaneReplayWindowMessage(data: string): ControlPlaneReplayWindow | undefined {
  try {
    return parseControlPlaneReplayWindow(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function parseControlPlaneRpcSubscribeMessage(
  data: string,
  requestId: number,
): { readonly result?: ControlPlaneSubscribeResult; readonly error: boolean } | undefined {
  try {
    const parsed = JSON.parse(data) as {
      readonly id?: unknown;
      readonly result?: unknown;
      readonly error?: unknown;
    };
    if (parsed.id !== requestId) return undefined;
    if (parsed.error !== undefined) return { error: true };
    const result = parseControlPlaneSubscribeResult(parsed.result);
    return result ? { result, error: false } : { error: true };
  } catch {
    return { error: true };
  }
}

function parseControlPlaneSubscribeResult(value: unknown): ControlPlaneSubscribeResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { readonly disposition?: unknown; readonly subscriptionId?: unknown; readonly window?: unknown };
  const window = parseControlPlaneReplayWindow(record.window);
  if (!window || record.disposition !== window.disposition) return undefined;
  if (record.disposition === "snapshot_required") {
    return { disposition: "snapshot_required", window };
  }
  if (record.disposition === "complete" && typeof record.subscriptionId === "string" && record.subscriptionId.length > 0) {
    return { disposition: "complete", subscriptionId: record.subscriptionId, window };
  }
  return undefined;
}

function parseControlPlaneReplayWindow(value: unknown): ControlPlaneReplayWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.disposition !== "complete" && record.disposition !== "snapshot_required")
    || !isNonNegativeInteger(record.requestedAfterSeq)
    || !isNonNegativeInteger(record.replayFloorSeq)
    || !isNonNegativeInteger(record.upperBoundSeq)
    || !isNonNegativeInteger(record.nextAfterSeq)) {
    return undefined;
  }
  const reason = record.reason;
  if (reason !== undefined
    && reason !== "cursor_unavailable"
    && reason !== "retention_gap"
    && reason !== "window_exceeded") {
    return undefined;
  }
  return {
    disposition: record.disposition,
    requestedAfterSeq: record.requestedAfterSeq,
    replayFloorSeq: record.replayFloorSeq,
    upperBoundSeq: record.upperBoundSeq,
    nextAfterSeq: record.nextAfterSeq,
    ...(reason ? { reason } : {}),
  } as ControlPlaneReplayWindow;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function workUnitsFromControlPlaneSnapshot(snapshot: WorkUnitsDomainSnapshot): readonly WorkUnit[] {
  const byId = new Map<string, WorkUnit>();
  for (const summary of [...snapshot.active, ...snapshot.queued, ...snapshot.stale]) {
    byId.set(summary.id, {
      id: summary.id,
      workspaceId: "",
      kind: summary.kind as WorkUnit["kind"],
      ownerType: summary.runId ? "run" : "work_unit",
      ownerId: summary.runId ?? summary.id,
      channelId: summary.channelId,
      idempotencyKey: "",
      status: summary.status as WorkUnit["status"],
      priority: 0,
      attemptCount: 0,
      activeAttemptId: summary.leaseId,
      createdByActor: "system",
      request: {},
      timeoutPolicy: {
        heartbeatIntervalMs: 0,
        heartbeatTimeoutMs: 0,
        idleTimeoutMs: 0,
        hardTimeoutMs: 0,
        cancelGraceMs: 0,
      },
      linkedRunId: summary.runId,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      lastEventAt: summary.updatedAt,
      lastHeartbeatAt: summary.lastHeartbeatAt,
      errorCode: summary.blockedReason,
      errorMessage: summary.blockedReason,
    });
  }
  return [...byId.values()];
}

export function runnerItemsFromControlPlaneSnapshot(snapshot: RunnersDomainSnapshot): readonly RunnerListItem[] {
  return snapshot.runners.map((runner) => ({
    id: runner.id,
    displayName: runner.displayName,
    status: runner.enabled && runner.available ? "enabled" : "disabled",
    capabilities: runner.capabilities,
    toolHydration: runner.toolHydration,
    disabledReason: runner.blocker,
  }));
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function parseControlPlaneEventObject(value: unknown): ControlPlaneEvent | undefined {
  const parsed = value as Partial<ControlPlaneEvent>;
  if (
    typeof parsed.seq !== "number" ||
    typeof parsed.domain !== "string" ||
    typeof parsed.action !== "string" ||
    !controlPlaneSummaryDomains.includes(parsed.domain as ControlPlaneDomain)
  ) {
    return undefined;
  }
  return parsed as ControlPlaneEvent;
}
