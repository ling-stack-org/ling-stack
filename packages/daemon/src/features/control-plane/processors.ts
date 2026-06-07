import type {
  ControlPlaneDomain,
  ControlPlaneEvent,
} from "@ling-stack/core";
import { DEFAULT_WORKSPACE_ID, redactSecrets } from "@ling-stack/core";
import type { DaemonContext } from "../../context.js";
import { readControlPlaneDomainSnapshot } from "./snapshots.js";
import {
  CONTROL_PLANE_POLL_DEFAULT_LIMIT,
  CONTROL_PLANE_POLL_MAX_LIMIT,
  CONTROL_PLANE_SSE_INITIAL_REPLAY_LIMIT,
  trimOversizedEvent,
} from "./events.js";

export const CONTROL_PLANE_DOMAINS = [
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

export interface ControlPlaneSnapshotResponse {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly latestEventSeq: number;
  readonly domains: Readonly<Record<string, {
    readonly ok: boolean;
    readonly revision: number;
    readonly data?: unknown;
    readonly error?: {
      readonly code: string;
      readonly message: string;
    };
  }>>;
}

export interface ControlPlaneEventsResponse {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly afterSeq: number;
  readonly limit: number;
  readonly events: readonly ControlPlaneEvent[];
}

export class ControlPlaneBadDomainError extends Error {
  readonly code = "bad_domain";
}

export class ControlPlaneBadRequestError extends Error {
  readonly code = "bad_request";
}

export function parseControlPlaneDomains(raw: string | null): readonly ControlPlaneDomain[] {
  if (raw === null || raw.trim() === "") {
    return CONTROL_PLANE_DOMAINS;
  }
  const domains = raw.split(",").map((domain) => domain.trim()).filter(Boolean);
  const unknown = domains.filter((domain) => !isControlPlaneDomain(domain));
  if (unknown.length > 0) {
    throw new ControlPlaneBadDomainError(`Unsupported control-plane domain: ${unknown.join(", ")}`);
  }
  return [...new Set(domains)] as ControlPlaneDomain[];
}

export function readControlPlaneAfterSeq(url: URL): number {
  const raw = url.searchParams.get("afterSeq");
  if (raw === null || raw === "") {
    return 0;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw new ControlPlaneBadRequestError("afterSeq must be an integer greater than or equal to 0");
  }
  return value;
}

export function readControlPlaneLimit(url: URL, options: { readonly defaultLimit?: number; readonly maxLimit?: number } = {}): number {
  const defaultLimit = options.defaultLimit ?? CONTROL_PLANE_POLL_DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? CONTROL_PLANE_POLL_MAX_LIMIT;
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") {
    return defaultLimit;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > maxLimit || String(value) !== raw) {
    throw new ControlPlaneBadRequestError(`limit must be an integer between 1 and ${maxLimit}`);
  }
  return value;
}

export function buildControlPlaneSnapshot(
  context: DaemonContext,
  input: {
    readonly cwd: string;
    readonly domains: readonly ControlPlaneDomain[];
  },
): ControlPlaneSnapshotResponse {
  const store = context.storeRegistry.getStore(input.cwd);
  const generatedAt = new Date().toISOString();
  const latestEventSeq = store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID);
  const domains: Record<string, ControlPlaneSnapshotResponse["domains"][string]> = {};
  for (const domain of input.domains) {
    try {
      domains[domain] = {
        ok: true,
        revision: latestEventSeq,
        data: redactSecrets(readControlPlaneDomainSnapshot(domain, {
          cwd: input.cwd,
          store,
          context,
          now: generatedAt,
        })),
      };
    } catch (error) {
      domains[domain] = {
        ok: false,
        revision: latestEventSeq,
        error: {
          code: "domain_snapshot_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  return redactSecrets({
    cwd: input.cwd,
    workspaceId: DEFAULT_WORKSPACE_ID,
    generatedAt,
    latestEventSeq,
    domains,
  }) as ControlPlaneSnapshotResponse;
}

export function listControlPlaneEventsForResponse(
  context: DaemonContext,
  input: {
    readonly cwd: string;
    readonly afterSeq: number;
    readonly limit: number;
    readonly domains: readonly ControlPlaneDomain[];
  },
): ControlPlaneEventsResponse {
  const store = context.storeRegistry.getStore(input.cwd);
  const events = store.listControlPlaneEvents({
    workspaceId: DEFAULT_WORKSPACE_ID,
    afterSeq: input.afterSeq,
    limit: input.limit,
    domains: input.domains,
  }).map(trimOversizedEvent);
  return {
    cwd: input.cwd,
    workspaceId: DEFAULT_WORKSPACE_ID,
    afterSeq: input.afterSeq,
    limit: input.limit,
    events,
  };
}

export function listControlPlaneSseReplayEvents(
  context: DaemonContext,
  input: {
    readonly cwd: string;
    readonly afterSeq: number;
    readonly domains: readonly ControlPlaneDomain[];
  },
): readonly ControlPlaneEvent[] {
  const store = context.storeRegistry.getStore(input.cwd);
  return store.listControlPlaneEvents({
    workspaceId: DEFAULT_WORKSPACE_ID,
    afterSeq: input.afterSeq,
    limit: CONTROL_PLANE_SSE_INITIAL_REPLAY_LIMIT,
    domains: input.domains,
  }).map(trimOversizedEvent);
}

export function latestControlPlaneEventSeq(context: DaemonContext, cwd: string): number {
  return context.storeRegistry.getStore(cwd).getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID);
}

function isControlPlaneDomain(value: string): value is ControlPlaneDomain {
  return (CONTROL_PLANE_DOMAINS as readonly string[]).includes(value);
}
