import type { Translate } from "../../i18n.js";
import { providerModelRouteLabel, providerSecretReady } from "../../lib/providers.js";
import type { AiTeammateModelBindingMode, ProviderPreset } from "../../types.js";

export const workspaceDefaultModelOptionValue = "__workspace_default__";

export type TeammateModelPrimaryState =
  | "unassigned"
  | "missing"
  | "disabled"
  | "incompatible"
  | "missing_key"
  | "unchecked"
  | "check_failed"
  | "ready";

export interface TeammateModelOption {
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
}

export interface TeammateModelFeedback {
  readonly detail: string;
  readonly tone: "danger" | "neutral" | "warning";
}

export interface TeammateModelViewModel {
  readonly bindingMode: AiTeammateModelBindingMode;
  readonly canFollowWorkspaceDefault: boolean;
  readonly emptyInventory: boolean;
  readonly feedback?: TeammateModelFeedback;
  readonly isProtected: boolean;
  readonly options: readonly TeammateModelOption[];
  readonly primaryLabel: string;
  readonly primaryState: TeammateModelPrimaryState;
  readonly primaryTone: "danger" | "info" | "neutral" | "success" | "warning";
  readonly selectionValue: string;
  readonly selectedProvider?: ProviderPreset;
}

export function buildTeammateModelViewModel({
  canFollowWorkspaceDefault,
  isProtected,
  modelBindingMode,
  providers,
  selectedProviderId,
  workspaceDefaultProviderPresetId,
  t,
}: {
  readonly canFollowWorkspaceDefault: boolean;
  readonly isProtected: boolean;
  readonly modelBindingMode: AiTeammateModelBindingMode;
  readonly providers: readonly ProviderPreset[];
  readonly selectedProviderId: string;
  readonly workspaceDefaultProviderPresetId?: string;
  readonly t: Translate;
}): TeammateModelViewModel {
  const effectiveBindingMode = isProtected ? "workspace_default" : modelBindingMode;
  const effectiveProviderId = effectiveBindingMode === "workspace_default"
    ? workspaceDefaultProviderPresetId ?? ""
    : selectedProviderId;
  const selectedProvider = effectiveProviderId
    ? providers.find((provider) => provider.id === effectiveProviderId)
    : undefined;
  const primaryState = resolvePrimaryState(effectiveProviderId, selectedProvider);
  const copy = primaryStateCopy(
    primaryState,
    providers.length === 0,
    effectiveBindingMode,
    selectedProvider,
    t,
  );
  const missingOption = effectiveBindingMode === "fixed" && selectedProviderId && !selectedProvider
    ? [{
        disabled: true,
        id: selectedProviderId,
        label: t("Previously selected model (unavailable)"),
      }]
    : [];
  const options = [
    ...(canFollowWorkspaceDefault ? [{
      disabled: false,
      id: workspaceDefaultModelOptionValue,
      label: workspaceDefaultOptionLabel(workspaceDefaultProviderPresetId, providers, t),
    }] : []),
    ...missingOption,
    ...providers.map((provider): TeammateModelOption => {
      const identity = providerModelRouteLabel(provider);
      if (!provider.enabled) {
        return {
          disabled: true,
          id: provider.id,
          label: t("{name} (disabled)", { name: identity }),
        };
      }
      if (!isChatProvider(provider)) {
        return {
          disabled: true,
          id: provider.id,
          label: t("{name} (not chat compatible)", { name: identity }),
        };
      }
      return { disabled: false, id: provider.id, label: identity };
    }),
  ];

  return {
    bindingMode: effectiveBindingMode,
    canFollowWorkspaceDefault,
    emptyInventory: !isProtected && providers.length === 0 && !canFollowWorkspaceDefault,
    feedback: copy.feedback,
    isProtected,
    options: isProtected ? [] : options,
    primaryLabel: copy.label,
    primaryState,
    primaryTone: copy.tone,
    selectionValue: effectiveBindingMode === "workspace_default"
      ? workspaceDefaultModelOptionValue
      : selectedProviderId,
    selectedProvider,
  };
}

function workspaceDefaultOptionLabel(
  workspaceDefaultProviderPresetId: string | undefined,
  providers: readonly ProviderPreset[],
  t: Translate,
): string {
  if (!workspaceDefaultProviderPresetId) {
    return t("Use workspace default (not configured)");
  }
  const provider = providers.find((item) => item.id === workspaceDefaultProviderPresetId);
  if (!provider) {
    return t("Use workspace default (unavailable)");
  }
  return t("Use workspace default (current: {model})", {
    model: providerModelRouteLabel(provider),
  });
}

function resolvePrimaryState(
  selectedProviderId: string,
  provider: ProviderPreset | undefined,
): TeammateModelPrimaryState {
  if (!selectedProviderId) return "unassigned";
  if (!provider) return "missing";
  if (!provider.enabled) return "disabled";
  if (!isChatProvider(provider)) return "incompatible";
  if (!providerSecretReady(provider)) return "missing_key";
  if (!provider.lastCheck) return "unchecked";
  if (!provider.lastCheck.ok) return "check_failed";
  return "ready";
}

function isChatProvider(provider: ProviderPreset): boolean {
  return provider.api !== "media-job" && provider.capabilities.includes("chat");
}

function primaryStateCopy(
  state: TeammateModelPrimaryState,
  emptyInventory: boolean,
  bindingMode: AiTeammateModelBindingMode,
  provider: ProviderPreset | undefined,
  t: Translate,
): {
  readonly feedback?: TeammateModelFeedback;
  readonly label: string;
  readonly tone: TeammateModelViewModel["primaryTone"];
} {
  switch (state) {
    case "unassigned":
      return {
        label: bindingMode === "workspace_default" ? t("Workspace default is not configured") : t("No model selected"),
        tone: "warning",
        feedback: {
          detail: bindingMode === "workspace_default"
            ? t("Set a workspace default chat model in Model Workbench.")
            : emptyInventory
              ? t("Configure a chat model in Model Workbench before assigning one.")
              : t("Choose a configured chat model, or open Model Workbench to add one."),
          tone: "warning" as const,
        },
      };
    case "missing":
      return {
        feedback: {
          detail: t("The previously selected model no longer exists. Choose another model or open Model Workbench."),
          tone: "danger",
        },
        label: t("Model unavailable"),
        tone: "danger",
      };
    case "disabled":
      return {
        feedback: {
          detail: t("Enable this model in Model Workbench before using it for replies."),
          tone: "warning",
        },
        label: t("Model disabled"),
        tone: "warning",
      };
    case "incompatible":
      return {
        feedback: {
          detail: t("This route cannot handle chat replies. Choose a chat model."),
          tone: "warning",
        },
        label: t("Not chat compatible"),
        tone: "warning",
      };
    case "missing_key":
      return {
        feedback: {
          detail: t("Add an API key in Model Workbench."),
          tone: "warning",
        },
        label: t("API key required"),
        tone: "warning",
      };
    case "unchecked":
      return {
        feedback: {
          detail: t("Run a model check in Model Workbench before using this teammate."),
          tone: "warning",
        },
        label: t("Check required"),
        tone: "warning",
      };
    case "check_failed":
      return {
        feedback: {
          detail: t("Fix the model check in Model Workbench before using this teammate."),
          tone: "danger",
        },
        label: t("Model check failed"),
        tone: "danger",
      };
    case "ready":
      return {
        label: bindingMode === "workspace_default"
          ? t("Workspace default · {model}", { model: provider?.model ?? "-" })
          : t("Fixed model · {model}", { model: provider?.model ?? "-" }),
        tone: "success",
      };
  }
}
