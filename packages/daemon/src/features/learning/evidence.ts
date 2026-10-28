import { createHash } from "node:crypto";
import { redactSecrets, DEFAULT_WORKSPACE_ID, type RunStore, type LearningEvidenceBundle, type LearningEvidenceItem } from "@ling-stack/core";
import { resolveAutomaticMemoryRecallScope } from "../memory/recall-service.js";

/** Only selected durable lineage is read. A bounded window is explicit, never a claim of complete evidence. */
export function captureLearningEvidence(store: RunStore, runId: string, correction?: string): LearningEvidenceBundle {
  const run = store.getRun(runId);
  if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new Error("learning_source_not_terminal");
  const scope = resolveAutomaticMemoryRecallScope(store, { runId, query: "", intent: "task-run" });
  if (!scope || !scope.taskId) throw new Error("learning_source_scope_unavailable");
  const task = store.getTask(scope.taskId);
  if (!task) throw new Error("learning_source_task_unavailable");
  const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const eventCount = store.countEvents(run.id);
  const events = store.listEvents(run.id, { afterSeq: Math.max(0, eventCount - 62), limit: 62 });
  const items: LearningEvidenceItem[] = [];
  const missing: string[] = eventCount > 62 ? ["earlier_events_omitted"] : [];
  let available = 6000;
  const append = (item: Omit<LearningEvidenceItem, "text">, value: unknown, maxBytes: number): void => {
    const redacted = redactSecrets(value);
    const text = clipUtf8(item.kind === "correction" && typeof redacted === "string" ? redacted : JSON.stringify(redacted), Math.min(maxBytes, available));
    if (!text) { missing.push(`omitted:${item.id}`); return; }
    available -= Buffer.byteLength(text);
    items.push({ ...item, text });
  };
  append({ id: `task:${task.id}`, kind: "task", verified: false }, { title: task.title, prompt: task.prompt }, 1200);
  if (correction?.trim()) append({ id: `correction:${run.id}`, kind: "correction", verified: false }, correction.trim(), 1200);
  for (const event of events) {
    if (!["tool_start", "tool_end", "run_end"].includes(event.type)) continue;
    append({ id: event.id, kind: event.type as LearningEvidenceItem["kind"],
      verified: event.type === "tool_end" && event.data.isError === false }, event.data, 600);
  }
  const basis = { schemaVersion: 1 as const, workspaceId: scope.workspaceId ?? DEFAULT_WORKSPACE_ID,
    runId: run.id, taskId: task.id, channelId: scope.channelId, teammateId: scope.teammateId,
    sourceAttemptId: unit?.activeAttemptId, selectedSkillId: run.selectedSkillId,
    selectedSkillRevisionId: run.selectedSkillId ? store.getSkillDefinitionRevision(run.selectedSkillId)?.id : undefined, taskUpdatedAt: task.updatedAt,
    runStatus: run.status as LearningEvidenceBundle["runStatus"], sourceUpdatedAt: run.updatedAt, eventCount, items, missing };
  return { ...basis, digest: createHash("sha256").update(JSON.stringify(basis)).digest("hex") };
}

export function learningEvidenceCurrent(store: RunStore, evidence: LearningEvidenceBundle): boolean {
  try {
    const correction = evidence.items.find(item => item.kind === "correction");
    const text = correction?.text;
    return captureLearningEvidence(store, evidence.runId, text).digest === evidence.digest;
  } catch { return false; }
}
function clipUtf8(value: string, bytes: number): string {
  if (bytes < 1) return "";
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(result) + Buffer.byteLength(char) > bytes) break;
    result += char;
  }
  return result;
}
