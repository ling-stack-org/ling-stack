import { createSkillSourceSnapshotId, SkillSourcePublicationError, type RunStore, type SkillSourceSnapshot } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

/** Explicit user choice; historical imports are never opted in just by name. */
export function updateBundledSourceMode(store: RunStore, snapshot: SkillSourceSnapshot, body: unknown, now: string): SkillSourceSnapshot {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_source_update_mode", "Expected a version selection.");
  const mode = Reflect.get(body, "bundleUpdateMode");
  if (mode !== "follow" && mode !== "pinned") throw new HttpError(400, "invalid_source_update_mode", "Expected follow or pinned.");
  if (Reflect.get(body, "expectedSnapshotId") !== snapshot.id || Reflect.get(body, "expectedSourceChecksum") !== snapshot.sourceChecksum) {
    throw new HttpError(409, "skill_source_publication_conflict", "Skill source changed; refresh before choosing a version.");
  }
  if (snapshot.sourceKind !== "gstack-skill-directory" || !snapshot.referencedFiles.some(file =>
    file.path === "manifest.json" && /^sha256:[a-f0-9]{64}$/.test(file.checksum ?? ""))) {
    throw new HttpError(409, "skill_source_bundle_migration_required", "This source has no authenticated client-bundle identity.");
  }
  try {
    return store.publishSkillSourceBatch({ records: [{ expectedSnapshotId: snapshot.id,
      expectedSourceChecksum: snapshot.sourceChecksum, snapshot: { ...snapshot,
        id: createSkillSourceSnapshotId(), bundleUpdateMode: mode } }] }, now).snapshots[0]!;
  } catch (error) {
    if (error instanceof SkillSourcePublicationError) throw new HttpError(409, error.code, error.message);
    throw error;
  }
}
