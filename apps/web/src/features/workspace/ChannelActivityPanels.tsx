import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  FileText,
  History,
  Info,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  buildChannelActivityTriageActions,
  buildChannelActivityTriageDraft,
  channelActivityTriageDraftIsValid,
  channelActivityTriageResultLabel,
  type ChannelActivityTriageAction,
  type ChannelActivityTriageActionKind,
  type ChannelActivityTriageDraft,
  type ChannelActivityTriageResult,
} from "../../lib/channel-activity-triage.js";
import type { ChannelActivityAttention } from "../../lib/channel-activity.js";
import type {
  ChannelActivityDrilldownItem,
  ChannelActivityDrilldownTarget,
} from "../../lib/channel-activity-drilldown.js";
import type {
  ChannelActivitySavedView,
  ChannelActivityViewAttentionFilter,
  ChannelActivityViewCategoryFilter,
} from "../../lib/channel-activity-views.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow } from "../../shared/components/index.js";

import { SelectControl } from "../../shared/components/SelectControl.js";

type ActivityCategoryFilter = ChannelActivityViewCategoryFilter;
type ActivityAttentionFilter = ChannelActivityViewAttentionFilter;

const activityCategoryFilters: readonly ActivityCategoryFilter[] = ["all", "message", "work", "approval", "protocol", "runtime"];
const activityAttentionFilters: readonly Exclude<ActivityAttentionFilter, "all">[] = ["needs_attention", "blocked", "failed", "pending"];

export function ActivityFilterToolbar({
  search,
  categoryFilter,
  attentionFilter,
  savedViews,
  activeSavedViewId,
  filtersExpanded,
  savedViewCounts,
  selectedSavedView,
  categoryCounts,
  attentionCounts,
  clearDisabled,
  customViewLimitReached,
  onSavedViewSelect,
  onSaveView,
  onRenameView,
  onDeleteView,
  onFiltersExpandedChange,
  onSearchChange,
  onCategoryFilterChange,
  onAttentionFilterChange,
  onClear,
}: {
  readonly search: string;
  readonly categoryFilter: ActivityCategoryFilter;
  readonly attentionFilter: ActivityAttentionFilter;
  readonly savedViews: readonly ChannelActivitySavedView[];
  readonly activeSavedViewId: string;
  readonly filtersExpanded: boolean;
  readonly savedViewCounts: Readonly<Record<string, number>>;
  readonly selectedSavedView: ChannelActivitySavedView | undefined;
  readonly categoryCounts: Readonly<Record<ActivityCategoryFilter, number>>;
  readonly attentionCounts: Readonly<Record<Exclude<ActivityAttentionFilter, "all">, number>>;
  readonly clearDisabled: boolean;
  readonly customViewLimitReached: boolean;
  readonly onSavedViewSelect: (view: ChannelActivitySavedView) => void;
  readonly onSaveView: () => void;
  readonly onRenameView: () => void;
  readonly onDeleteView: () => void;
  readonly onFiltersExpandedChange: (expanded: boolean) => void;
  readonly onSearchChange: (value: string) => void;
  readonly onCategoryFilterChange: (filter: ActivityCategoryFilter) => void;
  readonly onAttentionFilterChange: (filter: ActivityAttentionFilter) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const selectedCustomView = selectedSavedView && !selectedSavedView.builtin;
  const filterSummaryParts = [
    categoryFilter !== "all" ? t(activityCategoryFilterLabel(categoryFilter)) : "",
    attentionFilter !== "all" ? t(activityAttentionFilterLabel(attentionFilter)) : "",
  ].filter(Boolean);
  const filterSummary = filterSummaryParts.length > 0 ? filterSummaryParts.join(" · ") : t("All activity");
  return (
    <div className="activity-filter-toolbar" aria-label={t("Channel event filters")}>
      <div className="activity-view-control" aria-label={t("Saved views")}>
        <label className="activity-view-select">
          <span>{t("View")}</span>
          <SelectControl
              variant="compact"
            aria-label={t("Saved views")}
            value={activeSavedViewId}
            onChange={(event) => {
              const view = savedViews.find((candidate) => candidate.id === event.target.value);
              if (view) {
                onSavedViewSelect(view);
              }
            }}
          >
            {savedViews.map((view) => (
              <option key={view.id} value={view.id}>
                {savedViewLabel(view, t)} ({savedViewCounts[view.id] ?? 0})
              </option>
            ))}
          </SelectControl>
        </label>
      </div>
      <label className="activity-search-field">
        <Search size={14} />
        <input
          aria-label={t("Search activity")}
          placeholder={t("Search activity")}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
      <button
        className={filtersExpanded ? "activity-filter-toggle active" : "activity-filter-toggle"}
        type="button"
        aria-expanded={filtersExpanded}
        aria-label={t("Filter channel events")}
        onClick={() => onFiltersExpandedChange(!filtersExpanded)}
      >
        <SlidersHorizontal size={14} />
        <span>{t("Filters")}</span>
        <small>{filterSummary}</small>
      </button>
      <button className="secondary-button compact-button activity-clear-filter" type="button" onClick={onClear} disabled={clearDisabled}>
        <X size={13} />
        {t("Clear")}
      </button>
      {filtersExpanded ? (
        <div className="activity-filter-panel" aria-label={t("Channel event filters")}>
          <div className="activity-saved-view-actions" aria-label={t("Saved view actions")}>
            <button className="secondary-button compact-button" type="button" onClick={onSaveView} disabled={customViewLimitReached}>
              <Plus size={13} />
              {t("Save view")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onRenameView} disabled={!selectedCustomView}>
              <FileText size={13} />
              {t("Rename")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onDeleteView} disabled={!selectedCustomView}>
              <Trash2 size={13} />
              {t("Delete view")}
            </button>
          </div>
          <div className="activity-filter-group activity-category-filters" aria-label={t("Activity categories")}>
            {activityCategoryFilters.map((filter) => (
              <button
                key={filter}
                type="button"
                className={categoryFilter === filter ? "activity-filter-chip active" : "activity-filter-chip"}
                aria-pressed={categoryFilter === filter}
                onClick={() => onCategoryFilterChange(filter)}
              >
                <span>{t(activityCategoryFilterLabel(filter))}</span>
                <small>{categoryCounts[filter]}</small>
              </button>
            ))}
          </div>
          <div className="activity-filter-group activity-attention-filters" aria-label={t("Activity attention filters")}>
            {activityAttentionFilters.map((filter) => (
              <button
                key={filter}
                type="button"
                className={attentionFilter === filter ? "activity-filter-chip active attention" : "activity-filter-chip attention"}
                aria-pressed={attentionFilter === filter}
                onClick={() => onAttentionFilterChange(attentionFilter === filter ? "all" : filter)}
              >
                <span>{t(activityAttentionFilterLabel(filter))}</span>
                <small>{attentionCounts[filter]}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ActivityDrilldownDrawer({
  drilldown,
  defaultTeammateId,
  activeDecisionIds,
  onClose,
  onOpenTarget,
  onRunTriageAction,
  onOpenTriageResult,
}: {
  readonly drilldown: ChannelActivityDrilldownItem;
  readonly defaultTeammateId?: string;
  readonly activeDecisionIds: readonly string[];
  readonly onClose: () => void;
  readonly onOpenTarget: (target: ChannelActivityDrilldownTarget) => void;
  readonly onRunTriageAction: (draft: ChannelActivityTriageDraft) => Promise<ChannelActivityTriageResult>;
  readonly onOpenTriageResult: (result: ChannelActivityTriageResult) => void;
}): JSX.Element {
  const { t } = useI18n();
  const triageActions = useMemo(() => buildChannelActivityTriageActions(drilldown), [drilldown]);
  const [selectedTriageActionId, setSelectedTriageActionId] = useState<ChannelActivityTriageActionKind | "">("");
  const [triageDraft, setTriageDraft] = useState<ChannelActivityTriageDraft | undefined>();
  const [triagePending, setTriagePending] = useState(false);
  const [triageError, setTriageError] = useState("");
  const [triageResult, setTriageResult] = useState<ChannelActivityTriageResult | undefined>();
  const selectedTriageAction = triageActions.find((action) => action.id === selectedTriageActionId);

  useEffect(() => {
    setSelectedTriageActionId("");
    setTriageDraft(undefined);
    setTriagePending(false);
    setTriageError("");
    setTriageResult(undefined);
  }, [drilldown.id]);

  function selectTriageAction(action: ChannelActivityTriageAction): void {
    setSelectedTriageActionId(action.id);
    setTriageDraft(buildChannelActivityTriageDraft({
      drilldown,
      actionKind: action.id,
      defaultTeammateId,
      activeDecisionIds,
    }));
    setTriageError("");
    setTriageResult(undefined);
  }

  function updateTriageDraft(field: string, value: string): void {
    setTriageDraft((current) => current ? { ...current, [field]: value } as ChannelActivityTriageDraft : current);
  }

  async function submitTriageAction(): Promise<void> {
    if (!triageDraft || !channelActivityTriageDraftIsValid(triageDraft)) {
      return;
    }
    setTriagePending(true);
    setTriageError("");
    try {
      const result = await onRunTriageAction(triageDraft);
      setTriageResult(result);
    } catch (error) {
      setTriageError(error instanceof Error ? error.message : String(error));
    } finally {
      setTriagePending(false);
    }
  }

  return (
    <aside className="activity-drilldown-drawer" aria-label={t("Activity details")}>
      <div className="activity-drilldown-header">
        <span>
          <Info size={16} />
          <strong>{t("Activity details")}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close details")}>
          <X size={15} />
        </button>
      </div>
      <div className="activity-drilldown-title">
        <small>{t(activityKindLabel(drilldown.kind))}</small>
        <h3>{t(drilldown.source.title)}</h3>
        <p>{t(drilldown.source.subtitle)}</p>
      </div>
      <section className="activity-drilldown-section">
        <h4>{t("Source summary")}</h4>
        <p>{drilldown.source.summary}</p>
      </section>
      <section className="activity-drilldown-section">
        <h4>{t("Actions")}</h4>
        {drilldown.targets.length === 0 ? (
          <p className="muted-text">{t("No direct target")}</p>
        ) : (
          <div className="activity-drilldown-actions">
            {drilldown.targets.map((target, index) => (
              <button
                key={`${target.kind}:${index}`}
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOpenTarget(target)}
              >
                {drilldownTargetIcon(target)}
                {t(drilldownTargetLabel(target))}
              </button>
            ))}
          </div>
        )}
      </section>
      <details className="activity-drilldown-disclosure">
        <summary>
          <span>{t("Source metadata")}</span>
        </summary>
        <div className="activity-drilldown-badges" aria-label={t("Activity detail metadata")}>
          <span>{t("Category")}: {t(activityCategoryFilterLabel(drilldown.category))}</span>
          <span>{t("Attention")}: {t(activityAttentionLabel(drilldown.attention))}</span>
          <span>{t("Time")}: {formatDateTime(drilldown.createdAt)}</span>
          {drilldown.source.status ? <span>{t("Status")}: {drilldown.source.status}</span> : null}
        </div>
        <div className="activity-drilldown-field-grid">
          <MetaRow label={t("Source ID")} value={drilldown.source.sourceId} />
          <MetaRow label={t("Event type")} value={t(activityKindLabel(drilldown.kind))} />
          {drilldown.source.metadata.map((field) => (
            <MetaRow key={`${field.label}:${field.value}`} label={t(field.label)} value={field.value} />
          ))}
        </div>
      </details>
      <details className="activity-drilldown-disclosure">
        <summary>
          <span>{t("Related objects")}</span>
        </summary>
        {drilldown.source.relatedObjects.length === 0 ? (
          <p className="muted-text">{t("No related objects")}</p>
        ) : (
          <div className="activity-drilldown-related">
            {drilldown.source.relatedObjects.map((field) => (
              <span key={`${field.label}:${field.value}`}>
                <small>{t(field.label)}</small>
                {field.value}
              </span>
            ))}
          </div>
        )}
      </details>
      <details className="activity-drilldown-disclosure activity-triage-section" aria-label={t("Triage actions")}>
        <summary>
          <span>{t("Triage actions")}</span>
          {triageActions.length > 0 ? <small>{triageActions.length}</small> : null}
        </summary>
        {triageActions.length === 0 ? (
          <p className="muted-text">{t("No triage actions available")}</p>
        ) : (
          <>
            <div className="activity-triage-action-picker" role="tablist" aria-label={t("Triage action picker")}>
              {triageActions.map((action) => (
                <button
                  key={action.id}
                  className={selectedTriageActionId === action.id ? "active" : ""}
                  type="button"
                  onClick={() => selectTriageAction(action)}
                >
                  {triageActionIcon(action.id)}
                  <span>{t(action.label)}</span>
                </button>
              ))}
            </div>
            {selectedTriageAction ? (
              <p className="activity-triage-description">{t(selectedTriageAction.description)}</p>
            ) : (
              <p className="activity-triage-description">{t("Choose a triage action to continue.")}</p>
            )}
            {triageDraft ? (
              <ActivityTriageDraftForm
                draft={triageDraft}
                disabled={triagePending}
                onChange={updateTriageDraft}
              />
            ) : null}
            {triageError ? (
              <div className="activity-triage-error" role="alert">
                <CircleAlert size={14} />
                <span>{t("Triage action failed")}: {triageError}</span>
                <button className="secondary-button compact-button" type="button" onClick={() => void submitTriageAction()}>
                  {t("Retry")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => setTriageError("")}>
                  {t("Dismiss")}
                </button>
              </div>
            ) : null}
            {triageResult ? (
              <div className="activity-triage-result" role="status">
                <CheckCircle2 size={14} />
                <span>{t("Triage action created")}: {channelActivityTriageResultLabel(triageResult)}</span>
                <button className="secondary-button compact-button" type="button" onClick={() => onOpenTriageResult(triageResult)}>
                  {t(activityTriageResultTargetLabel(triageResult))}
                </button>
              </div>
            ) : null}
            {triageDraft ? (
              <button
                className="primary-button compact-button activity-triage-submit"
                type="button"
                onClick={() => void submitTriageAction()}
                disabled={triagePending || !channelActivityTriageDraftIsValid(triageDraft)}
              >
                {triagePending ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                {triagePending ? t("Creating...") : t("Run triage action")}
              </button>
            ) : null}
          </>
        )}
      </details>
    </aside>
  );
}

function ActivityTriageDraftForm({
  draft,
  disabled,
  onChange,
}: {
  readonly draft: ChannelActivityTriageDraft;
  readonly disabled: boolean;
  readonly onChange: (field: string, value: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (draft.actionKind === "follow_up_task") {
    return (
      <div className="activity-triage-form">
        <label className="field wide">
          <span>{t("Triage title")}</span>
          <input value={draft.title} disabled={disabled} onChange={(event) => onChange("title", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Triage prompt")}</span>
          <textarea rows={5} value={draft.prompt} disabled={disabled} onChange={(event) => onChange("prompt", event.target.value)} />
        </label>
      </div>
    );
  }
  if (draft.actionKind === "handoff") {
    return (
      <div className="activity-triage-form">
        <label className="field wide">
          <span>{t("Reason")}</span>
          <input value={draft.reason} disabled={disabled} onChange={(event) => onChange("reason", event.target.value)} />
        </label>
        <div className="activity-triage-two-up">
          <label className="field">
            <span>{t("To participant")}</span>
            <input value={draft.toParticipantId} disabled={disabled} onChange={(event) => onChange("toParticipantId", event.target.value)} />
          </label>
          <label className="field">
            <span>{t("Participant label")}</span>
            <input value={draft.toParticipantLabel} disabled={disabled} onChange={(event) => onChange("toParticipantLabel", event.target.value)} />
          </label>
        </div>
        <label className="field wide">
          <span>{t("Required input")}</span>
          <textarea rows={5} value={draft.requiredInput} disabled={disabled} onChange={(event) => onChange("requiredInput", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Expected output")}</span>
          <textarea rows={3} value={draft.expectedOutput} disabled={disabled} onChange={(event) => onChange("expectedOutput", event.target.value)} />
        </label>
      </div>
    );
  }
  if (draft.actionKind === "decision") {
    return (
      <div className="activity-triage-form">
        <label className="field wide">
          <span>{t("Triage title")}</span>
          <input value={draft.title} disabled={disabled} onChange={(event) => onChange("title", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Decision text")}</span>
          <textarea rows={4} value={draft.decision} disabled={disabled} onChange={(event) => onChange("decision", event.target.value)} />
        </label>
        <label className="field wide">
          <span>{t("Rationale")}</span>
          <textarea rows={3} value={draft.rationale} disabled={disabled} onChange={(event) => onChange("rationale", event.target.value)} />
        </label>
      </div>
    );
  }
  return (
    <div className="activity-triage-form">
      <label className="field wide">
        <span>{t("Summary")}</span>
        <textarea rows={5} value={draft.summary} disabled={disabled} onChange={(event) => onChange("summary", event.target.value)} />
      </label>
      <label className="field wide">
        <span>{t("Acceptance criteria")}</span>
        <textarea rows={3} value={draft.acceptanceCriteria} disabled={disabled} onChange={(event) => onChange("acceptanceCriteria", event.target.value)} />
      </label>
      <label className="field wide">
        <span>{t("Open questions")}</span>
        <textarea rows={3} value={draft.openQuestions} disabled={disabled} onChange={(event) => onChange("openQuestions", event.target.value)} />
      </label>
    </div>
  );
}

function activityAttentionDisplayLabel(attention: Exclude<ChannelActivityAttention, "none">): string {
  if (attention === "blocked") {
    return "Blocked";
  }
  if (attention === "failed") {
    return "Failed";
  }
  return "Pending";
}

function activityKindLabel(kind: ChannelActivityDrilldownItem["kind"]): string {
  if (kind === "message") {
    return "Message";
  }
  if (kind === "decision") {
    return "Decision log";
  }
  if (kind === "handoff") {
    return "Handoff";
  }
  if (kind === "summary") {
    return "Context summary";
  }
  if (kind === "workflow") {
    return "Workflow";
  }
  if (kind === "workflow-step") {
    return "Workflow step";
  }
  if (kind === "task") {
    return "Task event";
  }
  if (kind === "run") {
    return "Run event";
  }
  if (kind === "approval") {
    return "Approval event";
  }
  return "State change";
}

function activityAttentionLabel(attention: ChannelActivityAttention): string {
  if (attention === "none") {
    return "None";
  }
  return activityAttentionDisplayLabel(attention);
}

function drilldownTargetLabel(target: ChannelActivityDrilldownTarget): string {
  if (target.kind === "task") {
    return "Show task in transcript";
  }
  if (target.kind === "run") {
    return "Show run in transcript";
  }
  if (target.kind === "approval") {
    return "Open approval";
  }
  return "Review source";
}

function drilldownTargetIcon(target: ChannelActivityDrilldownTarget): JSX.Element {
  if (target.kind === "task") {
    return <SquareTerminal size={14} />;
  }
  if (target.kind === "run") {
    return <History size={14} />;
  }
  if (target.kind === "approval") {
    return <CheckCircle2 size={14} />;
  }
  return <Workflow size={14} />;
}

function triageActionIcon(action: ChannelActivityTriageActionKind): JSX.Element {
  if (action === "follow_up_task") {
    return <SquareTerminal size={14} />;
  }
  if (action === "handoff") {
    return <Workflow size={14} />;
  }
  if (action === "decision") {
    return <FileCheck2 size={14} />;
  }
  return <FileText size={14} />;
}

function activityTriageResultTargetLabel(result: ChannelActivityTriageResult): string {
  return result.kind === "task" ? "Show created task in transcript" : "Review created source";
}

function activityCategoryFilterLabel(filter: ActivityCategoryFilter): string {
  if (filter === "message") {
    return "Messages";
  }
  if (filter === "work") {
    return "Work";
  }
  if (filter === "approval") {
    return "Approvals";
  }
  if (filter === "protocol") {
    return "Protocol";
  }
  if (filter === "runtime") {
    return "Runtime";
  }
  return "All";
}

function activityAttentionFilterLabel(filter: ActivityAttentionFilter): string {
  if (filter === "all") {
    return "All";
  }
  if (filter === "needs_attention") {
    return "Needs attention";
  }
  if (filter === "blocked") {
    return "Blocked";
  }
  if (filter === "failed") {
    return "Failed";
  }
  return "Pending";
}

function savedViewLabel(view: ChannelActivitySavedView, t: (key: string) => string): string {
  return view.builtin ? t(view.name) : view.name;
}
