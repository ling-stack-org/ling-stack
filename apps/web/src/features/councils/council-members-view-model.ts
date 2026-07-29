import type { Translate } from "../../i18n.js";
import type {
  AiCouncil,
  AiCouncilHealthFinding,
  AiCouncilHealthReport,
  AiCouncilMember,
  AiTeammate,
  ReplaceAiCouncilMembersRequest,
} from "../../types.js";

export type CouncilMemberReadinessState =
  | "disabled"
  | "excluded"
  | "hidden"
  | "inactive"
  | "missing"
  | "ready"
  | "ready_when_resumed"
  | "unknown";

export type CouncilMemberReadinessTone = "danger" | "info" | "neutral" | "success" | "warning";

export interface CouncilMemberCandidateView {
  readonly label: string;
  readonly teammate: AiTeammate;
}

export interface CouncilMemberRowView {
  readonly displayName: string;
  readonly member: AiCouncilMember;
  readonly readinessLabel: string;
  readonly readinessState: CouncilMemberReadinessState;
  readonly readinessTitle?: string;
  readonly readinessTone: CouncilMemberReadinessTone;
  readonly subtitle: string;
  readonly teammate?: AiTeammate;
}

export interface CouncilMembersEvidenceView {
  readonly complete: boolean;
  readonly generatedAt?: string;
  readonly reason?: string;
}

export interface CouncilMembersSummaryView {
  readonly enabled: number;
  readonly label: string;
  readonly ready: number;
  readonly total: number;
}

export interface CouncilMemberHealthPending {
  readonly baselineGeneratedAt?: string;
  readonly councilId: string;
}

export type CouncilMemberIntent =
  | { readonly kind: "add"; readonly teammate: AiTeammate }
  | { readonly kind: "move"; readonly delta: -1 | 1; readonly teammateId: string }
  | { readonly kind: "remove"; readonly teammateId: string }
  | { readonly kind: "toggle"; readonly teammateId: string };

export interface CouncilMemberIntentResult {
  readonly changed: boolean;
  readonly members: ReplaceAiCouncilMembersRequest["members"];
  readonly targetPresent: boolean;
}

export function sortCouncilMembers(members: readonly AiCouncilMember[]): readonly AiCouncilMember[] {
  return [...members].sort((left, right) => (
    left.position - right.position || left.teammateId.localeCompare(right.teammateId)
  ));
}

export function councilMembersFingerprint(members: readonly AiCouncilMember[]): string {
  return JSON.stringify(sortCouncilMembers(members).map((member) => [
    member.teammateId,
    member.slotKey ?? null,
    member.label ?? null,
    member.position,
    member.enabled,
  ]));
}

export function buildCouncilMemberCandidates(
  teammates: readonly AiTeammate[],
  members: readonly AiCouncilMember[],
  t: Translate,
): readonly CouncilMemberCandidateView[] {
  const existingIds = new Set(members.map((member) => member.teammateId));
  return teammates
    .filter((teammate) => (
      !existingIds.has(teammate.id) &&
      !teammate.hidden &&
      teammate.status !== "disabled" &&
      !isLingAgentTeammate(teammate)
    ))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map((teammate) => ({
      teammate,
      label: teammate.status === "paused"
        ? `${teammate.displayName} (${t("Paused")})`
        : teammate.displayName,
    }));
}

export function buildCouncilMembersEvidence(
  council: AiCouncil,
  members: readonly AiCouncilMember[],
  report: AiCouncilHealthReport | undefined,
  pending: CouncilMemberHealthPending | undefined,
  t: Translate,
): CouncilMembersEvidenceView {
  if (!report) return { complete: false, reason: t("Refresh to load member readiness.") };
  if (report.workspaceId !== council.workspaceId) {
    return { complete: false, reason: t("Health report does not cover this workspace") };
  }
  const generatedAt = timestampValue(report.generatedAt);
  if (generatedAt === undefined) return { complete: false, reason: t("Health report time is unavailable") };
  const latestConfiguration = Math.max(
    timestampValue(council.updatedAt) ?? Number.POSITIVE_INFINITY,
    ...members.map((member) => timestampValue(member.updatedAt) ?? Number.POSITIVE_INFINITY),
  );
  if (generatedAt < latestConfiguration) {
    return { complete: false, generatedAt: report.generatedAt, reason: t("Health report predates this council configuration") };
  }
  const expectedFindingCount = report.summary.findings.critical + report.summary.findings.warning + report.summary.findings.info;
  if (report.findings.length < expectedFindingCount) {
    return { complete: false, generatedAt: report.generatedAt, reason: t("Health findings are incomplete") };
  }
  if (pending?.councilId === council.id) {
    const baseline = timestampValue(pending.baselineGeneratedAt);
    if (baseline === undefined || generatedAt <= baseline) {
      return { complete: false, generatedAt: report.generatedAt, reason: t("Health pending") };
    }
  }
  return { complete: true, generatedAt: report.generatedAt };
}

export function buildCouncilMemberRows(
  council: AiCouncil,
  members: readonly AiCouncilMember[],
  teammates: readonly AiTeammate[],
  report: AiCouncilHealthReport | undefined,
  evidence: CouncilMembersEvidenceView,
  t: Translate,
): readonly CouncilMemberRowView[] {
  const teammateById = new Map(teammates.map((teammate) => [teammate.id, teammate]));
  return sortCouncilMembers(members).map((member) => {
    const teammate = teammateById.get(member.teammateId);
    const finding = topMemberFinding(report, council.id, member.teammateId);
    const readiness = memberReadiness(member, council, finding, evidence, t);
    const displayName = teammate?.displayName ?? member.label ?? member.slotKey ?? t("Member unavailable");
    const roleLabel = teammate ? t(`role.${teammate.roleKey}`) : (member.label ?? member.slotKey ?? "");
    return {
      displayName,
      member,
      readinessLabel: readiness.label,
      readinessState: readiness.state,
      readinessTitle: readiness.title,
      readinessTone: readiness.tone,
      subtitle: normalizedSubtitle(displayName, roleLabel),
      teammate,
    };
  });
}

export function buildCouncilMembersSummary(
  rows: readonly CouncilMemberRowView[],
  evidence: CouncilMembersEvidenceView,
  t: Translate,
): CouncilMembersSummaryView {
  const enabled = rows.filter((row) => row.member.enabled).length;
  const ready = rows.filter((row) => row.readinessState === "ready").length;
  return {
    enabled,
    ready,
    total: rows.length,
    label: evidence.complete
      ? `${ready} ${t("Ready")} · ${t("{count} enabled members", { count: enabled })}`
      : `${t("Health information is incomplete.")} · ${t("{count} enabled members", { count: enabled })}`,
  };
}

export function applyCouncilMemberIntent(
  current: readonly AiCouncilMember[],
  intent: CouncilMemberIntent,
): CouncilMemberIntentResult {
  const sorted = sortCouncilMembers(current);
  const targetIndex = intent.kind === "add"
    ? sorted.findIndex((member) => member.teammateId === intent.teammate.id)
    : sorted.findIndex((member) => member.teammateId === intent.teammateId);

  if (intent.kind === "add") {
    if (targetIndex >= 0) return { changed: false, members: toReplaceInput(sorted), targetPresent: true };
    return {
      changed: true,
      targetPresent: false,
      members: [
        ...toReplaceInput(sorted),
        {
          teammateId: intent.teammate.id,
          slotKey: intent.teammate.roleKey,
          position: sorted.length,
          enabled: true,
        },
      ],
    };
  }
  if (targetIndex < 0) return { changed: false, members: toReplaceInput(sorted), targetPresent: false };

  if (intent.kind === "remove") {
    return { changed: true, members: toReplaceInput(sorted.filter((_, index) => index !== targetIndex)), targetPresent: true };
  }
  if (intent.kind === "toggle") {
    return {
      changed: true,
      targetPresent: true,
      members: toReplaceInput(sorted.map((member, index) => (
        index === targetIndex ? { ...member, enabled: !member.enabled } : member
      ))),
    };
  }

  const destination = targetIndex + intent.delta;
  if (destination < 0 || destination >= sorted.length) {
    return { changed: false, members: toReplaceInput(sorted), targetPresent: true };
  }
  const reordered = [...sorted];
  const [member] = reordered.splice(targetIndex, 1);
  reordered.splice(destination, 0, member);
  return { changed: true, members: toReplaceInput(reordered), targetPresent: true };
}

function toReplaceInput(members: readonly AiCouncilMember[]): ReplaceAiCouncilMembersRequest["members"] {
  return members.map((member, position) => ({
    teammateId: member.teammateId,
    slotKey: member.slotKey,
    label: member.label,
    position,
    enabled: member.enabled,
  }));
}

function memberReadiness(
  member: AiCouncilMember,
  council: AiCouncil,
  finding: AiCouncilHealthFinding | undefined,
  evidence: CouncilMembersEvidenceView,
  t: Translate,
): { readonly label: string; readonly state: CouncilMemberReadinessState; readonly title?: string; readonly tone: CouncilMemberReadinessTone } {
  if (!member.enabled) return { label: t("Disabled"), state: "disabled", tone: "neutral" };
  if (finding?.kind === "teammate_missing") return { label: t("Teammate missing"), state: "missing", tone: "danger" };
  if (finding?.kind === "teammate_hidden") return { label: t("Teammate hidden"), state: "hidden", tone: "warning" };
  if (finding?.kind === "teammate_not_active") return { label: t("Teammate inactive"), state: "inactive", tone: "warning" };
  if (finding?.kind === "system_teammate_excluded") return { label: t("System teammate excluded"), state: "excluded", tone: "warning" };
  if (!evidence.complete) return { label: t("Health pending"), state: "unknown", title: evidence.reason, tone: "neutral" };
  if (council.status === "paused") return { label: t("Paused"), state: "ready_when_resumed", tone: "info" };
  return { label: t("Ready"), state: "ready", tone: "success" };
}

function topMemberFinding(
  report: AiCouncilHealthReport | undefined,
  councilId: string,
  teammateId: string,
): AiCouncilHealthFinding | undefined {
  const priority: readonly AiCouncilHealthFinding["kind"][] = [
    "teammate_missing",
    "teammate_hidden",
    "teammate_not_active",
    "system_teammate_excluded",
    "member_disabled",
  ];
  const findings = report?.findings.filter((finding) => (
    finding.councilId === councilId && finding.teammateId === teammateId
  )) ?? [];
  return [...findings].sort((left, right) => priority.indexOf(left.kind) - priority.indexOf(right.kind))[0];
}

function isLingAgentTeammate(teammate: AiTeammate): boolean {
  return teammate.id === "ling_agent" || teammate.id === "ling-agent" || teammate.systemRole === "ling_agent";
}

function normalizedSubtitle(displayName: string, subtitle: string): string {
  return displayName.trim().toLocaleLowerCase() === subtitle.trim().toLocaleLowerCase() ? "" : subtitle;
}

function timestampValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
