import type { ProviderPreset } from "../../types.js";

export type ProviderListFreshness = "initial" | "fresh" | "refreshing" | "stale" | "error";
export type ProviderEditorMode = "closed" | "create" | "edit";
export type ProviderDiscoveryPhase = "idle" | "loading" | "ready" | "empty" | "error";
export type ProviderMutationKind = "check" | "batch-check" | "save" | "import" | "default" | "enable" | "disable" | "delete";

export interface ProviderDeleteView {
  readonly busy: boolean;
  readonly target: ProviderPreset | undefined;
}

export interface ProviderFeedbackView {
  readonly dismiss: "auto" | "input-change" | "object-change" | "retry" | "manual";
  readonly owner: "field" | "editor" | "row" | "page" | "toast";
  readonly scope: string;
  readonly tone: "info" | "success" | "warning" | "error";
}
