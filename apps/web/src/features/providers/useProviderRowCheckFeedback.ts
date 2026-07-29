import { useCallback, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../i18n.js";
import { providerCheckDisplayMessage } from "../../lib/providers.js";
import { useLingToast } from "../../shared/ui/index.js";
import type { ProviderCheckResult, ProviderPreset } from "../../types.js";
import type { ProviderCheckScope } from "./types.js";

interface ProviderRowCheckFeedbackInput {
  readonly providers: readonly ProviderPreset[];
  readonly checkedProviderId: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly checkScope: ProviderCheckScope | undefined;
  readonly onCheck: (providerId: string) => void;
  readonly onClearCheckFeedback: (providerId: string) => void;
}

function providerIdentityKey(provider: ProviderPreset): string {
  return JSON.stringify({
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    providerTransport: provider.providerTransport,
    baseUrl: provider.baseUrl,
    apiKeyRef: provider.apiKeyRef,
    apiKeyConfigured: provider.apiKeyConfigured,
    apiKeyStatus: provider.apiKeyStatus,
    headers: provider.headers,
    secretHeaderRefs: provider.secretHeaderRefs,
    secretHeaderStatuses: provider.secretHeaderStatuses,
    authHeader: provider.authHeader,
    reasoning: provider.reasoning,
    thinkingModes: provider.thinkingModes,
    input: provider.input,
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxTokens,
    compat: provider.compat,
    capabilities: provider.capabilities,
  });
}

function providerListIdentityKey(providers: readonly ProviderPreset[]): string {
  return providers.map(providerIdentityKey).join("\u001f");
}

function providerCheckResultKey(providerId: string, result: ProviderCheckResult): string {
  return [providerId, result.checkedAt, result.code ?? "", result.message].join("\u001f");
}

export function useProviderRowCheckFeedback(input: ProviderRowCheckFeedbackInput) {
  const { t } = useI18n();
  const { dismissToast, showToast } = useLingToast();
  const handledSuccessRef = useRef("");
  const providerListIdentity = useMemo(
    () => providerListIdentityKey(input.providers),
    [input.providers],
  );
  const previousProviderListIdentityRef = useRef(providerListIdentity);
  const checkedProvider = input.checkedProviderId
    ? input.providers.find((provider) => provider.id === input.checkedProviderId)
    : undefined;
  const rowCheckResult = input.checkScope === "row" ? input.checkResult : undefined;

  useEffect(() => {
    if (!rowCheckResult?.ok || !input.checkedProviderId || !checkedProvider) return;
    const resultKey = providerCheckResultKey(input.checkedProviderId, rowCheckResult);
    if (handledSuccessRef.current === resultKey) return;
    handledSuccessRef.current = resultKey;
    showToast({
      message: providerCheckDisplayMessage(rowCheckResult, checkedProvider, t),
      scope: `provider:${input.checkedProviderId}:check`,
      title: t("Check passed"),
      tone: "success",
    });
    input.onClearCheckFeedback(input.checkedProviderId);
  }, [
    checkedProvider,
    input.checkedProviderId,
    input.onClearCheckFeedback,
    rowCheckResult,
    showToast,
    t,
  ]);

  useEffect(() => {
    const previousProviderListIdentity = previousProviderListIdentityRef.current;
    previousProviderListIdentityRef.current = providerListIdentity;
    if (
      previousProviderListIdentity === providerListIdentity ||
      input.checkScope !== "row" ||
      !input.checkedProviderId ||
      !input.checkResult ||
      input.checkResult.ok
    ) {
      return;
    }
    input.onClearCheckFeedback(input.checkedProviderId);
  }, [
    input.checkedProviderId,
    input.checkResult,
    input.checkScope,
    input.onClearCheckFeedback,
    providerListIdentity,
  ]);

  const check = useCallback((providerId: string): void => {
    if (input.checkScope === "row" && input.checkedProviderId) {
      input.onClearCheckFeedback(input.checkedProviderId);
    }
    handledSuccessRef.current = "";
    dismissToast(`provider:${providerId}:check`);
    input.onCheck(providerId);
  }, [
    dismissToast,
    input.checkedProviderId,
    input.checkScope,
    input.onCheck,
    input.onClearCheckFeedback,
  ]);

  return {
    check,
    listCheckResult: rowCheckResult?.ok ? undefined : input.checkResult,
  } as const;
}
