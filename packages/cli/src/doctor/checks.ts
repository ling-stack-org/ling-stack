export type DoctorStatus = "ok" | "warning" | "fail";

export interface DoctorIssue {
  readonly severity: DoctorStatus;
  readonly cause: string;
  readonly measured?: string;
  readonly expected?: string;
  readonly remedy?: string;
  readonly fields?: readonly string[];
}

export interface DoctorCheck {
  readonly id: string;
  readonly category: string;
  readonly status: DoctorStatus;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly issues: readonly DoctorIssue[];
  readonly remediation?: string;
  readonly durationMs: number;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly overallStatus: DoctorStatus;
  readonly cwd: string;
  readonly daemonUrl: string;
  readonly checks: readonly DoctorCheck[];
}

export function overallDoctorStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  return "ok";
}

export function checkStatusExitCode(status: DoctorStatus): number {
  return status === "fail" ? 4 : 0;
}
