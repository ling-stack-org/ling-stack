import { createSkillSourceSnapshotId, instructionPackChecksum, previewSkillSourceDefinition,
  type PublishSkillSourceBatchInput, type RunStore, type SkillSourceRuntimeContext } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { optionalSkillPacks } from "./optional-pack-catalog.js";
import { inspectInstructionSkill, packDigest, readRetainedInstructionPack, type InstructionPack } from "./optional-pack-source.js";

const owner = optionalSkillPacks.superpowers.packId;
const upstream = "obra/superpowers";
const sourceKind = "workspace-skill-directory";
const versionRef = "skill-pack.json";

export async function prepareInstructionPackPublication(pack: InstructionPack): Promise<(store: RunStore, now: string) => void> {
  const skills = await readRetainedInstructionPack(pack.checksum);
  const prepared = skills.map(skill => {
    const id = `${owner}-${skill.name}`;
    const { frontMatter, warnings } = inspectInstructionSkill(skill);
    const definition = previewSkillSourceDefinition(id, { frontMatter, warnings,
      markdown: skill.markdown, skillDirectoryName: skill.name, root: { sourceKind } });
    const sourceChecksum = `sha256:${packDigest(skill.markdown)}`;
    const references = skill.references.map(file => ({ path: file.path, kind: "reference" as const,
      checksum: `sha256:${packDigest(file.markdown)}`, sizeBytes: Buffer.byteLength(file.markdown), includedInSnapshot: false }));
    return { id, definition, skill, sourceChecksum, references, warnings };
  });
  return (store, now) => {
    const records: PublishSkillSourceBatchInput["records"][number][] = [];
    const definitions: NonNullable<PublishSkillSourceBatchInput["newSkills"]>["definitions"][number][] = [];
    for (const { id, definition, skill, sourceChecksum, references, warnings } of prepared) {
      const entry = store.getSkillRegistryEntry(id);
      const active = store.getSkillSourceSnapshot(id);
      if (entry && entry.packId !== owner || active && active.upstreamName !== upstream) {
        throw new HttpError(409, "skill_pack_identity_conflict", `The workspace already owns skill ${id}.`);
      }
      if (entry?.reviewStatus === "archived" || entry?.reviewStatus === "disabled") continue;
      if (!entry) definitions.push({ definition });
      records.push({ expectedSnapshotId: active?.id, expectedSourceChecksum: active?.sourceChecksum,
        snapshot: { id: createSkillSourceSnapshotId(), skillId: id, sourceKind, upstreamName: upstream,
          upstreamVersion: pack.version, upstreamSkillPath: `skills/${skill.name}/SKILL.md`, sourceChecksum,
          rawSkillMarkdown: skill.markdown, warnings,
          referencedFiles: [{ path: versionRef, kind: "other", checksum: `sha256:${pack.checksum}`, includedInSnapshot: false }, ...references] } });
    }
    if (records.length) store.publishSkillSourceBatch({ records, newSkills: definitions.length ? {
      source: "skill-directory", packId: owner, name: optionalSkillPacks.superpowers.name,
      version: pack.version, description: "Superpowers workflow skills.", definitions,
    } : undefined }, now);
  };
}

export async function readInstructionSkillReferences(context: SkillSourceRuntimeContext): Promise<string | undefined> {
  const digest = instructionPackChecksum(context);
  if (!digest) return undefined;
  const skills = await readRetainedInstructionPack(digest);
  const skill = skills.find(item => `${owner}-${item.name}` === context.skillId);
  if (!skill || context.sourceChecksum !== `sha256:${packDigest(skill.markdown)}`) {
    throw new HttpError(409, "skill_pack_version_unavailable", "The selected skill pack version is unavailable.");
  }
  if (!skill.references.length) return undefined;
  const lines = skill.references.map(ref => {
    const maximumRun = Math.max(2, ...[...ref.markdown.matchAll(/`+/gu)].map(match => match[0].length));
    const fence = "`".repeat(maximumRun + 1);
    return `### ${ref.path}\n${fence}\n${ref.markdown}\n${fence}`;
  });
  const markdown = lines.join("\n\n");
  if (markdown.length > 128 * 1024) throw new HttpError(409, "skill_pack_reference_budget", "The selected skill's references exceed the context limit.");
  return `## Selected skill's reference files\n\n${markdown}`;
}
