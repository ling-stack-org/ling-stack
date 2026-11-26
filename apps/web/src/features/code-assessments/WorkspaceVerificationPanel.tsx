import { useCallback, useEffect, useRef, useState } from "react";
import { Play, RefreshCw, Square } from "lucide-react";
import type { LingAppServerVerificationCheckStatus, LingAppServerVerifyOperation, WorkspaceVerificationReport } from "@ling-stack/contracts";
import { cancelWorkspaceVerification, getWorkspaceVerification, startWorkspaceVerification } from "../../api/workspace-verification.js";
import { useI18n } from "../../i18n.js";
import { Badge, Button, InlineFeedback } from "../../shared/ui/index.js";

const labels: Record<LingAppServerVerificationCheckStatus | LingAppServerVerifyOperation["status"], string> = {
  queued: "Queued", pending: "Pending", running: "Running", passed: "Passed", failed: "Failed",
  not_run: "Not run", blocked: "Blocked", cancelled: "Cancelled", unknown: "Unknown status",
};

export function WorkspaceVerificationPanel({ cwd, threadId }: { readonly cwd: string; readonly threadId?: string }): React.JSX.Element {
  const { t } = useI18n();
  const [report, setReport] = useState<WorkspaceVerificationReport>();
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const requestKey = useRef<string | undefined>(undefined);
  const operation = report?.operation;
  const active = Boolean(operation && !operation.completedAt);
  const status = operation?.status ?? "not_run";
  const refresh = useCallback(async (operationId?: string) => {
    const current = ++sequence.current;
    try {
      const next = await getWorkspaceVerification(cwd, threadId, operationId);
      if (sequence.current === current) {
        setReport(next);
        setError(undefined);
        if (next.operation?.completedAt || !next.operation) requestKey.current = undefined;
      }
    } catch (cause) {
      if (sequence.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence.current === current) setLoading(false);
    }
  }, [cwd, threadId]);

  useEffect(() => {
    void refresh();
    return () => { sequence.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!operation || !active || error || stopping) return;
    const timer = window.setTimeout(() => void refresh(operation.operationId), 1200);
    return () => window.clearTimeout(timer);
  }, [active, operation, refresh, error, stopping]);

  async function runVerification() {
    if (starting || active || loading) return;
    const current = ++sequence.current;
    setStarting(true);
    setError(undefined);
    try {
      const idempotencyKey = requestKey.current ??= crypto.randomUUID();
      const next = await startWorkspaceVerification(cwd, { idempotencyKey, threadId });
      if (sequence.current === current) {
        requestKey.current = undefined;
        setReport(next);
      }
    } catch (cause) {
      if (sequence.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence.current === current) setStarting(false);
    }
  }

  async function stopVerification() {
    if (!operation || !active || stopping) return;
    const current = ++sequence.current;
    setStopping(true);
    setError(undefined);
    try {
      await cancelWorkspaceVerification(cwd, { operationId: operation.operationId,
        idempotencyKey: `web_verify_cancel:${operation.operationId}` });
    } catch (cause) {
      if (sequence.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence.current === current) setStopping(false);
    }
  }

  return <section className="workspace-verification-card" aria-label={t("Verification")}>
    <div className="workspace-verification-card__header">
      <strong>{t("Verify current changes")}</strong>
      <div className="code-assessment-actions">
        <Button size="sm" variant="ghost" aria-label={t("Refresh verification")} leadingIcon={<RefreshCw />}
          disabled={starting || stopping || loading} onClick={() => void refresh()} />
        {active ? <Button size="sm" variant="secondary" leadingIcon={<Square />} loading={stopping}
          onClick={() => void stopVerification()}>{t("Stop verification")}</Button>
          : <Button size="sm" variant="secondary" leadingIcon={<Play />} loading={starting}
            disabled={loading} onClick={() => void runVerification()}>{t("Verify")}</Button>}
      </div>
    </div>
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
    {loading ? <p role="status">{t("Loading")}</p> : <div className="workspace-verification-card__status" aria-live="polite">
      <Badge tone={status === "passed" ? "success" : status === "failed" ? "danger" : status === "blocked" ? "warning" : "neutral"}>
        {t(labels[status])}
      </Badge>
      {operation ? <code title={operation.candidateDigest}>{operation.candidateDigest.slice(0, 12)}</code> : null}
      {report?.candidateState === "changed" ? <small>{t("Candidate changed since verification")}</small> : null}
      {report?.candidateState === "unavailable" ? <small>{t("Candidate comparison unavailable")}</small> : null}
    </div>}
    {operation?.checks.length ? <ul className="workspace-verification-checks">{operation.checks.map(check => {
      const label = report?.plan?.checks.find(entry => entry.checkId === check.checkId)?.label ?? check.checkId;
      return <li key={check.checkId}>
        <div className="workspace-verification-card__header"><span>{label}</span><small>{t(labels[check.status])}</small></div>
        {check.execution?.output ? <details><summary>{t("Check output")}</summary><pre>{check.execution.output}</pre></details> : null}
      </li>;
    })}</ul> : null}
  </section>;
}
