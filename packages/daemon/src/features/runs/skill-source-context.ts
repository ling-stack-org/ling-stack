import { resolveSkillSourceRuntimeView, type RunStore, type SkillOptimizationMode } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { bindPackagedSkillContext } from "../skills/packaged-runtime.js";

export function prepareRunSkillSource(store: RunStore, skillId: string, optimizationMode: SkillOptimizationMode) {
  const snapshot = store.getSkillSourceSnapshot(skillId);
  const registry = store.getSkillRegistryEntry(skillId);
  const managed = !["implement", "checkpoint"].includes(skillId)
    && (snapshot?.sourceKind === "gstack-skill-directory" || registry?.source === "gstack");
  const compiledView = snapshot && (optimizationMode === "auto_safe" || optimizationMode === "auto_runtime_experimental")
    ? store.listSkillCompiledRuntimeViews({ skillId, sourceSnapshotId: snapshot.id, reviewStatus: "active" })[0]
    : undefined;
  const result = resolveSkillSourceRuntimeView({ skillId, snapshot, compiledView, optimizationMode,
    requireCompleteSource: managed });
  if (managed && (!result.context.loaded || result.context.truncated)) {
    throw new HttpError(409, "skill_source_not_ready", `Skill source is not executable: ${result.context.blockedReason ?? "source_truncated"}`);
  }
  return { ...result, context: bindPackagedSkillContext(result.context) };
}
