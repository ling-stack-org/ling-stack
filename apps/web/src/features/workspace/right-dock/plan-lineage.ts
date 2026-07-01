import type { ProposedPlanArtifact } from "../../../types.js";

export interface PlanLineageGroup {
  readonly id: string;
  readonly goalId?: string;
  readonly planGroupId: string;
  readonly latestPlan: ProposedPlanArtifact;
  readonly versions: readonly ProposedPlanArtifact[];
  readonly versionCount: number;
  readonly supersededCount: number;
}

export function buildPlanLineageGroups(plans: readonly ProposedPlanArtifact[]): readonly PlanLineageGroup[] {
  const groups = new Map<string, ProposedPlanArtifact[]>();
  for (const plan of plans) {
    const planGroupId = plan.planGroupId || plan.parentPlanId || plan.id;
    const groupKey = `${plan.goalId ?? "no-goal"}:${planGroupId}`;
    const group = groups.get(groupKey) ?? [];
    group.push(plan);
    groups.set(groupKey, group);
  }
  return [...groups.entries()]
    .map(([id, versions]) => {
      const sortedVersions = sortPlanVersions(versions);
      const latestPlan = sortedVersions[0];
      return {
        id,
        goalId: latestPlan.goalId,
        planGroupId: latestPlan.planGroupId || latestPlan.parentPlanId || latestPlan.id,
        latestPlan,
        versions: sortedVersions,
        versionCount: sortedVersions.length,
        supersededCount: sortedVersions.filter((plan) => plan.status === "superseded").length,
      };
    })
    .sort((left, right) =>
      compareOptionalString(left.goalId, right.goalId) ||
      right.latestPlan.updatedAt.localeCompare(left.latestPlan.updatedAt) ||
      right.latestPlan.createdAt.localeCompare(left.latestPlan.createdAt) ||
      left.planGroupId.localeCompare(right.planGroupId)
    );
}

export function visiblePlanLineageVersions(
  group: PlanLineageGroup,
  expanded: boolean,
): readonly ProposedPlanArtifact[] {
  if (expanded) {
    return group.versions;
  }
  const visible = new Map<string, ProposedPlanArtifact>();
  visible.set(group.latestPlan.id, group.latestPlan);
  for (const plan of group.versions) {
    if (plan.status === "accepted") {
      visible.set(plan.id, plan);
    }
  }
  return sortPlanVersions([...visible.values()]);
}

function sortPlanVersions(plans: readonly ProposedPlanArtifact[]): readonly ProposedPlanArtifact[] {
  return [...plans].sort((left, right) =>
    comparePlanVersion(right, left) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function comparePlanVersion(left: ProposedPlanArtifact, right: ProposedPlanArtifact): number {
  const leftVersion = left.version ?? 1;
  const rightVersion = right.version ?? 1;
  return leftVersion - rightVersion;
}

function compareOptionalString(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  return left.localeCompare(right);
}
