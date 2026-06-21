import {
  aiCouncilHealthViewMatchesState,
  buildAiCouncilHealthOverviewView,
  buildAiCouncilHealthView,
  countAiCouncilHealthFindings,
  listAiCouncilHealthFindings,
} from "@ling-stack/core/ai-council-view";
import type { AiCouncil, AiCouncilHealthFinding, AiCouncilHealthReport, AiCouncilHealthSeverity } from "../types.js";
import type { Translate } from "../i18n.js";

export type AiCouncilHealthFilter = "all" | "needs_attention" | "critical" | "warning" | "info" | "clear";

export const aiCouncilHealthFilters: readonly AiCouncilHealthFilter[] = [
  "all",
  "needs_attention",
  "critical",
  "warning",
  "info",
  "clear",
];

export interface AiCouncilHealthOverview {
  readonly total: number;
  readonly needsAttention: number;
  readonly healthy: number;
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export function aiCouncilSourceLabel(source: AiCouncil["source"], t: Translate): string {
  if (source === "builtin") {
    return t("Built-in");
  }
  if (source === "template") {
    return t("Template");
  }
  return t("Custom");
}

export function aiCouncilRoutingModeLabel(mode: AiCouncil["routingPolicy"]["defaultMode"], t: Translate): string {
  if (mode === "parallel_review") {
    return t("Parallel review");
  }
  if (mode === "handoff") {
    return t("Handoff");
  }
  return t("Advisory");
}

export function aiCouncilBoundaryLabels(council: AiCouncil, t: Translate): readonly string[] {
  return [
    t("Reference collection"),
    council.governanceProfile.permissionBoundary === "restrict_only" ? t("Policy narrows authority") : undefined,
    council.governanceProfile.approvalBoundary === "cannot_bypass" ? t("Cannot bypass approvals") : undefined,
    council.governanceProfile.toolGrantBoundary === "cannot_grant" ? t("Cannot grant tools") : undefined,
    council.governanceProfile.credentialBoundary === "cannot_grant" ? t("Cannot grant credentials") : undefined,
  ].filter((label): label is string => Boolean(label));
}

export function aiCouncilCapacityLabel(council: AiCouncil, t: Translate): string | undefined {
  return council.routingPolicy.maxActiveMembers
    ? t("Max active {count}", { count: council.routingPolicy.maxActiveMembers })
    : undefined;
}

export function aiCouncilHealthFindings(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
): readonly AiCouncilHealthFinding[] {
  return listAiCouncilHealthFindings(report, councilId);
}

export function aiCouncilHealthSeverityCounts(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
): Record<AiCouncilHealthSeverity, number> {
  return countAiCouncilHealthFindings(report, councilId);
}

export function aiCouncilHealthLabels(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
  t: Translate,
): readonly string[] {
  if (!report) {
    return [];
  }
  const view = buildAiCouncilHealthView(report, councilId);
  if (view.state === "clear") {
    return [t("Health clear")];
  }
  return view.badges.map((badge) => aiCouncilHealthBadgeLabel(badge.state, badge.count, t));
}

export function aiCouncilHealthFindingLabels(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
  t: Translate,
): readonly string[] {
  return aiCouncilHealthFindings(report, councilId).map((finding) => {
    const subject = finding.label ?? finding.teammateId ?? finding.councilDisplayName;
    return `${subject}: ${aiCouncilHealthFindingKindLabel(finding.kind, t)}`;
  });
}

export function aiCouncilHealthOverview(
  councils: readonly AiCouncil[],
  report: AiCouncilHealthReport | undefined,
): AiCouncilHealthOverview {
  return buildAiCouncilHealthOverviewView(councils, report);
}

export function aiCouncilMatchesHealthFilter(
  council: AiCouncil,
  report: AiCouncilHealthReport | undefined,
  filter: AiCouncilHealthFilter,
): boolean {
  if (filter === "all") {
    return true;
  }
  if (!report) {
    return false;
  }
  return aiCouncilHealthViewMatchesState(buildAiCouncilHealthView(report, council.id), filter);
}

export function aiCouncilHealthFilterLabel(filter: AiCouncilHealthFilter, t: Translate): string {
  if (filter === "needs_attention") {
    return t("Needs attention");
  }
  if (filter === "critical") {
    return t("Critical findings");
  }
  if (filter === "warning") {
    return t("Warning findings");
  }
  if (filter === "info") {
    return t("Info findings");
  }
  if (filter === "clear") {
    return t("Health clear");
  }
  return t("All health states");
}

function aiCouncilHealthFindingKindLabel(kind: AiCouncilHealthFinding["kind"], t: Translate): string {
  if (kind === "council_not_active") {
    return t("Council inactive");
  }
  if (kind === "council_empty") {
    return t("Council empty");
  }
  if (kind === "council_no_available_members") {
    return t("No available members");
  }
  if (kind === "member_disabled") {
    return t("Member disabled");
  }
  if (kind === "teammate_missing") {
    return t("Teammate missing");
  }
  if (kind === "teammate_hidden") {
    return t("Teammate hidden");
  }
  if (kind === "system_teammate_excluded") {
    return t("System teammate excluded");
  }
  return t("Teammate inactive");
}

function aiCouncilHealthBadgeLabel(
  state: "clear" | AiCouncilHealthSeverity,
  count: number,
  t: Translate,
): string {
  if (state === "critical") {
    return t("{count} critical finding(s)", { count });
  }
  if (state === "warning") {
    return t("{count} warning finding(s)", { count });
  }
  if (state === "info") {
    return t("{count} info finding(s)", { count });
  }
  return t("Health clear");
}
