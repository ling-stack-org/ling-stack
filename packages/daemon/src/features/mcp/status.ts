import type { McpAuthStatus, McpRuntimeStatusSnapshot, McpServer, McpServerStatus, SecretStatus } from "@ling-stack/core";

export const mcpStatusSnapshotTtlMs = 5 * 60 * 1000;

export function createMcpAuthStatus(statuses: readonly SecretStatus[], legacySecretMigrationRequired = false): McpAuthStatus {
  if (legacySecretMigrationRequired) {
    return {
      kind: "migration_required",
      refs: statuses.map((status) => status.ref),
      missingRefs: [],
      message: "Legacy raw MCP secrets require migration to secret refs.",
    };
  }
  if (statuses.length === 0) {
    return { kind: "not_required", refs: [], missingRefs: [] };
  }
  const missing = statuses.filter((status) => !status.configured);
  if (missing.length === 0) {
    return { kind: "configured", refs: statuses.map((status) => status.ref), missingRefs: [] };
  }
  const first = missing[0];
  const kind = first?.errorCode === "secret_access_denied"
    ? "access_denied"
    : first?.errorCode === "secret_store_unavailable"
      ? "store_unavailable"
      : first?.errorCode === "invalid_secret_ref"
        ? "invalid_ref"
        : "missing";
  return {
    kind,
    refs: statuses.map((status) => status.ref),
    missingRefs: missing.map((status) => status.ref),
    message: first?.message,
  };
}

export function createMcpStatusSnapshot(input: {
  readonly server: McpServer;
  readonly now: string;
  readonly status: McpRuntimeStatusSnapshot["status"];
  readonly authStatus: McpAuthStatus;
  readonly message?: string;
  readonly serverInfo?: McpRuntimeStatusSnapshot["serverInfo"];
  readonly protocolVersion?: string;
  readonly toolCount?: number;
  readonly latencyMs?: number;
  readonly errorCode?: string;
}): McpRuntimeStatusSnapshot {
  const checked = Date.parse(input.now);
  const expiresAt = Number.isFinite(checked)
    ? new Date(checked + mcpStatusSnapshotTtlMs).toISOString()
    : new Date(Date.now() + mcpStatusSnapshotTtlMs).toISOString();
  return {
    serverId: input.server.id,
    checkedAt: input.now,
    expiresAt,
    status: input.status,
    serverInfo: input.serverInfo,
    protocolVersion: input.protocolVersion,
    toolCount: input.toolCount,
    missingSecretRefs: input.authStatus.missingRefs,
    authStatus: input.authStatus,
    latencyMs: input.latencyMs,
    errorCode: input.errorCode,
    message: input.message,
  };
}

export function deriveMcpServerStatus(snapshot: McpRuntimeStatusSnapshot | undefined, fallback: McpServerStatus): McpServerStatus {
  if (!snapshot) {
    return fallback;
  }
  if (snapshot.status === "ready") {
    return {
      kind: "ready",
      message: snapshot.message,
      checkedAt: snapshot.checkedAt,
    };
  }
  if (snapshot.status === "disabled") {
    return {
      kind: "disabled",
      message: snapshot.message,
      checkedAt: snapshot.checkedAt,
    };
  }
  if (snapshot.status === "failed" || snapshot.status === "migration_required") {
    return {
      kind: "failed",
      message: snapshot.message,
      checkedAt: snapshot.checkedAt,
    };
  }
  return {
    kind: "unknown",
    message: snapshot.message,
    checkedAt: snapshot.checkedAt,
  };
}
