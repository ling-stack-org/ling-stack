import { useState } from "react";
import { isActiveCodeAssessment } from "@ling-stack/contracts";
import type { CodeAssessmentOverview as Detail, CodeAssessmentFinding, CodeAssessmentFreshness, CodeFindingSeverity } from "@ling-stack/contracts";
import { Badge, Button, InlineFeedback, Input, Select } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { getCodeAssessment } from "../../api/code-assessments.js";
import { AssessmentDiff } from "./AssessmentDiff.js";
import { CodeFindingCard, type FindingDispositionAction } from "./CodeFindingCard.js";
import { assessmentConfidenceLabel, assessmentDispositionLabel, assessmentExclusionLabel, assessmentPhaseLabel, assessmentSeverityLabel, assessmentStatusLabel, assessmentTone } from "./assessment-labels.js";

const severityOrder: Record<CodeFindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const confidenceOrder: Record<CodeAssessmentFinding["confidence"], number> = { high: 0, medium: 1, low: 2 };

function compareFindings(left: CodeAssessmentFinding, right: CodeAssessmentFinding): number {
  return severityOrder[left.severity] - severityOrder[right.severity]
    || confidenceOrder[left.confidence] - confidenceOrder[right.confidence]
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    || left.startLine - right.startLine || left.endLine - right.endLine;
}

interface Props {
  readonly cwd: string;
  readonly detail: Detail;
  readonly busy: boolean;
  readonly freshness?: CodeAssessmentFreshness;
  readonly canRunAgain: boolean;
  readonly onCancel: () => void;
  readonly onRunAgain: () => void;
  readonly onCheckFreshness: () => void;
  readonly onDisposition: FindingDispositionAction;
  readonly onOpenRun?: (runId: string) => void;
}

export function CodeAssessmentDetail({ cwd, detail, busy, freshness, canRunAgain, onCancel, onRunAgain, onCheckFreshness, onDisposition, onOpenRun }: Props): React.JSX.Element {
  const { t } = useI18n();
  const { assessment, snapshot, findings } = detail;
  const [severity, setSeverity] = useState("");
  const [confidence, setConfidence] = useState("");
  const [disposition, setDisposition] = useState("open");
  const [search, setSearch] = useState("");
  const [selectedFindingId, setSelectedFindingId] = useState<string>();
  const [exportError, setExportError] = useState<string>();
  const active = isActiveCodeAssessment(assessment.status);
  const reported = assessment.status === "completed" || assessment.status === "partial";
  const visible = findings.filter(finding => (!severity || finding.severity === severity) && (!confidence || finding.confidence === confidence)
    && (!disposition || (disposition === "stale" ? finding.freshnessState === "stale" : finding.disposition === disposition))
    && `${finding.title} ${finding.body} ${finding.path}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort(compareFindings);
  async function exportReport(): Promise<void> {
    setExportError(undefined);
    try {
      const result = await getCodeAssessment(cwd, assessment.id);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${assessment.kind}-report.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="code-assessment-result">
    <header className="code-assessment-result-heading"><div>
      <Badge tone={assessmentTone(assessment.status)}>{t(assessmentStatusLabel[assessment.status])}</Badge>
      <Badge>{t("Read only")}</Badge>
      <h2>{assessment.kind === "security" ? t("Security scan") : t("Code review")}</h2>
      <p className="code-assessment-muted">{snapshot.target.type === "working_tree" ? t("Working tree") : snapshot.target.type === "commit" ? t("Commit") : t("Branch Diff")} · {t("{count} captured files", { count: snapshot.files.length })}</p>
    </div><div className="code-assessment-actions">{active ? <Button variant="danger" disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
      : <Button disabled={busy || !canRunAgain} onClick={onRunAgain}>{t("Run again")}</Button>}</div></header>
    <ol className="code-assessment-phases" aria-label={t("Assessment progress")}>
      {assessment.phaseHistory.map((entry, index) => <li key={`${entry.phase}-${index}`} aria-current={entry.phase === assessment.phase && index === assessment.phaseHistory.length - 1 ? "step" : undefined}>
        {t(assessmentPhaseLabel[entry.phase])}{entry.status === "skipped" ? ` · ${t("Not run")}` : ""}{entry.reason ? <span className="code-assessment-phase-reason">{entry.reason}</span> : null}
        {onOpenRun ? assessment.phaseRuns?.filter(run => run.phase === entry.phase).map(run => <Button key={run.runId} size="sm" variant="ghost" onClick={() => onOpenRun(run.runId)}>{t("Open run")}</Button>) : null}
      </li>)}
    </ol>
    {snapshot.coverage === "partial" ? <InlineFeedback tone="warning" title={t("Coverage is partial")}>{t("Excluded or redacted content was not fully assessed.")}</InlineFeedback> : null}
    <p className="code-assessment-muted">{t("Findings are unverified candidates. Dismissing a finding does not fix it.")}</p>
    {assessment.errorMessage ? <InlineFeedback tone="danger" title={t("Assessment did not complete")}>{assessment.errorMessage}</InlineFeedback> : null}
    {exportError ? <InlineFeedback tone="danger" title={t("Export unavailable")}>{exportError}</InlineFeedback> : null}
    {assessment.instructions || assessment.reviewRules?.sources.length ? <details>
      <summary>{t("Review instructions")}</summary>
      {assessment.instructions ? <p>{assessment.instructions}</p> : null}
      {assessment.reviewRules?.sources.length ? <>
        <p>{t("Base commit")} <code>{assessment.reviewRules.baseSha}</code></p>
        <ul>{assessment.reviewRules.sources.map(source => <li key={source.path}>
          <code>{source.path}</code>
          <p>{source.guidance}</p>
        </li>)}</ul>
      </> : null}
    </details> : null}
    {assessment.summary ? <section className="code-assessment-summary"><h3>{t("Summary")}</h3><p>{assessment.summary}</p></section> : null}
    <div className="code-assessment-actions"><Button size="sm" disabled={busy} onClick={onCheckFreshness}>{t("Check for changes")}</Button>
      {freshness ? <Badge tone={freshness.state === "stale" ? "warning" : "neutral"}>{freshness.state === "current" ? t("Snapshot matches") : freshness.state === "stale" ? t("Snapshot is outdated") : t("Freshness unknown")}</Badge> : <span className="code-assessment-muted">{t("Freshness not checked")}</span>}
      {reported ? <Button size="sm" variant="ghost" onClick={() => void exportReport()}>{t("Export result")}</Button> : null}
      {assessment.runId && onOpenRun ? <Button size="sm" variant="ghost" onClick={() => onOpenRun(assessment.runId!)}>{t("Open run")}</Button> : null}
    </div>
    <section className="code-assessment-findings"><h3>{t("Findings")} ({findings.length})</h3>
      {findings.length > 0 ? <div className="code-assessment-filters">
        <Input value={search} onChange={event => setSearch(event.target.value)} aria-label={t("Search findings")} placeholder={t("Search findings")} />
        <Select value={severity} onChange={event => setSeverity(event.target.value)} aria-label={t("Severity")}><option value="">{t("All severities")}</option>{Object.entries(assessmentSeverityLabel).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</Select>
        <Select value={confidence} onChange={event => setConfidence(event.target.value)} aria-label={t("Confidence")}><option value="">{t("All")}</option>{Object.entries(assessmentConfidenceLabel).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</Select>
        <Select value={disposition} onChange={event => setDisposition(event.target.value)} aria-label={t("Finding status")}><option value="">{t("All")}</option>{Object.entries(assessmentDispositionLabel).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}<option value="stale">{t("Stale")}</option></Select>
      </div> : null}
      {!findings.length ? <p className="code-assessment-muted">{active ? t("The model is analyzing the captured snapshot.") : reported ? t("No supported findings were reported in the assessed content.") : t("No report was produced. Run again to try a fresh snapshot.")}</p>
        : visible.length === 0 ? <p className="code-assessment-muted">{t("No findings match these filters.")}</p> : visible.map(finding => <CodeFindingCard key={finding.id} cwd={cwd} finding={finding} busy={busy} selected={selectedFindingId === finding.id} canResolve={freshness?.state === "current"}
          onDisposition={onDisposition} onShowDiff={() => setSelectedFindingId(finding.id)} />)}
    </section>
    <AssessmentDiff cwd={cwd} detail={detail} selectedFinding={findings.find(finding => finding.id === selectedFindingId)} onFindingSelect={id => {
      setSelectedFindingId(id); setSeverity(""); setConfidence(""); setDisposition(""); setSearch("");
      requestAnimationFrame(() => { const card = document.getElementById(`finding-${id}`); card?.scrollIntoView({ block: "nearest" }); card?.focus({ preventScroll: true }); });
    }} />
    <details className="code-assessment-technical"><summary>{t("Coverage and technical details")}</summary>
      <dl><dt>{t("Snapshot")}</dt><dd>{snapshot.digest}</dd><dt>{t("Branch")}</dt><dd>{snapshot.branchName ?? "—"}</dd><dt>{t("Commit")}</dt><dd>{snapshot.headSha}</dd>
        {snapshot.baseSha ? <><dt>{t("Base commit")}</dt><dd>{snapshot.baseSha}</dd></> : null}
        <dt>{t("Run")}</dt><dd>{assessment.runId ?? "—"}</dd><dt>{t("Threat model artifact")}</dt><dd>{assessment.threatModelArtifactId ?? "—"}</dd><dt>{t("Report artifact")}</dt><dd>{assessment.reportArtifactId ?? "—"}</dd>
        {assessment.diagnosticArtifactId ? <><dt>{t("Diagnostics")} · {t("Artifact")}</dt><dd>{assessment.diagnosticArtifactId}</dd></> : null}</dl>
      <p>{assessment.validation.reason}</p>
      <dl>{Object.entries(assessment.metrics).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      {snapshot.exclusions.length ? <ul>{snapshot.exclusions.map(item => <li key={item.path}>{item.path} · {t(assessmentExclusionLabel[item.reason])}</li>)}</ul> : null}
      {snapshot.files.some(item => item.redacted) ? <p>{t("Secret-like values were redacted from the captured Diff.")}</p> : null}
    </details>
  </div>;
}
