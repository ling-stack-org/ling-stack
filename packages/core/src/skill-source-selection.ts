import type { SkillSourceSnapshot } from "./skill-types.js";

export function selectActiveSkillSourceSnapshots(snapshots: readonly SkillSourceSnapshot[]): SkillSourceSnapshot[] {
  const ordered = snapshots.filter((snapshot) => snapshot.reviewStatus === "published").sort((a, b) =>
    a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const selected = new Map<string, SkillSourceSnapshot>();
  for (const snapshot of ordered) {
    const identity = JSON.stringify([snapshot.workspaceId, snapshot.skillId]);
    if (!selected.has(identity)) selected.set(identity, snapshot);
  }
  return [...selected.values()];
}
