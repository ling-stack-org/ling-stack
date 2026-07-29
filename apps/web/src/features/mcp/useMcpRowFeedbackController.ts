import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { McpServer } from "../../types.js";
import type { McpServerRowFeedback } from "./McpServerRow.js";

type McpRowOperation = "check" | "sync";

function mcpServerConfigurationIdentity(server: McpServer): string {
  return JSON.stringify({
    id: server.id,
    workspaceId: server.workspaceId,
    displayName: server.displayName,
    transport: server.transport,
    enabled: server.enabled,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec,
    toolTimeoutSec: server.toolTimeoutSec,
    enabledTools: server.enabledTools,
    disabledTools: server.disabledTools,
    secretConfigured: server.secretConfigured,
    legacySecretMigrationRequired: server.legacySecretMigrationRequired,
  });
}

export function useMcpRowFeedbackController(servers: readonly McpServer[]): {
  readonly feedbackByServerId: Readonly<Record<string, McpServerRowFeedback>>;
  readonly runCheck: (serverId: string, action: (serverId: string) => Promise<boolean>) => Promise<boolean>;
  readonly runSync: (serverId: string, action: (serverId: string) => Promise<boolean>) => Promise<boolean>;
} {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [feedbackByServerId, setFeedbackByServerId] = useState<Readonly<Record<string, McpServerRowFeedback>>>({});
  const identities = useMemo(() => new Map(
    servers.map((server) => [server.id, mcpServerConfigurationIdentity(server)] as const),
  ), [servers]);
  const currentIdentitiesRef = useRef(identities);
  const previousIdentitiesRef = useRef<ReadonlyMap<string, string>>();
  currentIdentitiesRef.current = identities;

  const clearFailure = useCallback((serverId: string): void => {
    setFeedbackByServerId((current) => {
      if (!current[serverId]) return current;
      const next = { ...current };
      delete next[serverId];
      return next;
    });
  }, []);

  useEffect(() => {
    const previous = previousIdentitiesRef.current;
    previousIdentitiesRef.current = identities;
    if (!previous) return;
    setFeedbackByServerId((current) => {
      let changed = false;
      const next = { ...current };
      for (const serverId of Object.keys(current)) {
        if (previous.get(serverId) === identities.get(serverId)) continue;
        delete next[serverId];
        changed = true;
      }
      return changed ? next : current;
    });
  }, [identities]);

  const runOperation = useCallback(async (
    operation: McpRowOperation,
    serverId: string,
    action: (serverId: string) => Promise<boolean>,
  ): Promise<boolean> => {
    const startingIdentity = currentIdentitiesRef.current.get(serverId);
    clearFailure(serverId);

    let succeeded = false;
    try {
      succeeded = await action(serverId);
    } catch {
      succeeded = false;
    }

    const currentIdentity = currentIdentitiesRef.current.get(serverId);
    if (!currentIdentity || startingIdentity !== currentIdentity) return false;
    if (succeeded) {
      clearFailure(serverId);
      showToast({
        message: t(operation === "check" ? "Connection check succeeded" : "Tool list synced"),
        scope: `mcp:${serverId}:${operation}`,
        tone: "success",
      });
      return true;
    }

    setFeedbackByServerId((current) => ({
      ...current,
      [serverId]: {
        message: t(operation === "check" ? "Connection check failed" : "Tool list sync failed"),
        tone: "danger",
      },
    }));
    return false;
  }, [clearFailure, showToast, t]);

  const runCheck = useCallback(
    (serverId: string, action: (serverId: string) => Promise<boolean>) => runOperation("check", serverId, action),
    [runOperation],
  );
  const runSync = useCallback(
    (serverId: string, action: (serverId: string) => Promise<boolean>) => runOperation("sync", serverId, action),
    [runOperation],
  );

  return { feedbackByServerId, runCheck, runSync };
}
