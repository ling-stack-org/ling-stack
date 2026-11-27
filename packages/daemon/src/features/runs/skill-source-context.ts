import { instructionPackChecksum, resolveSkillSourceRuntimeView, type RunStore, type SkillOptimizationMode } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { bindPackagedSkillContext } from "../skills/packaged-runtime.js";
import { preparePackagedSkillGeneration } from "../skills/packaged-resolution.js";
import { readInstructionSkillReferences } from "../skills/optional-pack-publication.js";
import { optionalSkillPackEnabled } from "../skills/optional-pack-catalog.js";

export async function prepareRunSkillSource(store: RunStore, skillId: string, optimizationMode: SkillOptimizationMode) {
  const snapshot = store.getSkillSourceSnapshot(skillId);
  const registry = store.getSkillRegistryEntry(skillId);
  const managed = !["implement", "checkpoint"].includes(skillId)
    && (snapshot?.sourceKind === "gstack-skill-directory" || registry?.source === "gstack" || Boolean(snapshot && instructionPackChecksum(snapshot)));
  const compiledView = snapshot && (optimizationMode === "auto_safe" || optimizationMode === "auto_runtime_experimental")
    ? store.listSkillCompiledRuntimeViews({ skillId, sourceSnapshotId: snapshot.id, reviewStatus: "active" })[0]
    : undefined;
  const result = resolveSkillSourceRuntimeView({ skillId, snapshot, compiledView, optimizationMode,
    requireCompleteSource: managed });
  if (managed && (!result.context.loaded || result.context.truncated)) {
    throw new HttpError(409, "skill_source_not_ready", `Skill source is not executable: ${result.context.blockedReason ?? "source_truncated"}`);
  }
  await preparePackagedSkillGeneration(result.context, optionalSkillPackEnabled(store, "gstack") === true);
  const references = await readInstructionSkillReferences(result.context);
  return { ...result,
    promptFragment: references ? [result.promptFragment, references].filter(Boolean).join("\n\n") : result.promptFragment,
    context: bindPackagedSkillContext(result.context) };
}
