/**
 * System diagnostics contract (ux-gap-roadmap-13).
 *
 * The daemon exposes bounded, versioned doctor checks and a redacted log tail
 * so the web settings panel can answer "is the daemon healthy" without the CLI.
 * The CLI keeps its own richer client-composed report; these checks are the
 * daemon-side subset only.
 */

export type DiagnosticsCheckStatus = "ok" | "warning" | "fail" | "unchecked";

export interface DiagnosticsCheck {
  readonly id: string;
  readonly category: "workspace" | "startup" | "logs" | "config";
  readonly status: DiagnosticsCheckStatus;
  readonly summary: string;
  readonly details?: string;
  readonly remediation?: string;
}

export interface DiagnosticsDoctorResponse {
  readonly doctorVersion: 1;
  readonly cwd: string;
  readonly overallStatus: "ok" | "warning" | "fail";
  readonly checks: readonly DiagnosticsCheck[];
  readonly generatedAt: string;
}

export interface DiagnosticsLogTailResponse {
  readonly logVersion: 1;
  readonly logPath: string | null;
  readonly truncated: boolean;
  readonly lines: readonly string[];
}
