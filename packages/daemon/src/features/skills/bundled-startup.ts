import {
  createSkillSourceSnapshotId, DEFAULT_WORKSPACE_ID, getBuiltinSkillPack, isLingNativeSkillId,
  isSourceManagedSkill, parseSkillFrontMatter, previewSkillSourceDefinition,
  type PublishSkillSourceBatchInput, type RunStore,
} from "@ling-stack/core";
import { verifyBundledSkillSource } from "@ling-stack/core/bundled-skill-source";

/** Preload all authenticated bodies before opening any workspace or listener. */
export async function prepareBundledSkillStartup(
  selection: Parameters<typeof verifyBundledSkillSource>[0],
  onAdmitted?: (source: Awaited<ReturnType<typeof verifyBundledSkillSource>>) => void | Promise<void>,
): Promise<(store: RunStore) => void> {
  const source = await verifyBundledSkillSource({ ...selection, requireExecutable: true });
  const definitions = getBuiltinSkillPack("gstack-default")?.skills ?? [];
  const prepared = await Promise.all(source.manifest.skills.map(async skill => {
    if (isLingNativeSkillId(skill.id)) throw new Error("bundled_skill_native_identity_collision");
    const body = await source.readSkill(skill.id);
    if (body.markdown.length > 256 * 1024) throw new Error("bundled_skill_body_over_budget");
    return { skill, body };
  }));
  await onAdmitted?.(source);
  return store => {
    const records: PublishSkillSourceBatchInput["records"][number][] = [];
    const newDefinitions: NonNullable<PublishSkillSourceBatchInput["newSkills"]>["definitions"][number][] = [];
    for (const { skill, body } of prepared) {
      const existing = store.getSkillRegistryEntry(skill.id);
      if (existing && !isSourceManagedSkill(existing)) throw new Error(`bundled_skill_identity_collision:${skill.id}`);
      const history = store.listSkillSourceSnapshots({ skillId: skill.id, includeArchived: true });
      const active = store.getSkillSourceSnapshot(skill.id);
      const follow = active?.bundleUpdateMode === "follow" && existing?.reviewStatus !== "archived" && existing?.reviewStatus !== "disabled"
        && !history.some(snapshot => snapshot.reviewStatus === "draft" || snapshot.reviewStatus === "reviewed")
        && !isOlderVersion(source.manifest.upstream.version, active.upstreamVersion);
      // Old imports, explicit pins/rollback and unpublished user work stay put.
      if ((existing || history.length) && !follow) continue;
      const builtin = definitions.find(definition => definition.id === skill.id);
      const metadata = parseSkillFrontMatter(body.markdown);
      const definition = previewSkillSourceDefinition(skill.id, {
        markdown: body.markdown, skillDirectoryName: skill.id, ...metadata,
        root: { sourceKind: "gstack-skill-directory" },
      }, builtin ? {
        id: skill.id, definition: builtin, source: "builtin", packId: "gstack-default",
        workspaceId: DEFAULT_WORKSPACE_ID, visibility: { workspaceVisible: true, promotableToWorkspace: false },
        reviewStatus: "builtin", createdAt: "", updatedAt: "",
      } : undefined);
      if (!existing) newDefinitions.push({ definition: builtin ? definition : {
        ...definition,
        approvalProfile: { mode: "strict", risk: "high", requiredForTools: ["bash", "edit", "write"],
          requiredForActions: ["external_send", "deploy"] },
      } });
      records.push({ ...(follow ? { expectedSnapshotId: active!.id, expectedSourceChecksum: active!.sourceChecksum,
        requireBundledFollow: true } : { requireNoSourceHistory: true }), snapshot: {
        id: createSkillSourceSnapshotId(), skillId: skill.id, sourceKind: "gstack-skill-directory",
        upstreamName: "gstack", upstreamVersion: source.manifest.upstream.version,
        bundleUpdateMode: "follow",
        upstreamSkillPath: skill.entryPath, rawSkillMarkdown: body.markdown,
        sourceChecksum: body.sourceChecksum, warnings: metadata.warnings,
        referencedFiles: [{ path: "manifest.json", kind: "other", checksum: source.manifestChecksum, includedInSnapshot: false }],
      } });
    }
    if (!records.length) return;
    store.publishSkillSourceBatch({ records, newSkills: {
      source: "gstack", packId: "gstack-default", name: "Bundled GStack",
      version: source.manifest.upstream.version, description: "Authenticated client-bundled skill sources.",
      definitions: newDefinitions,
    } }, new Date().toISOString());
  };
}

function isOlderVersion(next: string, current: string | undefined): boolean {
  if (!current || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(current)) return true;
  const a = next.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}
