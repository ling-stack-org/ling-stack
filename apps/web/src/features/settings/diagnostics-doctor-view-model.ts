import type {
  DaemonHealthResponse,
  DiagnosticsCheck,
  DiagnosticsDoctorResponse,
  DiagnosticsLogTailResponse,
} from "@ling-stack/contracts";

export interface DiagnosticsCheckView {
  readonly id: string;
  readonly status: DiagnosticsCheck["status"];
  readonly summary: string;
  readonly details?: string;
  readonly remediation?: string;
}

export interface DiagnosticsDoctorViewModel {
  readonly overallStatus: "ok" | "warning" | "fail" | "loading" | "error";
  readonly checks: readonly DiagnosticsCheckView[];
  readonly generatedAt?: string;
  readonly errorMessage?: string;
}

export function projectDiagnosticsDoctor(
  response: DiagnosticsDoctorResponse | undefined,
  loading: boolean,
  errorMessage: string,
): DiagnosticsDoctorViewModel {
  if (errorMessage.length > 0 && !response) {
    return { overallStatus: "error", checks: [], errorMessage };
  }
  if (!response) {
    return { overallStatus: loading ? "loading" : "error", checks: [], errorMessage: errorMessage || undefined };
  }
  return {
    overallStatus: response.overallStatus,
    checks: response.checks.map((check) => ({
      id: check.id,
      status: check.status,
      summary: check.summary,
      details: check.details,
      remediation: check.remediation,
    })),
    generatedAt: response.generatedAt,
  };
}

export const DIAGNOSTICS_BUNDLE_VERSION = 1;

export function buildDiagnosticsBundle(input: {
  readonly health?: DaemonHealthResponse;
  readonly doctor?: DiagnosticsDoctorResponse;
  readonly logs?: DiagnosticsLogTailResponse;
}): string {
  return JSON.stringify(
    {
      bundleVersion: DIAGNOSTICS_BUNDLE_VERSION,
      generatedAt: new Date().toISOString(),
      health: input.health ?? null,
      doctor: input.doctor ?? null,
      logs: input.logs ?? null,
    },
    null,
    2,
  );
}

export function projectLogTailLines(response: DiagnosticsLogTailResponse | undefined): readonly string[] {
  if (!response) return [];
  return response.lines;
}
