import type { ExternalWorkStatusResponse } from "../../types.js";

export type ExternalWorkStatusTone = "danger" | "info" | "neutral" | "success" | "warning";

export interface ExternalWorkPrimaryState {
  readonly code: string;
  readonly label: string;
  readonly tone: ExternalWorkStatusTone;
}

export function externalWorkOverallState(status: ExternalWorkStatusResponse): ExternalWorkPrimaryState {
  if (!status.workflow.exists) return state("workflow-missing", "Not configured", "warning");
  if (!status.workflow.valid) return state("workflow-invalid", "Needs attention", "danger");
  if (status.secret.status === "unavailable" || status.secret.status === "invalid") {
    return state(`credential-${status.secret.status}`, "Needs attention", "danger");
  }
  if (status.secret.status === "missing") return state("credential-missing", "Credential required", "warning");
  if (status.background.status === "failed") return state("background-failed", "Needs attention", "danger");
  return state("ready", "Ready", "success");
}

export function externalWorkWorkflowState(status: ExternalWorkStatusResponse): ExternalWorkPrimaryState {
  if (!status.workflow.exists) return state("missing", "Not configured", "warning");
  if (!status.workflow.valid) return state("invalid", "Needs attention", "danger");
  return state("ready", "Ready", "success");
}

export function externalWorkCredentialState(status: ExternalWorkStatusResponse): ExternalWorkPrimaryState {
  switch (status.secret.status) {
    case "configured":
      return state("configured", "Ready", "success");
    case "missing":
      return state("missing", "Credential required", "warning");
    case "invalid":
      return state("invalid", "Needs attention", "danger");
    case "unavailable":
      return state("unavailable", "Unavailable", "danger");
    case "not_required":
      return state("not-required", "Not required", "neutral");
  }
}

export function externalWorkBackgroundState(status: ExternalWorkStatusResponse): ExternalWorkPrimaryState {
  switch (status.background.status) {
    case "running":
      return state("running", "Running", "info");
    case "stopped":
      return state("stopped", "Stopped", "neutral");
    case "failed":
      return state("failed", "Failed", "danger");
    case "unsupported":
      return state("unsupported", "Unsupported", "neutral");
    case "not_configured":
      return state("not-configured", "Not configured", "neutral");
  }
}

export function externalWorkSourceLabel(status: ExternalWorkStatusResponse): "GitHub" | "Linear" | "Not configured" {
  if (status.workflow.sourceKind === "github") return "GitHub";
  if (status.workflow.sourceKind === "linear") return "Linear";
  return "Not configured";
}

export function externalWorkTarget(status: ExternalWorkStatusResponse): string | undefined {
  return status.workflow.repository ?? status.workflow.projectSlug;
}

export function canConfigureExternalWorkCredential(status: ExternalWorkStatusResponse): boolean {
  return status.workflow.valid && status.workflow.sourceKind !== "unknown";
}

export function canRemoveExternalWorkCredential(status: ExternalWorkStatusResponse): boolean {
  const secretRef = status.secret.ref ?? status.workflow.secretRef;
  return status.secret.status !== "missing" && Boolean(secretRef?.startsWith("keychain:"));
}

export function externalWorkLastError(status: ExternalWorkStatusResponse): string | undefined {
  return status.lastErrors.background ?? status.lastErrors.poll ?? status.lastErrors.reconcile;
}

export function normalizeExternalWorkRepositoryInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (url.hostname !== "github.com") return undefined;
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      candidate = owner && repo ? `${owner}/${repo}` : "";
    } catch {
      return undefined;
    }
  }

  candidate = candidate.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return /^[^/\s]+\/[^/\s]+$/u.test(candidate) ? candidate : undefined;
}

function state(code: string, label: string, tone: ExternalWorkStatusTone): ExternalWorkPrimaryState {
  return { code, label, tone };
}
