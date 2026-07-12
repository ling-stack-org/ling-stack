import type { IncomingMessage, ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { DEFAULT_WORKSPACE_ID, isManuallyImportedSkillSource } from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { listEffectiveSkillRegistryEntries } from "./registry.js";

type SkillHardDeleteStore = ReturnType<RunStoreRegistry["getStore"]>;

export async function handleSkillHardDelete(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: SkillHardDeleteStore;
  readonly controlPlaneEvents: ControlPlaneEventHub;
  readonly cwd: string;
  readonly skillId: string;
}): Promise<void> {
  if (input.request.method !== "POST") {
    writeJson(input.response, 405, {
      error: "method_not_allowed",
      message: `${input.request.method} is not supported for /skills/:id/hard-delete`,
    });
    return;
  }

  const effectiveSkill = listEffectiveSkillRegistryEntries(input.store).find((skill) => skill.id === input.skillId);
  if (!effectiveSkill) {
    writeJson(input.response, 404, { error: "skill_not_found", message: `Skill not found: ${input.skillId}` });
    return;
  }
  if (!isManuallyImportedSkillSource(effectiveSkill.source)) {
    writeJson(input.response, 409, { error: "skill_delete_not_imported", message: "skill_delete_not_imported" });
    return;
  }

  const result = input.store.hardDeleteSkillRegistryEntry(input.skillId);
  if (result.status === "not_found") {
    writeJson(input.response, 404, { error: "skill_not_found", message: `Skill not found: ${input.skillId}` });
    return;
  }
  if (result.status === "not_imported") {
    writeJson(input.response, 409, { error: "skill_delete_not_imported", message: "skill_delete_not_imported" });
    return;
  }
  if (result.status === "blocked") {
    writeJson(input.response, 409, {
      error: "skill_delete_blocked",
      message: `skill_delete_blocked:${result.blockers.map((blocker) => blocker.kind).join(",")}`,
    });
    return;
  }

  await deleteSkillSourceArtifactFiles(input.store, result.artifactStorageRefs);
  const deletedAt = new Date().toISOString();
  appendControlPlaneEvent(input.store, input.controlPlaneEvents, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd: input.cwd,
    domain: "skills",
    entityType: "registry",
    entityId: result.skill.id,
    action: "skill.registry_changed",
    data: {
      changeType: "hard_delete",
      skillId: result.skill.id,
    },
  });
  writeJson(input.response, 200, { cwd: input.cwd, deletedSkillId: result.skill.id, deletedAt });
}

async function deleteSkillSourceArtifactFiles(
  store: SkillHardDeleteStore,
  storageRefs: readonly string[],
): Promise<void> {
  for (const storageRef of new Set(storageRefs)) {
    const artifactPath = resolve(store.paths.artifactsDir, storageRef);
    if (!isPathInside(store.paths.artifactsDir, artifactPath)) {
      continue;
    }
    try {
      await rm(artifactPath, { force: true });
    } catch {
      // Source artifacts are cached copies. The registry deletion stays authoritative.
    }
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`));
}
