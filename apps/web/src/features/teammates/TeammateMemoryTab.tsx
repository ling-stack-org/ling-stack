import { ArrowDown, Bot, CheckCircle2, FileText, Loader2, RefreshCw, Save, Search, Settings, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type {
  AiTeammate,
  Channel,
  MemoryHealthReport,
  MemoryMarkdownImportPlan,
  MemoryObject,
  MemoryPromotionInboxItem,
  MemoryReviewAction,
  MemoryReviewMode,
  MemoryReviewPolicy,
  TeammateMemoryScope,
} from "../../types.js";
import {
  memoryHealthFindingTitle,
  memoryHealthStatus,
  memoryOwnerLabel,
  memoryReviewModeDescription,
  truncateMemoryBody,
} from "./teammate-workspace-utils.js";

import { SelectControl } from "../../shared/components/SelectControl.js";

export interface MemoryReviewEditForm {
  readonly title: string;
  readonly body: string;
  readonly sensitivity: MemoryObject["sensitivity"];
}

export type MemoryTransferBusy = "" | "export" | "preview" | "import";

export function TeammateMemoryTab({
  teammate,
  channelsById,
  isProtectedSystemTeammate,
  loading,
  memoryScopes,
  memoryHealthReport,
  memoryPromotionInbox,
  memoryReviewPolicy,
  memoryReviewMessage,
  memoryReviewingId,
  memoryPolicySaving,
  memoryEditId,
  memoryEditForm,
  memoryTransferBusy,
  memoryExportIncludeSecretAdjacent,
  memoryImportSourceLabel,
  memoryImportContent,
  memoryImportPlan,
  onRefreshMemoryReviewData,
  onExportMemoryProjection,
  onMemoryExportIncludeSecretAdjacentChange,
  onMemoryImportSourceLabelChange,
  onLoadMemoryImportFile,
  onMemoryImportContentChange,
  onPreviewMemoryImport,
  onImportMemoryCandidates,
  onChangeMemoryReviewMode,
  onStartMemoryEdit,
  onCancelMemoryEdit,
  onMemoryEditFormChange,
  onApplyMemoryReview,
}: {
  readonly teammate: AiTeammate;
  readonly channelsById: ReadonlyMap<string, Channel>;
  readonly isProtectedSystemTeammate: boolean;
  readonly loading: boolean;
  readonly memoryScopes: readonly TeammateMemoryScope[];
  readonly memoryHealthReport: MemoryHealthReport | undefined;
  readonly memoryPromotionInbox: readonly MemoryPromotionInboxItem[];
  readonly memoryReviewPolicy: MemoryReviewPolicy | undefined;
  readonly memoryReviewMessage: string;
  readonly memoryReviewingId: string;
  readonly memoryPolicySaving: boolean;
  readonly memoryEditId: string;
  readonly memoryEditForm: MemoryReviewEditForm;
  readonly memoryTransferBusy: MemoryTransferBusy;
  readonly memoryExportIncludeSecretAdjacent: boolean;
  readonly memoryImportSourceLabel: string;
  readonly memoryImportContent: string;
  readonly memoryImportPlan: MemoryMarkdownImportPlan | undefined;
  readonly onRefreshMemoryReviewData: () => void | Promise<void>;
  readonly onExportMemoryProjection: () => void | Promise<void>;
  readonly onMemoryExportIncludeSecretAdjacentChange: (value: boolean) => void;
  readonly onMemoryImportSourceLabelChange: (value: string) => void;
  readonly onLoadMemoryImportFile: (file: File | undefined) => void | Promise<void>;
  readonly onMemoryImportContentChange: (value: string) => void;
  readonly onPreviewMemoryImport: () => void | Promise<void>;
  readonly onImportMemoryCandidates: () => void | Promise<void>;
  readonly onChangeMemoryReviewMode: (mode: MemoryReviewMode) => void | Promise<void>;
  readonly onStartMemoryEdit: (item: MemoryPromotionInboxItem) => void;
  readonly onCancelMemoryEdit: () => void;
  readonly onMemoryEditFormChange: (form: MemoryReviewEditForm | ((current: MemoryReviewEditForm) => MemoryReviewEditForm)) => void;
  readonly onApplyMemoryReview: (item: MemoryPromotionInboxItem, action: MemoryReviewAction) => void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-list-panel teammate-memory-panel" aria-label={t("Memory")}>
      <div className="panel-title split">
        <span>
          <Bot size={16} />
          <h2>{t("Memory")}</h2>
        </span>
        <small>{memoryPromotionInbox.length ? `${memoryPromotionInbox.length} ${t("Review")}` : `${memoryScopes.length}`}</small>
      </div>
      {isProtectedSystemTeammate ? (
        <div className="provider-run-notice neutral">
          <ShieldCheck size={16} />
          <span>{t("Ling Agent has protected coordinator memory. It is always on; review controls manage content, not recall availability.")}</span>
        </div>
      ) : (
        <div className="provider-run-notice neutral">
          <ShieldCheck size={16} />
          <span>{t("Memory is always on for each teammate. Review controls manage content, not recall availability.")}</span>
        </div>
      )}
      <article className="teammate-data-row">
        <span>
          <strong>{t("Vector retrieval")}</strong>
          <small>{t("Not installed / Optional")}</small>
        </span>
        <StatusBadge status="optional" />
      </article>
      <article className="teammate-memory-health-panel">
        <div className="teammate-memory-health-head">
          <span>
            <ShieldCheck size={15} />
            <strong>{t("Memory health")}</strong>
          </span>
          <StatusBadge status={memoryHealthStatus(memoryHealthReport)} />
        </div>
        <div className="teammate-memory-health-grid">
          <span>
            <strong>{memoryHealthReport?.summary.findings.critical ?? 0}</strong>
            <small>{t("Critical")}</small>
          </span>
          <span>
            <strong>{memoryHealthReport?.summary.findings.warning ?? 0}</strong>
            <small>{t("Warnings")}</small>
          </span>
          <span>
            <strong>{memoryHealthReport?.summary.reviewBacklog ?? memoryPromotionInbox.length}</strong>
            <small>{t("Review backlog")}</small>
          </span>
          <span>
            <strong>{memoryHealthReport?.summary.verifyBeforeUse ?? 0}</strong>
            <small>{t("Verify before use")}</small>
          </span>
        </div>
        {memoryHealthReport && memoryHealthReport.findings.length > 0 ? (
          <div className="teammate-memory-health-findings">
            {memoryHealthReport.findings.slice(0, 4).map((finding) => (
              <span key={finding.id} className={`teammate-memory-health-finding ${finding.severity}`}>
                <strong>{t(memoryHealthFindingTitle(finding.kind))}</strong>
                <small>{finding.memoryId ? `${finding.reviewState ?? ""} · ${finding.memoryId}` : t("Workspace")}</small>
              </span>
            ))}
          </div>
        ) : (
          <small className="teammate-memory-review-message">{t("No memory health findings")}</small>
        )}
      </article>
      <article className="teammate-memory-transfer-panel" aria-label={t("Memory export and import")}>
        <div className="teammate-memory-review-head">
          <span>
            <FileText size={15} />
            <strong>{t("Markdown transfer")}</strong>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={() => void onExportMemoryProjection()} disabled={Boolean(memoryTransferBusy)}>
            {memoryTransferBusy === "export" ? <Loader2 className="spin" size={14} /> : <ArrowDown size={14} />}
            {t("Export")}
          </button>
        </div>
        <label className="teammate-toggle inline-toggle compact">
          <input
            type="checkbox"
            checked={memoryExportIncludeSecretAdjacent}
            onChange={(event) => onMemoryExportIncludeSecretAdjacentChange(event.currentTarget.checked)}
            disabled={Boolean(memoryTransferBusy)}
          />
          <ShieldCheck size={15} />
          <span>
            <strong>{t("Include secret-adjacent exports")}</strong>
            <small>{t("Disabled by default; import still creates disabled candidates for secret-adjacent content.")}</small>
          </span>
        </label>
        <div className="teammate-memory-import-grid">
          <label className="field">
            <span>{t("Source label")}</span>
            <input value={memoryImportSourceLabel} onChange={(event) => onMemoryImportSourceLabelChange(event.currentTarget.value)} placeholder="memory-export.md" disabled={Boolean(memoryTransferBusy)} />
          </label>
          <label className="secondary-button compact-button teammate-memory-file-button">
            <Upload size={14} />
            {t("Choose Markdown")}
            <input
              type="file"
              accept=".md,text/markdown,text/plain"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void onLoadMemoryImportFile(file);
              }}
              disabled={Boolean(memoryTransferBusy)}
            />
          </label>
          <label className="field teammate-memory-import-content">
            <span>{t("Markdown")}</span>
            <textarea
              rows={6}
              value={memoryImportContent}
              onChange={(event) => onMemoryImportContentChange(event.currentTarget.value)}
              placeholder={t("Paste a Ling memory Markdown export")}
              disabled={Boolean(memoryTransferBusy)}
            />
          </label>
        </div>
        {memoryImportPlan ? (
          <div className="teammate-memory-import-preview">
            <span>
              <strong>{memoryImportPlan.candidateCount}</strong>
              <small>{t("Candidates")}</small>
            </span>
            <span>
              <strong>{memoryImportPlan.skippedCount}</strong>
              <small>{t("Skipped")}</small>
            </span>
            <span>
              <strong>{memoryImportPlan.candidates.reduce((count, candidate) => count + candidate.warnings.length, 0)}</strong>
              <small>{t("Warnings")}</small>
            </span>
          </div>
        ) : null}
        {memoryImportPlan && memoryImportPlan.candidates.some((candidate) => candidate.warnings.length > 0) ? (
          <div className="teammate-memory-import-warnings">
            {memoryImportPlan.candidates.slice(0, 3).flatMap((candidate) =>
              candidate.warnings.slice(0, 2).map((warning, index) => (
                <small key={`${candidate.index}:${index}:${warning}`} className="teammate-warning warning">
                  {candidate.title}: {warning}
                </small>
              )),
            )}
          </div>
        ) : null}
        <div className="teammate-memory-review-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => void onPreviewMemoryImport()} disabled={Boolean(memoryTransferBusy) || !memoryImportContent.trim()}>
            {memoryTransferBusy === "preview" ? <Loader2 className="spin" size={14} /> : <Search size={14} />}
            {t("Preview import")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => void onImportMemoryCandidates()} disabled={Boolean(memoryTransferBusy) || !memoryImportContent.trim()}>
            {memoryTransferBusy === "import" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
            {t("Import candidates")}
          </button>
        </div>
      </article>
      <article className="teammate-data-row teammate-memory-policy-row">
        <span>
          <strong>{t("Memory review mode")}</strong>
          <small>{t(memoryReviewModeDescription(memoryReviewPolicy?.mode ?? "balanced"))}</small>
        </span>
        <SelectControl
              variant="compact"
          aria-label={t("Memory review mode")}
          value={memoryReviewPolicy?.mode ?? "balanced"}
          onChange={(event) => void onChangeMemoryReviewMode(event.currentTarget.value as MemoryReviewMode)}
          disabled={loading || memoryPolicySaving}
        >
          <option value="conservative">{t("Conservative")}</option>
          <option value="balanced">{t("Balanced")}</option>
          <option value="fast">{t("Fast")}</option>
        </SelectControl>
      </article>
      <div className="teammate-memory-review-head">
        <span>
          <ShieldCheck size={15} />
          <strong>{t("Promotion inbox")}</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={() => void onRefreshMemoryReviewData()} disabled={loading || Boolean(memoryReviewingId)}>
          <RefreshCw size={14} />
          {t("Refresh")}
        </button>
      </div>
      {memoryReviewMessage ? <small className="teammate-memory-review-message">{memoryReviewMessage}</small> : null}
      {memoryPromotionInbox.length === 0 ? (
        <div className="client-empty-state teammate-empty compact">
          <span>{t("No memory candidates need review")}</span>
        </div>
      ) : (
        <div className="teammate-memory-review-list">
          {memoryPromotionInbox.map((item) => {
            const editing = memoryEditId === item.memory.id;
            const busy = memoryReviewingId === item.memory.id;
            return (
              <article key={item.memory.id} className="teammate-memory-review-card">
                <div className="teammate-memory-review-card-head">
                  <span>
                    <strong>{item.memory.title}</strong>
                    <small>
                      {item.memory.scopeType}:{memoryOwnerLabel(item.memory, channelsById, teammate, t)}
                    </small>
                  </span>
                  <StatusBadge status={item.memory.reviewState === "candidate" ? "pending" : item.memory.reviewState} />
                </div>
                <p>{truncateMemoryBody(item.memory.body)}</p>
                <div className="teammate-memory-review-meta">
                  <span>{t("Source")}: {item.sourceSummary}</span>
                  <span>{t("Sensitivity")}: {item.memory.sensitivity}</span>
                  <span>{t("Action")}: {item.recommendedAction}</span>
                  {item.decision ? <span>{t("Reason")}: {item.decision.reason}</span> : null}
                </div>
                {editing ? (
                  <div className="teammate-memory-edit-form">
                    <label>
                      {t("Title")}
                      <input value={memoryEditForm.title} onChange={(event) => onMemoryEditFormChange((current) => ({ ...current, title: event.currentTarget.value }))} />
                    </label>
                    <label>
                      {t("Body")}
                      <textarea value={memoryEditForm.body} rows={4} onChange={(event) => onMemoryEditFormChange((current) => ({ ...current, body: event.currentTarget.value }))} />
                    </label>
                    <label>
                      {t("Sensitivity")}
                      <SelectControl value={memoryEditForm.sensitivity} onChange={(event) => onMemoryEditFormChange((current) => ({ ...current, sensitivity: event.currentTarget.value as MemoryObject["sensitivity"] }))}>
                        <option value="normal">{t("normal")}</option>
                        <option value="private">{t("private")}</option>
                        <option value="secret-adjacent">{t("secret-adjacent")}</option>
                      </SelectControl>
                    </label>
                  </div>
                ) : null}
                <div className="teammate-memory-review-actions">
                  {editing ? (
                    <button className="primary-button compact-button" type="button" onClick={() => void onApplyMemoryReview(item, "edit_and_approve")} disabled={busy}>
                      {busy ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
                      {t("Save and approve")}
                    </button>
                  ) : (
                    <button className="primary-button compact-button" type="button" onClick={() => void onApplyMemoryReview(item, "approve")} disabled={busy}>
                      {busy ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                      {t("Approve")}
                    </button>
                  )}
                  <button className="secondary-button compact-button" type="button" onClick={() => (editing ? onCancelMemoryEdit() : onStartMemoryEdit(item))} disabled={busy}>
                    {editing ? <X size={14} /> : <Settings size={14} />}
                    {editing ? t("Cancel edit") : t("Edit")}
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => void onApplyMemoryReview(item, "keep_candidate")} disabled={busy}>
                    <RefreshCw size={14} />
                    {t("Keep candidate")}
                  </button>
                  <button className="secondary-button danger compact-button" type="button" onClick={() => void onApplyMemoryReview(item, "reject")} disabled={busy}>
                    <Trash2 size={14} />
                    {t("Reject")}
                  </button>
                  <button className="secondary-button danger compact-button" type="button" onClick={() => void onApplyMemoryReview(item, "quarantine")} disabled={busy}>
                    <ShieldCheck size={14} />
                    {t("Quarantine")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {memoryScopes.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          <Bot size={18} />
          <span>{t("Memory scopes are being prepared")}</span>
        </div>
      ) : (
        <div className="teammate-data-list">
          {memoryScopes.map((scope) => (
            <article key={scope.id} className="teammate-data-row">
              <span>
                <strong>{t(scope.kind)}</strong>
                <small>{scope.channelId ? channelsById.get(scope.channelId)?.name ?? scope.channelId : t("Private workspace")}</small>
              </span>
              <StatusBadge status="active" />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
