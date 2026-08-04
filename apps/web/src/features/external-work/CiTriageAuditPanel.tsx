import {
  CircleAlert,
  ExternalLink,
  FileWarning,
  GitPullRequest,
  History,
  Loader2,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { ArtifactRow } from "../../shared/components/index.js";
import type { ExternalWorkCiTriageView } from "../../types.js";

export function CiTriageAuditPanel({
  records,
  loading = false,
  compact = false,
  showEmpty = false,
  maxRecords,
  cwd,
  onRefresh,
  onSelectTask,
  onOpenRun,
}: {
  readonly records: readonly ExternalWorkCiTriageView[];
  readonly loading?: boolean;
  readonly compact?: boolean;
  readonly showEmpty?: boolean;
  readonly maxRecords?: number;
  readonly cwd?: string;
  readonly onRefresh?: () => void;
  readonly onSelectTask?: (taskId: string) => void;
  readonly onOpenRun?: (runId: string) => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const visibleRecords = maxRecords ? records.slice(0, maxRecords) : records;
  const hiddenCount = maxRecords && records.length > maxRecords ? records.length - maxRecords : 0;

  if (!loading && records.length === 0 && !showEmpty) {
    return null;
  }

  return (
    <section className={compact ? "ci-triage-panel compact" : "ci-triage-panel"} aria-label={t("CI triage")}>
      <div className="ci-triage-head">
        <span>
          <GitPullRequest size={15} />
          <strong>{t("GitHub CI triage")}</strong>
        </span>
        <span className="ci-triage-head-actions">
          <small>{t("{count} records", { count: records.length })}</small>
          {onRefresh ? (
            <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label={t("Check CI status")}>
              {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            </button>
          ) : null}
        </span>
      </div>

      {loading && records.length === 0 ? (
        <div className="ci-triage-empty">
          <Loader2 className="spin" size={15} />
          <span>{t("Loading CI triage...")}</span>
        </div>
      ) : visibleRecords.length === 0 ? (
        <div className="ci-triage-empty">
          <FileWarning size={15} />
          <span>{t("No CI triage records")}</span>
        </div>
      ) : (
        <div className="ci-triage-list">
          {visibleRecords.map((record) => (
            <CiTriageAuditRow
              key={record.triage.id}
              record={record}
              compact={compact}
              cwd={cwd}
              onSelectTask={onSelectTask}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      )}

      {hiddenCount > 0 ? <small className="ci-triage-more">{t("+{count} more CI triage records", { count: hiddenCount })}</small> : null}
    </section>
  );
}

function CiTriageAuditRow({
  record,
  compact,
  cwd,
  onSelectTask,
  onOpenRun,
}: {
  readonly record: ExternalWorkCiTriageView;
  readonly compact: boolean;
  readonly cwd?: string;
  readonly onSelectTask?: (taskId: string) => void;
  readonly onOpenRun?: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const triage = record.triage;
  const taskId = triage.taskId ?? record.task?.id;
  const runId = triage.runId ?? record.run?.id;
  const workflowLabel = [triage.workflowName, triage.jobName].filter(Boolean).join(" / ");
  const errorMessage = triage.lastErrorMessage ?? triage.failure.logErrorMessage;

  return (
    <article className={compact ? "ci-triage-row compact" : "ci-triage-row"}>
      <div className="ci-triage-row-head">
        <span>
          <FileWarning size={14} />
          <strong>{triage.checkName}</strong>
        </span>
        <span className={`ci-triage-status ${triage.status}`}>{t(triage.status)}</span>
      </div>

      <div className="ci-triage-meta">
        <span>{triage.repository}</span>
        <span>{t("PR #{number}", { number: triage.subjectNumber })}</span>
        <span>{t("head {sha}", { sha: shortSha(triage.headSha) })}</span>
        <span>{t("conclusion {conclusion}", { conclusion: triage.conclusion })}</span>
        {workflowLabel ? <span>{workflowLabel}</span> : null}
        <time>{formatDateTime(triage.updatedAt)}</time>
      </div>

      <div className="ci-triage-failure-grid">
        {triage.firstFailingCommand ? <CiTriageField icon={<SquareTerminal size={13} />} label={t("First failing command")} value={triage.firstFailingCommand} code /> : null}
        {triage.reproductionCommand ? <CiTriageField icon={<SquareTerminal size={13} />} label={t("Reproduction command")} value={triage.reproductionCommand} code /> : null}
        {triage.suspectedSourcePath ? <CiTriageField icon={<FileWarning size={13} />} label={t("Suspected source")} value={triage.suspectedSourcePath} code /> : null}
        {errorMessage ? <CiTriageField icon={<CircleAlert size={13} />} label={t("Last error")} value={errorMessage} /> : null}
      </div>

      <div className="ci-triage-actions">
        {triage.htmlUrl ? (
          <a className="secondary-button compact-button" href={triage.htmlUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={13} />
            {t("Open target")}
          </a>
        ) : null}
        {taskId && onSelectTask ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onSelectTask(taskId)}>
            <SquareTerminal size={13} />
            {t("Open task")}
          </button>
        ) : taskId ? (
          <code>{taskId}</code>
        ) : null}
        {runId && onOpenRun ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(runId)}>
            <History size={13} />
            {t("Open run")}
          </button>
        ) : runId ? (
          <code>{runId}</code>
        ) : null}
      </div>

      {record.artifacts.length > 0 ? (
        <div className="ci-triage-artifacts" aria-label={t("CI triage artifacts")}>
          {record.artifacts.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} cwd={cwd} />)}
        </div>
      ) : null}
    </article>
  );
}

function CiTriageField({
  icon,
  label,
  value,
  code = false,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}): JSX.Element {
  return (
    <div className="ci-triage-field">
      <span>
        {icon}
        {label}
      </span>
      {code ? <code>{value}</code> : <p>{value}</p>}
    </div>
  );
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
