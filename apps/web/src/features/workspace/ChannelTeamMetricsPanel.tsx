import type { ChannelTeamMetricsProjection } from "@ling-stack/contracts";

export interface ChannelTeamMetricsPanelProps {
  readonly metrics: ChannelTeamMetricsProjection;
  readonly labels?: Partial<{
    readonly title: string;
    readonly subtitle: string;
    readonly health: string;
    readonly active: string;
    readonly delayed: string;
    readonly unavailable: string;
    readonly riskReview: string;
    readonly learningQueue: string;
    readonly agentActivity: string;
    readonly noAgentActivity: string;
  }>;
}

export function ChannelTeamMetricsPanel({ metrics, labels = {} }: ChannelTeamMetricsPanelProps) {
  const text = {
    title: labels.title ?? "Team metrics",
    subtitle: labels.subtitle ?? "Read-only health and evidence summary",
    health: labels.health ?? "Health",
    active: labels.active ?? "Active",
    delayed: labels.delayed ?? "Delayed",
    unavailable: labels.unavailable ?? "Unavailable",
    riskReview: labels.riskReview ?? "Risk review",
    learningQueue: labels.learningQueue ?? "Learning queue",
    agentActivity: labels.agentActivity ?? "Agent activity",
    noAgentActivity: labels.noAgentActivity ?? "No agent evidence yet",
  };
  return (
    <section className="channel-settings-card channel-team-metrics-panel" aria-label={text.title}>
      <div className="channel-settings-section-head">
        <div>
          <strong>{text.title}</strong>
          <small>{text.subtitle}</small>
        </div>
        <span className={`channel-team-metrics-health state-${metrics.summary.healthState}`}>
          {metrics.summary.healthState.replaceAll("_", " ")}
        </span>
      </div>

      <div className="channel-team-metrics-grid">
        <MetricTile label={text.health} value={metrics.summary.totalEvidenceCount} detail="evidence" />
        <MetricTile label={text.active} value={metrics.summary.activeEvidenceCount} detail="pending" />
        <MetricTile label={text.delayed} value={metrics.summary.delayedEvidenceCount} detail="late" />
        <MetricTile label={text.unavailable} value={metrics.summary.unavailableEvidenceCount} detail="blocked" />
      </div>

      <div className="channel-team-metrics-split">
        <article>
          <h4>{text.riskReview}</h4>
          <p>{metrics.riskReview.riskSignalCount} risk signals · {metrics.riskReview.dissentSignalCount} dissent signals</p>
          <small>{metrics.riskReview.openReliabilityIncidentCount} open reliability incidents</small>
        </article>
        <article>
          <h4>{text.learningQueue}</h4>
          <p>{metrics.learningQueue.recommendationEvidenceCount} recommendations · {metrics.learningQueue.adoptedEvidenceCount} adopted</p>
          <small>{metrics.learningQueue.note}</small>
        </article>
      </div>

      <div className="channel-team-metrics-agents">
        <h4>{text.agentActivity}</h4>
        {metrics.agents.length > 0 ? (
          metrics.agents.map((agent) => (
            <div className="channel-team-metrics-agent-row" key={agent.agentId}>
              <div>
                <strong>{agent.agentId}</strong>
                <small>{agent.latestSummary ?? "No recent summary"}</small>
              </div>
              <span>{agent.evidenceCount} evidence</span>
            </div>
          ))
        ) : (
          <p>{text.noAgentActivity}</p>
        )}
      </div>
    </section>
  );
}

function MetricTile({ label, value, detail }: { readonly label: string; readonly value: number; readonly detail: string }) {
  return (
    <div className="channel-team-metrics-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
