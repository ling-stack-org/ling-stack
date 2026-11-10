import type { SkillSourceScanRoot, SkillSourceSyncPreviewRecord } from "../../types.js";

export function sharedSkillSourceKey(record: SkillSourceSyncPreviewRecord): string {
  return `${record.sourceRootId ?? ""}:${record.skillId}`;
}

export function canPublishSharedSkill(record: SkillSourceSyncPreviewRecord): boolean {
  return (record.state === "new" || record.state === "attachable" || record.state === "drifted") &&
    !record.semanticDiff.some((difference) => difference.severity === "error");
}

/** Ignore is reserved for source candidates that have not been adopted yet. */
export function canIgnoreSharedSkill(record: SkillSourceSyncPreviewRecord): boolean {
  return record.state === "new" || record.state === "attachable";
}

/** Keep orphaned snapshots out of the default discovery list. */
export function visibleSharedSkillSourceRecords(
  records: readonly SkillSourceSyncPreviewRecord[],
  ignored: ReadonlySet<string>,
  options: { readonly showIgnored?: boolean; readonly showOrphaned?: boolean } = {},
): readonly SkillSourceSyncPreviewRecord[] {
  return records.filter((record) => (options.showOrphaned || record.state !== "orphaned") &&
    (options.showIgnored || !ignored.has(sharedSkillSourceKey(record))));
}

export function sharedSkillSourceStatus(record: SkillSourceSyncPreviewRecord, ignored: ReadonlySet<string>): string {
  return ignored.has(sharedSkillSourceKey(record)) ? "ignored" : record.state;
}

export function actionableSharedSkillCount(records: readonly SkillSourceSyncPreviewRecord[], ignored: ReadonlySet<string>): number {
  return records.filter((record) => (record.state === "new" || record.state === "drifted") &&
    canPublishSharedSkill(record) && !ignored.has(sharedSkillSourceKey(record))).length;
}

/** Never expose the absolute workspace or home path in the discovery interface. */
export function sharedSkillSourceRootLabel(root: SkillSourceScanRoot | undefined): string {
  if (root?.id === "shared-agents-workspace") return "Workspace · .agents/skills";
  if (root?.id === "shared-agents-user") return "Home · .agents/skills";
  return ".agents/skills";
}

export function sharedSkillSourceLocation(record: SkillSourceSyncPreviewRecord, roots: readonly SkillSourceScanRoot[]): string {
  const root = roots.find((item) => item.id === record.sourceRootId);
  const source = record.sourcePath?.replaceAll("\\", "/");
  const prefix = root?.rootPath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (source && prefix && source.startsWith(`${prefix}/`)) return source.slice(prefix.length + 1);
  const upstream = record.upstreamSkillPath?.replaceAll("\\", "/");
  if (upstream && !upstream.startsWith("/") && !/^[a-zA-Z]:\//.test(upstream) && !upstream.split("/").includes("..")) return upstream;
  return `${record.skillId}/SKILL.md`;
}

export function readIgnoredSharedSkills(storage: Pick<Storage, "getItem"> | undefined, cwd: string): ReadonlySet<string> {
  if (!storage || !cwd.trim()) return new Set();
  try {
    const stored: unknown = JSON.parse(storage.getItem(sharedSkillIgnoreStorageKey(cwd)) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function sharedSkillIgnoreStorageKey(cwd: string): string {
  return `ling-stack.shared-skills.ignored:${cwd.trim()}`;
}
