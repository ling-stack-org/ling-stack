import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, CircleDashed, ClipboardCopy, RotateCw, XCircle } from "lucide-react";
import type {
  DaemonHealthResponse,
  DiagnosticsDoctorResponse,
  DiagnosticsLogTailResponse,
} from "@ling-stack/contracts";
import { daemonClient } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import {
  buildDiagnosticsBundle,
  projectDiagnosticsDoctor,
  projectLogTailLines,
  type DiagnosticsDoctorViewModel,
} from "./diagnostics-doctor-view-model.js";

interface DiagnosticsDoctorCardProps {
  readonly cwd: string;
}

interface DiagnosticsState {
  readonly health?: DaemonHealthResponse;
  readonly doctor?: DiagnosticsDoctorResponse;
  readonly logs?: DiagnosticsLogTailResponse;
  readonly loading: boolean;
  readonly errorMessage: string;
}

export function DiagnosticsDoctorCard({ cwd }: DiagnosticsDoctorCardProps): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<DiagnosticsState>({ loading: true, errorMessage: "" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const refresh = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, errorMessage: "" }));
    try {
      const [health, doctor, logs] = await Promise.all([
        daemonClient.getHealth(),
        daemonClient.getDiagnosticsDoctor(cwd),
        daemonClient.getDiagnosticsLogs(200),
      ]);
      setState({ health, doctor, logs, loading: false, errorMessage: "" });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        loading: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doctorView: DiagnosticsDoctorViewModel = projectDiagnosticsDoctor(
    state.doctor,
    state.loading,
    state.errorMessage,
  );

  const copyBundle = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildDiagnosticsBundle({
        health: state.health,
        doctor: state.doctor,
        logs: state.logs,
      }));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [state.doctor, state.health, state.logs]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return (
    <section className="diagnostics-doctor-card" data-ui2-diagnostics-doctor="true" aria-label={t("Daemon diagnostics")}>
      <header className="diagnostics-doctor-heading">
        <strong>{t("Daemon diagnostics")}</strong>
        <div className="diagnostics-doctor-heading-actions">
          <StatusIndicator
            label={overallStatusLabel(doctorView.overallStatus, t)}
            tone={overallStatusTone(doctorView.overallStatus)}
          />
          <Button
            aria-label={t("Refresh diagnostics")}
            leadingIcon={<RotateCw aria-hidden="true" />}
            size="sm"
            variant="secondary"
            loading={state.loading}
            loadingLabel={t("Refreshing diagnostics...")}
            onClick={() => void refresh()}
          >
            {t("Refresh diagnostics")}
          </Button>
          <Button
            aria-label={t("Copy diagnostics bundle")}
            leadingIcon={<ClipboardCopy aria-hidden="true" />}
            size="sm"
            variant="secondary"
            onClick={() => void copyBundle()}
          >
            {copyState === "copied" ? t("Copied") : copyState === "failed" ? t("Copy failed") : t("Copy diagnostics bundle")}
          </Button>
        </div>
      </header>

      {doctorView.errorMessage ? (
        <InlineFeedback tone="danger" title={t("Daemon diagnostics unavailable")}>
          {doctorView.errorMessage}
        </InlineFeedback>
      ) : null}

      <ul className="diagnostics-doctor-check-list">
        {doctorView.checks.map((check) => (
          <li
            className="diagnostics-doctor-check"
            data-status={check.status}
            key={check.id}
          >
            <span className="diagnostics-doctor-check-icon" aria-hidden="true">
              {check.status === "ok" ? <CheckCircle2 /> : check.status === "warning" ? <CircleAlert /> : check.status === "fail" ? <XCircle /> : <CircleDashed />}
            </span>
            <div className="diagnostics-doctor-check-body">
              <strong>{check.summary}</strong>
              {check.details ? <small>{check.details}</small> : null}
              {check.remediation ? <small className="diagnostics-doctor-check-remediation">{check.remediation}</small> : null}
            </div>
          </li>
        ))}
      </ul>

      <InspectorSection
        aria-label={t("Daemon log tail")}
        className="diagnostics-doctor-log-section"
        summary={t("Last daemon log lines")}
        title={t("Daemon log tail")}
      >
        <pre className="diagnostics-doctor-log-lines" data-truncated={state.logs?.truncated ? "true" : undefined}>
          {projectLogTailLines(state.logs).length > 0
            ? projectLogTailLines(state.logs).join("\n")
            : t("No daemon log available")}
        </pre>
        {state.logs?.truncated ? <small>{t("Older log lines were truncated")}</small> : null}
      </InspectorSection>
    </section>
  );
}

function overallStatusLabel(status: DiagnosticsDoctorViewModel["overallStatus"], t: (key: string) => string): string {
  switch (status) {
    case "ok": return t("All checks passed");
    case "warning": return t("Warnings detected");
    case "fail": return t("Failures detected");
    case "loading": return t("Checking daemon health...");
    case "error": return t("Daemon diagnostics unavailable");
  }
}

function overallStatusTone(status: DiagnosticsDoctorViewModel["overallStatus"]): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "ok": return "success";
    case "warning": return "warning";
    case "fail":
    case "error": return "danger";
    case "loading": return "neutral";
  }
}
