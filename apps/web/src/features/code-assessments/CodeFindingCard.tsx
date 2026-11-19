import { useState } from "react";
import type { CodeAssessmentFinding, CodeFindingDisposition, CodeFindingCloseReason } from "@ling-stack/contracts";
import { Badge, Button, Field, Select, Textarea } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { assessmentCloseReasonLabel, assessmentConfidenceLabel, assessmentDispositionLabel, assessmentSeverityLabel } from "./assessment-labels.js";
import { FindingComments } from "./FindingComments.js";

export interface FindingDispositionAction {
  (findingId: string, disposition: CodeFindingDisposition, reason?: string, closeReason?: CodeFindingCloseReason): Promise<boolean>;
}

export function CodeFindingCard({ cwd, finding, busy, selected, canResolve, onDisposition, onShowDiff }: {
  readonly cwd: string; readonly finding: CodeAssessmentFinding; readonly busy: boolean; readonly selected: boolean; readonly canResolve: boolean;
  readonly onDisposition: FindingDispositionAction; readonly onShowDiff: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [closing, setClosing] = useState<"dismissed" | "resolved">();
  const [reason, setReason] = useState("");
  const [closeReason, setCloseReason] = useState<CodeFindingCloseReason>("out_of_scope");
  return <article id={`finding-${finding.id}`} tabIndex={-1} className={`code-assessment-finding severity-${finding.severity}${selected ? " selected" : ""}`}>
    <div className="code-assessment-finding-heading"><Badge tone={finding.severity === "high" || finding.severity === "critical" ? "danger" : finding.severity === "medium" ? "warning" : "neutral"}>{t(assessmentSeverityLabel[finding.severity])}</Badge><h4>{finding.title}</h4>
      <Badge>{t(assessmentDispositionLabel[finding.disposition])}</Badge>{finding.freshnessState === "stale" ? <Badge tone="warning">{t("Stale")}</Badge> : null}
    </div>
    <Button size="sm" variant="ghost" onClick={onShowDiff}>{finding.path}:{finding.startLine}–{finding.endLine} · {finding.side === "old" ? t("Before change") : t("After change")}</Button>
    <p>{finding.body}</p><pre>{finding.evidence}</pre>
    <p className="code-assessment-muted">{t(assessmentConfidenceLabel[finding.confidence])} · {t("Unverified")}{finding.cwe ? ` · ${finding.cwe}` : ""}</p>
    {finding.closeReason ? <p>{t("Close reason")}: {t(assessmentCloseReasonLabel[finding.closeReason])}</p> : null}
    {finding.dispositionReason ? <p>{t("Dismissal reason")}: {finding.dispositionReason}</p> : null}
    {closing ? <form className="code-assessment-dismiss" onSubmit={event => { event.preventDefault(); void onDisposition(finding.id, closing, reason, closeReason).then(saved => { if (saved) setClosing(undefined); }); }}>
      <Field label={t("Close reason")}><Select aria-label={t("Close reason")} value={closeReason} onChange={event => setCloseReason(event.target.value as CodeFindingCloseReason)}>{Object.entries(assessmentCloseReasonLabel).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</Select></Field>
      <Field label={t("Dismissal reason")}><Textarea aria-label={t("Dismissal reason")} value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} required /></Field>
      <div className="code-assessment-actions"><Button type="submit" size="sm" disabled={busy || !reason.trim()}>{closing === "dismissed" ? t("Ignore") : t("Mark resolved")}</Button><Button size="sm" variant="ghost" onClick={() => setClosing(undefined)}>{t("Cancel")}</Button></div>
    </form> : <div className="code-assessment-actions">
      {finding.disposition !== "open" ? <Button size="sm" disabled={busy} onClick={() => void onDisposition(finding.id, "open")}>{t("Reopen")}</Button> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onDisposition(finding.id, "acknowledged")}>{t("Acknowledge")}</Button>}
      {finding.disposition !== "dismissed" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setClosing("dismissed")}>{t("Ignore")}</Button> : null}
      {finding.disposition !== "resolved" ? <Button size="sm" variant="ghost" disabled={busy || !canResolve || finding.freshnessState === "stale"} onClick={() => setClosing("resolved")}>{t("Mark resolved")}</Button> : null}
    </div>}
    <FindingComments cwd={cwd} finding={finding} />
  </article>;
}
