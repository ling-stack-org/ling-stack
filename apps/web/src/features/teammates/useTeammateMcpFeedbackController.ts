import { useCallback, useEffect, useRef, useState } from "react";
import { replaceTeammateMcpBindings } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { TeammateMcpBinding } from "../../types.js";

export function useTeammateMcpFeedbackController({
  bindings,
  cwd,
  onBindingsReplaced,
  teammateId,
}: {
  readonly bindings: readonly TeammateMcpBinding[];
  readonly cwd: string;
  readonly onBindingsReplaced: (bindings: readonly TeammateMcpBinding[]) => void;
  readonly teammateId: string;
}) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const identityKey = `${cwd.trim()}::${teammateId}`;
  const toastScope = `teammate:${teammateId}:mcp`;
  const identityRef = useRef(identityKey);
  const operationSequenceRef = useRef(0);
  const activeOperationRef = useRef(0);
  const previousToastScopeRef = useRef(toastScope);
  identityRef.current = identityKey;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    operationSequenceRef.current += 1;
    activeOperationRef.current = 0;
    setSaving(false);
    setError("");
    const previousScope = previousToastScopeRef.current;
    if (previousScope !== toastScope) dismissToast(previousScope);
    previousToastScopeRef.current = toastScope;
  }, [dismissToast, identityKey, toastScope]);

  useEffect(() => {
    setError("");
  }, [bindings]);

  const save = useCallback(async (): Promise<void> => {
    if (activeOperationRef.current !== 0) return;
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
        bindings
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
      onBindingsReplaced(response.bindings);
      showToast({
        message: t("Saved"),
        scope: `teammate:${teammateId}:mcp`,
        tone: "success",
      });
    } catch (cause) {
      if (identityRef.current === operationIdentity && activeOperationRef.current === operationId) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (identityRef.current === operationIdentity && activeOperationRef.current === operationId) {
        activeOperationRef.current = 0;
        setSaving(false);
      }
    }
  }, [bindings, cwd, identityKey, onBindingsReplaced, showToast, t, teammateId]);

  return {
    error,
    save,
    saving,
  } as const;
}
