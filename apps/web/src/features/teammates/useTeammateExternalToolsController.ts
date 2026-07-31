import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { replaceTeammateMcpBindings } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { McpTool, TeammateMcpBinding } from "../../types.js";
import {
  externalToolBindingsFingerprint,
  selectedExternalToolNames,
  type ExternalToolFilter,
} from "./teammate-external-tools-view-models.js";

export function useTeammateExternalToolsController({
  authoritativeBindings,
  cwd,
  onBindingsReplaced,
  teammateId,
  toolsByServerId,
}: {
  readonly authoritativeBindings: readonly TeammateMcpBinding[];
  readonly cwd: string;
  readonly onBindingsReplaced: (bindings: readonly TeammateMcpBinding[]) => void;
  readonly teammateId: string;
  readonly toolsByServerId: ReadonlyMap<string, readonly McpTool[]>;
}) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const identityKey = `${cwd.trim()}::${teammateId}`;
  const toastScope = `teammate:${teammateId}:mcp`;
  const identityRef = useRef(identityKey);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef(0);
  const authoritativeBindingsRef = useRef(authoritativeBindings);
  const authoritativeFingerprintRef = useRef("");
  const previousIdentityKeyRef = useRef(identityKey);
  const previousToastScopeRef = useRef(toastScope);
  identityRef.current = identityKey;
  authoritativeBindingsRef.current = authoritativeBindings;

  const authoritativeFingerprint = useMemo(
    () => externalToolBindingsFingerprint(authoritativeBindings),
    [authoritativeBindings],
  );
  if (!authoritativeFingerprintRef.current) authoritativeFingerprintRef.current = authoritativeFingerprint;
  const [draftBindings, setDraftBindings] = useState<readonly TeammateMcpBinding[]>(authoritativeBindings);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<ExternalToolFilter>("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const bindingByServerId = useMemo(
    () => new Map(draftBindings.map((binding) => [binding.serverId, binding])),
    [draftBindings],
  );
  const dirty = useMemo(
    () => externalToolBindingsFingerprint(draftBindings) !== authoritativeFingerprint,
    [authoritativeFingerprint, draftBindings],
  );

  useEffect(() => {
    operationSequenceRef.current += 1;
    activeOperationRef.current = 0;
    setDraftBindings(authoritativeBindingsRef.current);
    setSelectedServerId("");
    setSearchQuery("");
    setFilter("all");
    setSaving(false);
    setError("");
    if (previousIdentityKeyRef.current !== identityKey) {
      dismissToast(previousToastScopeRef.current);
    }
    previousIdentityKeyRef.current = identityKey;
    previousToastScopeRef.current = toastScope;
    authoritativeFingerprintRef.current = externalToolBindingsFingerprint(authoritativeBindingsRef.current);
  }, [dismissToast, identityKey, toastScope]);

  useEffect(() => {
    const previousAuthoritativeFingerprint = authoritativeFingerprintRef.current;
    authoritativeFingerprintRef.current = authoritativeFingerprint;
    setDraftBindings((current) => (
      externalToolBindingsFingerprint(current) === previousAuthoritativeFingerprint
        ? authoritativeBindings
        : current
    ));
  }, [authoritativeBindings, authoritativeFingerprint]);

  const toggleTool = useCallback((serverId: string, toolName: string): void => {
    setError("");
    setDraftBindings((current) => {
      const existing = current.find((binding) => binding.serverId === serverId);
      const selected = new Set(selectedExternalToolNames(existing, toolsByServerId.get(serverId) ?? []));
      if (selected.has(toolName)) selected.delete(toolName);
      else selected.add(toolName);
      const nextBinding: TeammateMcpBinding | undefined = selected.size > 0 ? {
        teammateId,
        serverId,
        mode: "selected",
        selectedToolNames: [...selected].sort(),
        approvalOverrides: existing?.approvalOverrides ?? {},
        enabled: true,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } : undefined;
      return [
        ...current.filter((binding) => binding.serverId !== serverId),
        ...(nextBinding ? [nextBinding] : []),
      ];
    });
  }, [teammateId, toolsByServerId]);

  const reset = useCallback((): void => {
    setDraftBindings(authoritativeBindings);
    setError("");
  }, [authoritativeBindings]);

  const save = useCallback(async (): Promise<void> => {
    if (!dirty || activeOperationRef.current !== 0) return;
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      setError(t("Workspace path is required."));
      return;
    }
    const operationIdentity = identityKey;
    const operationId = ++operationSequenceRef.current;
    activeOperationRef.current = operationId;
    setError("");
    setSaving(true);
    try {
      const response = await replaceTeammateMcpBindings(
        workspaceCwd,
        teammateId,
        draftBindings
          .filter((binding) => binding.enabled && (binding.mode === "all_current_tools" || binding.selectedToolNames.length > 0))
          .map((binding) => ({
            serverId: binding.serverId,
            mode: binding.mode,
            selectedToolNames: binding.mode === "selected" ? binding.selectedToolNames : undefined,
            approvalOverrides: binding.approvalOverrides,
            enabled: binding.enabled,
          })),
      );
      if (identityRef.current !== operationIdentity || activeOperationRef.current !== operationId) return;
      setDraftBindings(response.bindings);
      onBindingsReplaced(response.bindings);
      showToast({ message: t("External tools saved"), scope: toastScope, tone: "success" });
    } catch {
      if (identityRef.current === operationIdentity && activeOperationRef.current === operationId) {
        setError(t("External tool settings were not saved. Try again."));
      }
    } finally {
      if (identityRef.current === operationIdentity && activeOperationRef.current === operationId) {
        activeOperationRef.current = 0;
        setSaving(false);
      }
    }
  }, [cwd, dirty, draftBindings, identityKey, onBindingsReplaced, showToast, t, teammateId, toastScope]);

  return {
    bindingByServerId,
    dirty,
    error,
    filter,
    saving,
    searchQuery,
    selectedServerId,
    closeServer: () => setSelectedServerId(""),
    openServer: (serverId: string) => {
      setSelectedServerId(serverId);
      setSearchQuery("");
      setFilter("all");
    },
    reset,
    save,
    setFilter,
    setSearchQuery,
    toggleTool,
  } as const;
}

export type TeammateExternalToolsController = ReturnType<typeof useTeammateExternalToolsController>;
