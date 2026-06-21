import type {
  AiCouncil,
  AiCouncilHealthFinding,
  AiCouncilHealthReport,
  AiCouncilHealthSeverity,
} from "./workspace-types.js";

export type AiCouncilHealthState = "unknown" | "clear" | AiCouncilHealthSeverity;

export interface AiCouncilHealthCounts {
  readonly info: number;
  readonly warning: number;
  readonly critical: number;
}

export interface AiCouncilHealthBadgeView {
  readonly state: "clear" | AiCouncilHealthSeverity;
  readonly count: number;
}

export interface AiCouncilHealthView {
  readonly councilId: string;
  readonly state: AiCouncilHealthState;
  readonly needsAttention: boolean;
  readonly totalFindings: number;
  readonly counts: AiCouncilHealthCounts;
  readonly badges: readonly AiCouncilHealthBadgeView[];
  readonly findings: readonly AiCouncilHealthFinding[];
}

export interface AiCouncilHealthOverviewView {
  readonly total: number;
  readonly needsAttention: number;
  readonly healthy: number;
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export function listAiCouncilHealthFindings(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
): readonly AiCouncilHealthFinding[] {
  return report?.findings.filter((finding) => finding.councilId === councilId) ?? [];
}

export function countAiCouncilHealthFindings(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
): AiCouncilHealthCounts {
  return countHealthFindingsBySeverity(listAiCouncilHealthFindings(report, councilId));
}

export function buildAiCouncilHealthView(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
): AiCouncilHealthView {
  const findings = listAiCouncilHealthFindings(report, councilId);
  const counts = countHealthFindingsBySeverity(findings);
  const totalFindings = counts.critical + counts.warning + counts.info;
  const state = report ? topAiCouncilHealthState(counts) : "unknown";
  const badges = report
    ? buildAiCouncilHealthBadges(counts)
    : [];

  return {
    councilId,
    state,
    needsAttention: totalFindings > 0,
    totalFindings,
    counts,
    badges,
    findings,
  };
}

export function buildAiCouncilHealthOverviewView(
  councils: readonly AiCouncil[],
  report: AiCouncilHealthReport | undefined,
): AiCouncilHealthOverviewView {
  return councils.reduce<AiCouncilHealthOverviewView>(
    (overview, council) => {
      const view = buildAiCouncilHealthView(report, council.id);
      return {
        total: overview.total + 1,
        needsAttention: overview.needsAttention + (view.needsAttention ? 1 : 0),
        healthy: overview.healthy + (view.state === "clear" ? 1 : 0),
        critical: overview.critical + view.counts.critical,
        warning: overview.warning + view.counts.warning,
        info: overview.info + view.counts.info,
      };
    },
    { total: 0, needsAttention: 0, healthy: 0, critical: 0, warning: 0, info: 0 },
  );
}

export function aiCouncilHealthViewMatchesState(
  view: AiCouncilHealthView,
  state: "needs_attention" | "clear" | AiCouncilHealthSeverity,
): boolean {
  if (state === "needs_attention") {
    return view.needsAttention;
  }
  if (state === "clear") {
    return view.state === "clear";
  }
  return view.counts[state] > 0;
}

function buildAiCouncilHealthBadges(counts: AiCouncilHealthCounts): readonly AiCouncilHealthBadgeView[] {
  if (counts.critical === 0 && counts.warning === 0 && counts.info === 0) {
    return [{ state: "clear", count: 0 }];
  }
  const badges: AiCouncilHealthBadgeView[] = [];
  if (counts.critical > 0) {
    badges.push({ state: "critical", count: counts.critical });
  }
  if (counts.warning > 0) {
    badges.push({ state: "warning", count: counts.warning });
  }
  if (counts.info > 0) {
    badges.push({ state: "info", count: counts.info });
  }
  return badges;
}

function topAiCouncilHealthState(counts: AiCouncilHealthCounts): AiCouncilHealthState {
  if (counts.critical > 0) {
    return "critical";
  }
  if (counts.warning > 0) {
    return "warning";
  }
  if (counts.info > 0) {
    return "info";
  }
  return "clear";
}

function countHealthFindingsBySeverity(
  findings: readonly AiCouncilHealthFinding[],
): AiCouncilHealthCounts {
  return findings.reduce<AiCouncilHealthCounts>(
    (counts, finding) => ({
      ...counts,
      [finding.severity]: counts[finding.severity] + 1,
    }),
    { info: 0, warning: 0, critical: 0 },
  );
}
