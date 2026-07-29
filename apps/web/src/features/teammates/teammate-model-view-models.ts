import type { Translate } from "../../i18n.js";
import { providerSecretReady } from "../../lib/providers.js";
import type { ProviderPreset } from "../../types.js";

export type TeammateModelPrimaryState =
  | "managed"
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
  readonly emptyInventory: boolean;
  readonly feedback?: TeammateModelFeedback;
  readonly isProtected: boolean;
  readonly modelLabel: string;
  readonly options: readonly TeammateModelOption[];
  readonly primaryLabel: string;
  readonly primaryState: TeammateModelPrimaryState;
  readonly primaryTone: "danger" | "info" | "neutral" | "success" | "warning";
  readonly providerLabel: string;
  readonly selectedProvider?: ProviderPreset;
  readonly selectedProviderId: string;
}

export function buildTeammateModelViewModel({
  isProtected,
  providers,
  selectedProviderId,
  t,
}: {
  readonly isProtected: boolean;
  readonly providers: readonly ProviderPreset[];
  readonly selectedProviderId: string;
  readonly t: Translate;
}): TeammateModelViewModel {
  if (isProtected) {
    return {
      emptyInventory: false,
      feedback: {
        detail: t("Ling Agent uses the model selected by its active channel or workspace."),
        tone: "neutral",
      },
      isProtected: true,
      modelLabel: t("Automatic"),
      options: [],
      primaryLabel: t("Managed by Ling Stack"),
      primaryState: "managed",
      primaryTone: "info",
      providerLabel: t("Channel or workspace"),
      selectedProviderId: "",
    };
  }

  const selectedProvider = selectedProviderId
    ? providers.find((provider) => provider.id === selectedProviderId)
    : undefined;
  const primaryState = resolvePrimaryState(selectedProviderId, selectedProvider);
  const copy = primaryStateCopy(primaryState, providers.length === 0, t);
  const missingOption = selectedProviderId && !selectedProvider
    ? [{
        disabled: true,
        id: selectedProviderId,
        label: t("Previously selected model (unavailable)"),
      }]
    : [];
  const options = [
    ...missingOption,
    ...providers.map((provider): TeammateModelOption => {
      const identity = `${provider.displayName} / ${provider.model}`;
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
    emptyInventory: providers.length === 0 && !selectedProviderId,
    feedback: copy.feedback,
    isProtected: false,
    modelLabel: selectedProvider?.model ?? (selectedProviderId ? t("Unavailable") : "-"),
    options,
    primaryLabel: copy.label,
    primaryState,
    primaryTone: copy.tone,
    providerLabel: selectedProvider?.displayName ?? (selectedProviderId ? t("Unavailable") : t("None")),
    selectedProvider,
    selectedProviderId,
  };
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
  t: Translate,
): {
  readonly feedback?: TeammateModelFeedback;
  readonly label: string;
  readonly tone: TeammateModelViewModel["primaryTone"];
} {
  switch (state) {
    case "managed":
      return { label: t("Managed by Ling Stack"), tone: "info" };
    case "unassigned":
      return {
        label: t("No model selected"),
        tone: "warning",
        ...(emptyInventory ? {} : {
          feedback: {
            detail: t("Choose a configured chat model, or open Model Workbench to add one."),
            tone: "warning" as const,
          },
        }),
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
      return { label: t("Ready for replies"), tone: "success" };
  }
}
