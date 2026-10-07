import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import { TerminalReportPublicationError } from "./terminal-report-publisher.js";

interface RecoverySource {
  readonly kind: "workflow" | "run" | "turn";
  readonly id: string;
  readonly reportId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
}

/** Isolate independent sources without weakening atomic publication checks. */
export function createTerminalReportRecoverySweep(store: RunStore): {
  attempt(source: RecoverySource, recover: () => Promise<void> | void): Promise<void>;
  finish(): void;
} {
  const failedSources = new Set<string>();
  const failures: unknown[] = [];
  return {
    async attempt(source, recover) {
      const key = `${source.kind}:${source.id}`;
      if (failedSources.has(key)) return;
      try {
        await recover();
      } catch (error) {
        failedSources.add(key);
        failures.push(error);
        // Store only host-owned codes/lineage, never exception text, command
        // output or provider data. A conflict remains observable and retryable.
        const code = error instanceof TerminalReportPublicationError ? error.code : "recovery_failed";
        try {
          store.appendControlPlaneEvent({
            workspaceId: DEFAULT_WORKSPACE_ID, cwd: store.paths.cwd,
            domain: "runs", entityType: "terminal_report", entityId: source.reportId ?? source.id,
            action: "terminal_report.recovery_failed",
            idempotencyKey: `terminal-report:recovery-failed:${key}:${source.reportId ?? "unpublished"}:${code}`,
            data: { sourceKind: source.kind, sourceId: source.id, reportId: source.reportId,
              threadId: source.threadId, turnId: source.turnId, code },
          }, new Date().toISOString());
        } catch {
          // A diagnostic write cannot strand a different source either. The
          // sweep still rejects at finish and startup logs a safe failure code.
          console.warn("terminal_report_recovery_diagnostic_failed");
        }
      }
    },
    finish() {
      // Preserve existing caller/error semantics, but only after independent
      // recovery work has run. Partial recovery is never reported as success.
      if (failures.length > 0) throw failures[0];
    },
  };
}
