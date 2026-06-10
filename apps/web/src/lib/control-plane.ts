import type {
  ControlPlaneDomain,
  ControlPlaneEvent,
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
