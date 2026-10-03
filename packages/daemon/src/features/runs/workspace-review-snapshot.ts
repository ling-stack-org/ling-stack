import { createHash } from "node:crypto";
import { applyPatchPlan, type PatchPlan } from "@ling-stack/core";

export interface WorkspaceReviewFileSnapshot {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}
export type WorkspaceReviewSnapshot =
  | { readonly schemaVersion: 1; readonly state: "exact"; readonly files: readonly WorkspaceReviewFileSnapshot[] }
  | { readonly schemaVersion: 1; readonly state: "unavailable"; readonly reason: string };

const snapshotByteBudget = 4 * 1024 * 1024;

/** Private sealed provenance only. Never added to public artifacts, events or model context. */
export async function captureWorkspaceReviewSnapshot(
  plan: PatchPlan,
  before: ReadonlyMap<string, string | undefined>,
): Promise<WorkspaceReviewSnapshot> {
  const bytes = [...before.values()].reduce<number>((sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"), 0)
    + plan.operations.reduce((sum, operation) => sum + operation.hunks.reduce((total, hunk) =>
      total + hunk.lines.reduce((size, line) => size + Buffer.byteLength(line.text, "utf8") + 2, 0), 0), 0);
  if (plan.touchedPaths.length > 128 || bytes > snapshotByteBudget) {
    return { schemaVersion: 1, state: "unavailable", reason: "Historical diff snapshot exceeds its storage budget." };
  }
  const after = new Map(before);
  try {
    await applyPatchPlan({ plan, readFile: (path) => before.get(path),
      writeFile: (path, content) => { after.set(path, content); },
      deleteFile: (path) => { after.set(path, undefined); } });
  } catch {
    // Review capture is auxiliary. The real mutation retains its original
    // validation/error/effect-unknown path, including stale-preview failures.
    return { schemaVersion: 1, state: "unavailable", reason: "Historical diff snapshot could not be validated." };
  }
  const files = plan.touchedPaths.map((path) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.before ?? "", "utf8") + Buffer.byteLength(file.after ?? "", "utf8"), 0) > snapshotByteBudget) {
    return { schemaVersion: 1, state: "unavailable", reason: "Historical diff snapshot exceeds its storage budget." };
  }
  return { schemaVersion: 1, state: "exact", files };
}

/** Same domain-separated hash as durable workspace mutation records, including absent files. */
export function hashReviewContent(content: string | null): string {
  const hash = createHash("sha256");
  if (content === null) hash.update("missing\\0", "utf8");
  else { hash.update("text\\0", "utf8"); hash.update(content, "utf8"); }
  return hash.digest("hex");
}
