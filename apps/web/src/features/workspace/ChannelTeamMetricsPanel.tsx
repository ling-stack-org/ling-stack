import type { ChannelTeamMetricsProjection } from "@ling-stack/contracts";

export interface ChannelTeamMetricsPanelProps {
  readonly metrics: ChannelTeamMetricsProjection;
  readonly labels?: Partial<{
    readonly title: string;
    readonly evidence: string;
    readonly current: string;
    readonly total: string;
    readonly active: string;
    readonly delayed: string;
    readonly unavailable: string;
    readonly riskReview: string;
    readonly risk: string;
    readonly warnings: string;
    readonly failed: string;
    readonly critical: string;
    readonly learningQueue: string;
    readonly recommendation: string;
    readonly accepted: string;
    readonly rejected: string;
    readonly pending: string;
    readonly agentActivity: string;
  }>;
}

export function ChannelTeamMetricsPanel({ metrics, labels = {} }: ChannelTeamMetricsPanelProps) {
  const text = {
    title: labels.title ?? "Team metrics",
    evidence: labels.evidence ?? "Evidence",
    current: labels.current ?? "Current",
    total: labels.total ?? "Total",
    active: labels.active ?? "Active",
    delayed: labels.delayed ?? "Delayed",
    unavailable: labels.unavailable ?? "Unavailable",
    riskReview: labels.riskReview ?? "Risk review",
    risk: labels.risk ?? "Risk",
    warnings: labels.warnings ?? "Warnings",
    failed: labels.failed ?? "Failed",
    critical: labels.critical ?? "Critical",
    learningQueue: labels.learningQueue ?? "Learning queue",
    recommendation: labels.recommendation ?? "Recommendation",
    accepted: labels.accepted ?? "Accepted",
    rejected: labels.rejected ?? "Rejected",
    pending: labels.pending ?? "Pending",
    agentActivity: labels.agentActivity ?? "Agent activity",
  };
  const visibleEvidenceCount = metrics.visibleEvidence?.totalCount ?? metrics.summary.totalEvidenceCount;

  return (
    <section
      className="channel-settings-card channel-team-metrics-panel"
      aria-label={text.title}
      data-health-state={metrics.summary.healthState}
    >
      <div className="channel-settings-section-head">
        <strong>{text.title}</strong>
      </div>

      <div className="channel-team-metrics-grid">
        <MetricTile
          label={text.evidence}
          value={visibleEvidenceCount}
          secondary={metrics.visibleEvidence ? { label: text.total, value: metrics.summary.totalEvidenceCount } : undefined}
        />
        <MetricTile label={text.active} value={metrics.summary.activeEvidenceCount} />
        <MetricTile label={text.delayed} value={metrics.summary.delayedEvidenceCount} />
        <MetricTile label={text.unavailable} value={metrics.summary.unavailableEvidenceCount} />
      </div>

      <div className="channel-team-metrics-breakdowns">
        <MetricBreakdown
          title={text.riskReview}
          items={[
            { label: text.risk, value: metrics.riskReview.riskSignalCount },
            { label: text.warnings, value: metrics.riskReview.dissentSignalCount },
            { label: text.failed, value: metrics.riskReview.openReliabilityIncidentCount },
            { label: text.critical, value: metrics.riskReview.openCriticalReliabilityIncidentCount },
          ]}
        />
        <MetricBreakdown
          title={text.learningQueue}
          items={[
            { label: text.recommendation, value: metrics.learningQueue.recommendationEvidenceCount },
            { label: text.accepted, value: metrics.learningQueue.adoptedEvidenceCount },
            { label: text.rejected, value: metrics.learningQueue.rejectedEvidenceCount },
            { label: text.pending, value: metrics.learningQueue.provisionalRuleCount },
          ]}
        />
      </div>

      <div className="channel-team-metrics-agents" aria-label={text.agentActivity}>
        <div className="channel-team-metrics-group-head">
          <strong>{text.agentActivity}</strong>
          <strong>{metrics.agents.length}</strong>
        </div>
        {metrics.agents.length > 0 ? (
          metrics.agents.map((agent) => (
            <div className="channel-team-metrics-agent-row" key={agent.agentId}>
              <div>
                <strong>{agent.agentId}</strong>
                {agent.latestSummary ? <span>{agent.latestSummary}</span> : null}
              </div>
              <span className="channel-team-metrics-agent-evidence">
                <strong>{agent.evidenceCount}</strong>
                <span>{text.evidence}</span>
              </span>
            </div>
          ))
        ) : null}
      </div>
    </section>
  );
}

function MetricTile({
  label,
  value,
  secondary,
}: {
  readonly label: string;
  readonly value: number;
  readonly secondary?: { readonly label: string; readonly value: number };
}) {
  return (
    <div className="channel-team-metrics-tile">
      <span>{label}</span>
      <div className="channel-team-metrics-tile-values">
        <strong>{value}</strong>
        {secondary ? (
          <span className="channel-team-metrics-secondary-value">
            <span>{secondary.label}</span>
            <strong>{secondary.value}</strong>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MetricBreakdown({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly { readonly label: string; readonly value: number }[];
}) {
  return (
    <section className="channel-team-metrics-breakdown" aria-label={title}>
      <div className="channel-team-metrics-group-head">
        <strong>{title}</strong>
      </div>
      <dl>
        {items.map((item) => (
          <div className="channel-team-metrics-stat" key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
