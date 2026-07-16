import { useMemo, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FileCheck2,
  History,
  LocateFixed,
  Play,
  RefreshCw,
  Save,
  Workflow,
} from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { ProposedPlanArtifact } from "../../../types.js";
import {
  MessageBodyRenderer,
  ToolPlaceholderPage,
} from "../../../shared/conversation/index.js";
import {
  buildPlanLineageGroups,
  visiblePlanLineageVersions,
} from "./plan-lineage.js";

import { SelectControl } from "../../../shared/components/SelectControl.js";

export type PlanStatusFilter = "current" | "all" | ProposedPlanArtifact["status"];

export interface PlanHistoryPageProps {
  readonly plans: readonly ProposedPlanArtifact[];
  readonly currentThreadId?: string;
  readonly loading: boolean;
  readonly error: string;
  readonly scope: "thread" | "channel";
  readonly statusFilter: PlanStatusFilter;
  readonly busyPlanId: string;
  readonly onScopeChange: (scope: "thread" | "channel") => void;
  readonly onStatusFilterChange: (filter: PlanStatusFilter) => void;
  readonly onOpenPlan: (plan: ProposedPlanArtifact) => void;
  readonly onOpenSource?: (plan: ProposedPlanArtifact) => void;
}

export function PlanHistoryPage({
  plans,
  currentThreadId,
  loading,
  error,
  scope,
  statusFilter,
  busyPlanId,
  onScopeChange,
  onStatusFilterChange,
  onOpenPlan,
  onOpenSource,
}: PlanHistoryPageProps): JSX.Element {
  const { t } = useI18n();
  const [agentFilter, setAgentFilter] = useState("all");
  const [goalFilter, setGoalFilter] = useState("all");
  const [expandedLineageGroups, setExpandedLineageGroups] = useState<ReadonlySet<string>>(new Set());
  const scopedPlans = useMemo(() => {
    const items = plans.filter((plan) => {
      if (scope === "thread" && currentThreadId && plan.threadId !== currentThreadId) {
        return false;
      }
      if (scope === "thread" && !currentThreadId) {
        return false;
      }
      if (statusFilter === "archived") {
        if (plan.status !== "archived") {
          return false;
        }
      } else if (plan.status === "archived") {
        return false;
      } else if (statusFilter !== "current" && statusFilter !== "all" && plan.status !== statusFilter) {
        return false;
      }
      const agentId = plan.ownerAgentId ?? plan.sourceAgentId ?? "";
      if (agentFilter !== "all" && agentId !== agentFilter) {
        return false;
      }
      if (goalFilter !== "all" && (plan.goalId ?? "") !== goalFilter) {
        return false;
      }
      return true;
    });
    return items;
  }, [agentFilter, currentThreadId, goalFilter, plans, scope, statusFilter]);
  const lineageGroups = useMemo(() => buildPlanLineageGroups(scopedPlans), [scopedPlans]);
  const agentOptions = useMemo(() => uniquePlanFilterOptions(plans, (plan) => plan.ownerAgentId ?? plan.sourceAgentId), [plans]);
  const goalOptions = useMemo(() => uniquePlanFilterOptions(plans, (plan) => plan.goalId), [plans]);

  function toggleLineageGroup(groupId: string): void {
    setExpandedLineageGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  return (
    <div className="right-dock-plans-page">
      <div className="right-dock-page-header">
        <div className="right-dock-page-header-row">
          <History size={15} />
          <span className="right-dock-page-title">
            <strong>{t("Plan history")}</strong>
            <small>{scope === "thread" ? t("This thread") : t("This channel")}</small>
          </span>
          <span className="right-dock-row-state tone-info">{scopedPlans.length}</span>
        </div>
        <div className="right-dock-page-filters">
          <div className="right-dock-filter-row" aria-label={t("Plan scope")}>
            <button className={scope === "thread" ? "right-dock-filter active" : "right-dock-filter"} type="button" onClick={() => onScopeChange("thread")}>
              {t("This thread")}
            </button>
            <button className={scope === "channel" ? "right-dock-filter active" : "right-dock-filter"} type="button" onClick={() => onScopeChange("channel")}>
              {t("This channel")}
            </button>
          </div>
          <div className="right-dock-plan-select-row">
            <label>
              <span>{t("Status")}</span>
              <SelectControl
              variant="compact" value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value as PlanStatusFilter)} aria-label={t("Plan status")}>
                <option value="current">{t("Current")}</option>
                <option value="all">{t("All")}</option>
                <option value="draft">{t("Draft")}</option>
                <option value="accepted">{t("Accepted")}</option>
                <option value="superseded">{t("Superseded")}</option>
                <option value="archived">{t("Archived")}</option>
              </SelectControl>
            </label>
            <label>
              <span>{t("Agent")}</span>
              <SelectControl
              variant="compact" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} aria-label={t("Plan agent")}>
                <option value="all">{t("All")}</option>
                {agentOptions.map((agentId) => <option key={agentId} value={agentId}>{agentId}</option>)}
              </SelectControl>
            </label>
            <label>
              <span>{t("Goal")}</span>
              <SelectControl
              variant="compact" value={goalFilter} onChange={(event) => setGoalFilter(event.target.value)} aria-label={t("Plan goal")}>
                <option value="all">{t("All")}</option>
                {goalOptions.map((goalId) => <option key={goalId} value={goalId}>{goalId}</option>)}
              </SelectControl>
            </label>
          </div>
        </div>
      </div>
      {loading ? (
        <ToolPlaceholderPage title={t("Loading plans")} description={t("Plan history is loading.")} />
      ) : error ? (
        <ToolPlaceholderPage title={t("Plan history unavailable")} description={error} />
      ) : lineageGroups.length === 0 ? (
        <ToolPlaceholderPage title={t("No plans")} description={t("Draft, accepted, superseded, and archived plans will appear here.")} />
      ) : (
        <div className="right-dock-section right-dock-plan-lineage-list">
          {lineageGroups.map((group) => {
            const expanded = expandedLineageGroups.has(group.id) || statusFilter === "superseded" || statusFilter === "archived";
            const visibleVersions = visiblePlanLineageVersions(group, expanded);
            const visibleIds = new Set(visibleVersions.map((plan) => plan.id));
            const foldedSupersededCount = group.versions.filter((plan) => plan.status === "superseded" && !visibleIds.has(plan.id)).length;
            return (
              <section key={group.id} className="right-dock-plan-lineage-group" aria-label={t("Plan lineage group")}>
                <header className="right-dock-plan-lineage-head">
                  <span className="right-dock-plan-lineage-title">
                    <strong>{group.latestPlan.title}</strong>
                    <small>{group.goalId ? t("Goal: {goal}", { goal: group.goalId }) : t("No goal")} · {group.planGroupId} · {t("{count} versions", { count: group.versionCount })}</small>
                  </span>
                  {foldedSupersededCount > 0 ? (
                    <button className="right-dock-icon-button" type="button" onClick={() => toggleLineageGroup(group.id)} aria-label={expanded ? t("Collapse versions") : t("Expand versions")} title={expanded ? t("Collapse versions") : t("Expand versions")}>
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  ) : null}
                </header>
                <div className="right-dock-plan-list">
                  {visibleVersions.map((plan) => {
                    const sourceAvailable = planSourceMessageAvailable(plan);
                    const sourceStateLabel = planSourceMessageStateLabel(plan, t);
                    return (
                      <div key={plan.id} className={busyPlanId === plan.id ? "right-dock-plan-row busy" : "right-dock-plan-row"}>
                        <button
                          className="right-dock-row right-dock-plan-main"
                          type="button"
                          onClick={() => onOpenPlan(plan)}
                          aria-label={`${t("Open plan detail")} ${plan.title}`}
                          title={t("Open plan detail")}
                        >
                          <span className={`right-dock-row-dot ${planStatusTone(plan.status)}`} />
                          <span className="right-dock-row-copy">
                            <strong>{plan.title}</strong>
                            <small>{proposedPlanSubtitle(plan, t)}</small>
                            {!sourceAvailable && plan.sourceMessageId ? (
                              <small className="right-dock-plan-source-state">{sourceStateLabel}</small>
                            ) : null}
                          </span>
                          <span className={`right-dock-row-state ${planStatusTone(plan.status)}`}>{proposedPlanStatusLabel(plan.status, t)}</span>
                        </button>
                        <button
                          className="right-dock-icon-button right-dock-plan-source-button"
                          type="button"
                          onClick={() => onOpenSource?.(plan)}
                          aria-label={sourceAvailable ? t("Open source") : sourceStateLabel}
                          title={sourceAvailable ? t("Open source") : sourceStateLabel}
                          disabled={!sourceAvailable || !onOpenSource}
                        >
                          <LocateFixed size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {foldedSupersededCount > 0 ? (
                  <button className="right-dock-plan-lineage-fold" type="button" onClick={() => toggleLineageGroup(group.id)}>
                    {expanded ? t("Hide superseded versions") : t("{count} superseded versions hidden", { count: foldedSupersededCount })}
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface PlanDetailPanelProps {
  readonly plan: ProposedPlanArtifact;
  readonly cwd?: string;
  readonly busy: boolean;
  readonly onOpenSource?: (plan: ProposedPlanArtifact) => void;
  readonly onSave?: (plan: ProposedPlanArtifact) => void;
  readonly onRefine?: (plan: ProposedPlanArtifact) => void;
  readonly onAccept?: (plan: ProposedPlanArtifact) => void;
  readonly onConvert?: (plan: ProposedPlanArtifact) => void;
  readonly onArchive?: (plan: ProposedPlanArtifact) => void;
}

export function PlanDetailPanel({
  plan,
  cwd,
  busy,
  onOpenSource,
  onSave,
  onRefine,
  onAccept,
  onConvert,
  onArchive,
}: PlanDetailPanelProps): JSX.Element {
  const { t } = useI18n();
  const archived = plan.status === "archived";
  const accepted = plan.status === "accepted";
  const sourceAvailable = planSourceMessageAvailable(plan);
  const sourceStateLabel = planSourceMessageStateLabel(plan, t);

  return (
    <article className="right-dock-plan-detail">
      <header className="right-dock-review-detail-hero">
        <span className="right-dock-review-kicker"><FileCheck2 size={14} /> {t("Proposed plan")}</span>
        <h3>{plan.title}</h3>
        <div className="right-dock-review-badges">
          <span className={`status-${plan.status}`}>{proposedPlanStatusLabel(plan.status, t)}</span>
          <span>{planVersionLabel(plan, t)}</span>
          {plan.goalId ? <span>{t("Goal")}: {plan.goalId}</span> : null}
        </div>
      </header>
      <div className="right-dock-plan-action-row">
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenSource?.(plan)} disabled={!sourceAvailable || busy}>
          <LocateFixed size={14} />
          {sourceAvailable ? t("Open source") : sourceStateLabel}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onSave?.(plan)} disabled={archived || busy}>
          <Save size={14} />
          {t("Save")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onRefine?.(plan)} disabled={archived || busy}>
          <RefreshCw size={14} />
          {t("Refine")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onConvert?.(plan)} disabled={archived || busy}>
          <Workflow size={14} />
          {t("Convert")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onAccept?.(plan)} disabled={archived || accepted || busy}>
          <Play size={14} />
          {t("Implement")}
        </button>
        <button className="secondary-button compact-button danger" type="button" onClick={() => onArchive?.(plan)} disabled={archived || busy}>
          <Archive size={14} />
          {t("Archive")}
        </button>
      </div>
      <dl className="right-dock-detail-list">
        <div>
          <dt>{t("Thread")}</dt>
          <dd>{plan.threadId}</dd>
        </div>
        {plan.sourceMessageId ? (
          <div>
            <dt>{t("Source message")}</dt>
            <dd>
              {plan.sourceMessageId}
              {!sourceAvailable ? <small className="right-dock-plan-source-state">{sourceStateLabel}</small> : null}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Updated")}</dt>
          <dd>{formatCompactPlanDate(plan.updatedAt)}</dd>
        </div>
        {plan.acceptedWorkflowId ? (
          <div>
            <dt>{t("Workflow")}</dt>
            <dd>{plan.acceptedWorkflowId}</dd>
          </div>
        ) : null}
      </dl>
      <section className="right-dock-plan-markdown" aria-label={t("Plan body")}>
        <MessageBodyRenderer text={plan.bodyMarkdown} cwd={cwd} compact />
      </section>
    </article>
  );
}

function uniquePlanFilterOptions(
  plans: readonly ProposedPlanArtifact[],
  readValue: (plan: ProposedPlanArtifact) => string | undefined,
): readonly string[] {
  return [...new Set(plans.map(readValue).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

export function proposedPlanSubtitle(plan: ProposedPlanArtifact, t: (key: string, values?: Record<string, string | number>) => string): string {
  const parts = [
    plan.goalId ? t("Goal") : plan.channelId ? t("Channel") : t("Thread"),
    plan.ownerAgentId ?? plan.sourceAgentId,
    planVersionLabel(plan, t),
    formatCompactPlanDate(plan.updatedAt),
  ].filter(Boolean);
  return parts.join(" · ");
}

function planSourceMessageAvailable(plan: ProposedPlanArtifact): boolean {
  return Boolean(plan.sourceMessageId && plan.sourceMessageState === "available");
}

function planSourceMessageStateLabel(
  plan: ProposedPlanArtifact,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (!plan.sourceMessageId) {
    return t("Source unavailable");
  }
  if (plan.sourceMessageState === "available") {
    return t("Open source");
  }
  if (plan.sourceMessageState === "deleted") {
    return t("Source message deleted");
  }
  return t("Source unavailable");
}

function proposedPlanStatusLabel(status: ProposedPlanArtifact["status"], t: (key: string) => string): string {
  switch (status) {
    case "accepted":
      return t("Accepted");
    case "superseded":
      return t("Superseded");
    case "archived":
      return t("Archived");
    case "draft":
    default:
      return t("Draft");
  }
}

function planStatusTone(status: ProposedPlanArtifact["status"]): "tone-info" | "tone-warning" | "tone-danger" | "tone-muted" {
  if (status === "accepted") {
    return "tone-info";
  }
  if (status === "superseded") {
    return "tone-warning";
  }
  if (status === "archived") {
    return "tone-muted";
  }
  return "tone-info";
}

function planVersionLabel(plan: ProposedPlanArtifact, t: (key: string, values?: Record<string, string | number>) => string): string {
  return plan.version && plan.version > 0 ? t("v{version}", { version: plan.version }) : t("v1");
}

function formatCompactPlanDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
