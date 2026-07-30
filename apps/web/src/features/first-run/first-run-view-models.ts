import type { Translate } from "../../i18n.js";

export type FirstRunStepId = "check" | "model" | "workspace";

export interface FirstRunReadiness {
  readonly daemonReady: boolean;
  readonly hasReadyProvider: boolean;
  readonly workspaceReady: boolean;
}

export interface FirstRunStepViewModel {
  readonly id: FirstRunStepId;
  readonly label: string;
  readonly ready: boolean;
}

export function initialFirstRunStep(readiness: FirstRunReadiness): FirstRunStepId {
  if (!readiness.workspaceReady || !readiness.daemonReady) return "workspace";
  if (!readiness.hasReadyProvider) return "model";
  return "check";
}

export function firstRunReady(readiness: FirstRunReadiness): boolean {
  return readiness.daemonReady && readiness.workspaceReady && readiness.hasReadyProvider;
}

export function firstRunSteps(readiness: FirstRunReadiness, t: Translate): readonly FirstRunStepViewModel[] {
  return [
    { id: "workspace", label: t("Workspace"), ready: readiness.daemonReady && readiness.workspaceReady },
    { id: "model", label: t("Model"), ready: readiness.hasReadyProvider },
    { id: "check", label: t("Ready"), ready: firstRunReady(readiness) },
  ];
}
