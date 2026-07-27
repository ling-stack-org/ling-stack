import type { Translate } from "../../i18n.js";
import {
  aiCouncilHealthFindingLabels,
  aiCouncilHealthFindings,
  aiCouncilHealthLabels,
  aiCouncilRoutingModeLabel,
  aiCouncilSourceLabel,
} from "../../lib/ai-councils.js";
import type {
  AiCouncil,
  AiCouncilHealthFinding,
  AiCouncilHealthReport,
  AiCouncilHealthSeverity,
} from "../../types.js";

export type CouncilListHealthState = "attention" | "healthy" | "partial" | "paused" | "pending";
export type CouncilListHealthTone = "danger" | "info" | "neutral" | "success" | "warning";
export type CouncilListHealthFilter = "all" | "critical" | "info" | "warning" | CouncilListHealthState;

export const councilListHealthFilters: readonly CouncilListHealthFilter[] = [
  "all",
  "healthy",
  "attention",
  "critical",
  "warning",
  "info",
  "partial",
  "pending",
  "paused",
];

export interface CouncilListHealthRowView {
  readonly council: AiCouncil;
  readonly findingLabels: readonly string[];
  readonly findings: readonly AiCouncilHealthFinding[];
  readonly highestSeverity?: AiCouncilHealthSeverity;
  readonly partialReason?: string;
  readonly reportGeneratedAt?: string;
  readonly routingLabel: string;
  readonly searchText: string;
  readonly severityLabels: readonly string[];
  readonly sourceLabel: string;
  readonly state: CouncilListHealthState;
  readonly statusLabel: string;
  readonly tone: CouncilListHealthTone;
}

export interface CouncilListHealthOverviewView {
  readonly active: number;
  readonly attention: number;
  readonly custom: number;
  readonly healthy: number;
  readonly partial: number;
  readonly paused: number;
  readonly pending: number;
  readonly total: number;
}

export function buildCouncilListHealthRows(
  councils: readonly AiCouncil[],
  report: AiCouncilHealthReport | undefined,
  t: Translate,
): readonly CouncilListHealthRowView[] {
  const activeCouncils = councils.filter((council) => council.status !== "archived");
  return activeCouncils
    .map((council) => buildCouncilListHealthRow(council, report, activeCouncils.length, t))
    .sort((left, right) => (
      Number(right.council.pinned) - Number(left.council.pinned) ||
      left.council.displayName.localeCompare(right.council.displayName)
    ));
}

export function filterCouncilListHealthRows(
  rows: readonly CouncilListHealthRowView[],
  query: string,
  filter: CouncilListHealthFilter,
): readonly CouncilListHealthRowView[] {
  const normalizedQuery = normalizeSearchText(query);
  return rows.filter((row) => (
    councilListHealthRowMatchesFilter(row, filter) &&
    (!normalizedQuery || row.searchText.includes(normalizedQuery))
  ));
}

export function buildCouncilListHealthOverview(
  rows: readonly CouncilListHealthRowView[],
): CouncilListHealthOverviewView {
  return rows.reduce<CouncilListHealthOverviewView>((overview, row) => ({
    active: overview.active + (row.council.status === "active" ? 1 : 0),
    attention: overview.attention + (row.state === "attention" ? 1 : 0),
    custom: overview.custom + (row.council.source === "user" ? 1 : 0),
    healthy: overview.healthy + (row.state === "healthy" ? 1 : 0),
    partial: overview.partial + (row.state === "partial" ? 1 : 0),
    paused: overview.paused + (row.state === "paused" ? 1 : 0),
    pending: overview.pending + (row.state === "pending" ? 1 : 0),
    total: overview.total + 1,
  }), {
    active: 0,
    attention: 0,
    custom: 0,
    healthy: 0,
    partial: 0,
    paused: 0,
    pending: 0,
    total: 0,
  });
}

export function councilListHealthFilterLabel(filter: CouncilListHealthFilter, t: Translate): string {
  if (filter === "healthy") return t("Healthy councils");
  if (filter === "attention") return t("Councils needing attention");
  if (filter === "partial") return t("Partial health information");
  if (filter === "pending") return t("Health pending");
  if (filter === "paused") return t("Paused councils");
  if (filter === "critical") return t("Critical findings");
  if (filter === "warning") return t("Warning findings");
  if (filter === "info") return t("Info findings");
  return t("All council states");
}

function councilListHealthRowMatchesFilter(
  row: CouncilListHealthRowView,
  filter: CouncilListHealthFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "critical" || filter === "warning" || filter === "info") {
    return row.findings.some((finding) => finding.severity === filter);
  }
  return row.state === filter;
}

function buildCouncilListHealthRow(
  council: AiCouncil,
  report: AiCouncilHealthReport | undefined,
  visibleCouncilCount: number,
  t: Translate,
): CouncilListHealthRowView {
  const findings = aiCouncilHealthFindings(report, council.id);
  const findingLabels = aiCouncilHealthFindingLabels(report, council.id, t);
  const severityLabels = aiCouncilHealthLabels(report, council.id, t);
  const highestSeverity = topSeverity(findings);
  const sourceLabel = aiCouncilSourceLabel(council.source, t);
  const routingLabel = aiCouncilRoutingModeLabel(council.routingPolicy.defaultMode, t);
  const partialReason = council.status === "paused"
    ? undefined
    : healthReportPartialReason(council, report, visibleCouncilCount, t);
  const state = derivePrimaryState(council, report, findings, partialReason);

  return {
    council,
    findingLabels,
    findings,
    highestSeverity,
    partialReason,
    reportGeneratedAt: validTimestamp(report?.generatedAt) ? report?.generatedAt : undefined,
    routingLabel,
    searchText: normalizeSearchText([
      council.displayName,
      council.description,
      sourceLabel,
      routingLabel,
    ].join(" ")),
    severityLabels,
    sourceLabel,
    state,
    statusLabel: statusLabel(state, highestSeverity, t),
    tone: statusTone(state, highestSeverity),
  };
}

function healthReportPartialReason(
  council: AiCouncil,
  report: AiCouncilHealthReport | undefined,
  visibleCouncilCount: number,
  t: Translate,
): string | undefined {
  if (!report) return undefined;
  if (report.workspaceId !== council.workspaceId) return t("Health report does not cover this workspace");

  const generatedAt = timestampValue(report.generatedAt);
  const councilUpdatedAt = timestampValue(council.updatedAt);
  if (generatedAt === undefined) return t("Health report time is unavailable");
  if (councilUpdatedAt !== undefined && generatedAt < councilUpdatedAt) return t("Health report predates this council configuration");

  const expectedFindingCount = report.summary.findings.critical + report.summary.findings.warning + report.summary.findings.info;
  if (report.findings.length < expectedFindingCount) return t("Health findings are incomplete");
  if (report.summary.totalCouncils < visibleCouncilCount) return t("Health report does not cover every visible council");
  return undefined;
}

function derivePrimaryState(
  council: AiCouncil,
  report: AiCouncilHealthReport | undefined,
  findings: readonly AiCouncilHealthFinding[],
  partialReason: string | undefined,
): CouncilListHealthState {
  if (council.status === "paused") return "paused";
  if (partialReason) return "partial";
  if (!report) return "pending";
  if (findings.length > 0) return "attention";
  return "healthy";
}

function statusLabel(
  state: CouncilListHealthState,
  severity: AiCouncilHealthSeverity | undefined,
  t: Translate,
): string {
  if (state === "paused") return t("Paused");
  if (state === "partial") return t("Partial health");
  if (state === "pending") return t("Health pending");
  if (state === "healthy") return t("Health clear");
  if (severity === "critical") return t("Critical attention needed");
  return t("Needs attention");
}

function statusTone(
  state: CouncilListHealthState,
  severity: AiCouncilHealthSeverity | undefined,
): CouncilListHealthTone {
  if (state === "healthy") return "success";
  if (state === "partial") return "warning";
  if (state === "attention") {
    if (severity === "critical") return "danger";
    if (severity === "info") return "info";
    return "warning";
  }
  return "neutral";
}

function topSeverity(findings: readonly AiCouncilHealthFinding[]): AiCouncilHealthSeverity | undefined {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  if (findings.some((finding) => finding.severity === "info")) return "info";
  return undefined;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function validTimestamp(value: string | undefined): boolean {
  return timestampValue(value) !== undefined;
}

function timestampValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
