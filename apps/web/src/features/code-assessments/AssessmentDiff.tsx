import { useEffect, useMemo, useState } from "react";
import type { CodeAssessmentFinding, CodeAssessmentOverview, CodeAssessmentSnapshotFile } from "@ling-stack/contracts";
import { Button, Field, InlineFeedback, Input, Select } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { getCodeAssessmentFile } from "../../api/code-assessments.js";
import { DiffViewer, type DiffViewerLayout } from "../../shared/conversation/blocks/DiffViewer.js";

interface Props {
  readonly cwd: string;
  readonly detail: CodeAssessmentOverview;
  readonly selectedFinding?: CodeAssessmentFinding;
  readonly onFindingSelect: (id: string) => void;
}

export function AssessmentDiff({ cwd, detail, selectedFinding, onFindingSelect }: Props): React.JSX.Element {
  const { t } = useI18n();
  const [path, setPath] = useState(selectedFinding?.path ?? detail.snapshot.files[0]?.path ?? "");
  const [filter, setFilter] = useState("");
  const [file, setFile] = useState<CodeAssessmentSnapshotFile>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [mode, setMode] = useState<DiffViewerLayout>("auto");
  const [wrap, setWrap] = useState(false);
  useEffect(() => { if (selectedFinding) setPath(selectedFinding.path); }, [selectedFinding]);
  useEffect(() => {
    let cancelled = false;
    setFile(undefined); setError(undefined);
    if (!path) return;
    setLoading(true);
    void getCodeAssessmentFile(cwd, detail.assessment.id, path).then(result => {
      if (cancelled) return;
      if (result.snapshotDigest !== detail.snapshot.digest || result.file.path !== path) throw new Error(t("Snapshot does not match"));
      setFile(result.file);
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, detail.assessment.id, detail.snapshot.digest, path, retry, t]);
  const groups = useMemo(() => {
    const result = new Map<string, typeof detail.snapshot.files[number][]>();
    for (const item of detail.snapshot.files) {
      if (!item.path.toLowerCase().includes(filter.toLowerCase())) continue;
      const directory = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : ".";
      const entries = result.get(directory) ?? [];
      entries.push(item); result.set(directory, entries);
    }
    return [...result.entries()];
  }, [detail.snapshot.files, filter]);
  const findings = detail.findings.filter(finding => finding.path === path);
  return <section className="code-assessment-snapshot">
    <h3>{t("Captured Diff")}</h3>
    <Input aria-label={t("Filter files")} placeholder={t("Filter files")} value={filter} onChange={event => setFilter(event.target.value)} />
    <nav className="code-assessment-files" aria-label={t("Captured files")}>
      {groups.map(([directory, entries]) => <details key={directory} open><summary>{directory}</summary>{entries.map(item => <Button key={item.path} size="sm" variant={item.path === path ? "secondary" : "ghost"}
        aria-pressed={item.path === path} onClick={() => setPath(item.path)}>{item.path.split("/").at(-1)} <span>+{item.additions ?? 0} −{item.deletions ?? 0}</span></Button>)}</details>)}
    </nav>
    <div className="code-assessment-actions">
      <Field label={t("Diff layout")}><Select aria-label={t("Diff layout")} value={mode} onChange={event => setMode(event.target.value as DiffViewerLayout)}><option value="auto">{t("Auto")}</option><option value="unified">{t("Unified")}</option><option value="split">{t("Split")}</option></Select></Field>
      <Button size="sm" aria-pressed={wrap} onClick={() => setWrap(current => !current)}>{t("Wrap lines")}</Button>
    </div>
    {loading ? <p role="status">{t("Loading")}</p> : error ? <InlineFeedback tone="danger" title={t("Diff unavailable")}>{error}<Button size="sm" onClick={() => setRetry(current => current + 1)}>{t("Retry")}</Button></InlineFeedback>
      : file ? <div className={`code-assessment-diff${wrap ? " wrap" : ""}`}>
        <DiffViewer key={file.path} layout={mode} change={{ id: file.path, path: file.path, kind: file.kind === "deleted" ? "delete" : file.kind === "renamed" ? "rename" : file.kind === "added" || file.kind === "untracked" ? "add" : "update", status: "completed", diff: file.diff }}
          annotations={findings.map(finding => ({ id: finding.id, side: finding.side, startLine: finding.startLine, endLine: finding.endLine, label: finding.title }))}
          selectedAnnotationId={selectedFinding?.path === path ? selectedFinding.id : undefined} onAnnotationClick={onFindingSelect} />
      </div> : <p className="code-assessment-muted">{t("No readable Diff content was captured.")}</p>}
  </section>;
}
