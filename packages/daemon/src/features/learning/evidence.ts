import { createHash } from "node:crypto";
import { redactSecrets, DEFAULT_WORKSPACE_ID, type RunStore, type LearningEvidenceBundle, type LearningEvidenceItem } from "@ling-stack/core";
import { resolveAutomaticMemoryRecallScope } from "../memory/recall-service.js";
import { isRecord } from "../../shared/validation.js";

/** Only selected durable lineage is read. A bounded window is explicit, never a claim of complete evidence. */
export function captureLearningEvidence(store: RunStore, runId: string, correction?: string): LearningEvidenceBundle {
  const run = store.getRun(runId);
  if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new Error("learning_source_not_terminal");
  const scope = resolveAutomaticMemoryRecallScope(store, { runId, query: "", intent: "task-run" });
  if (!scope) throw new Error("learning_source_scope_unavailable");
  const task = scope.taskId ? store.getTask(scope.taskId) : undefined;
  const turn = task ? undefined : store.getLingTurnForRun(run.id);
  if (!task && (!turn || !["succeeded", "failed", "cancelled"].includes(turn.status))) throw new Error("learning_source_turn_unavailable");
  const selectedSkillRevisionId = sourceSkillRevisionId(store, run.selectedSkillId, run.requestSnapshot);
  if (correction?.trim() && run.selectedSkillId && !selectedSkillRevisionId) throw new Error("learning_skill_provenance_unavailable");
  const unit = run.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
  const eventCount = store.countEvents(run.id);
  const events = store.listEvents(run.id, { afterSeq: Math.max(0, eventCount - 62), limit: 62 });
  const items: LearningEvidenceItem[] = [];
  const missing: string[] = eventCount > 62 ? ["earlier_events_omitted"] : [];
  if (run.selectedSkillId && !selectedSkillRevisionId) missing.push("skill_provenance_unavailable");
  let available = 6000;
  const append = (item: Omit<LearningEvidenceItem, "text">, value: unknown, maxBytes: number): void => {
    const redacted = redactSecrets(value);
    const text = clipUtf8(item.kind === "correction" && typeof redacted === "string" ? redacted : JSON.stringify(redacted), Math.min(maxBytes, available));
    if (!text) { missing.push(`omitted:${item.id}`); return; }
    available -= Buffer.byteLength(text);
    items.push({ ...item, text });
  };
  if (task) append({ id: `task:${task.id}`, kind: "task", verified: false }, { title: task.title, prompt: task.prompt }, 1200);
  else if (turn) append({ id: `turn:${turn.id}`, kind: "turn", verified: false }, { title: turn.title, prompt: turn.userInstruction }, 1200);
  if (correction?.trim()) append({ id: `correction:${run.id}`, kind: "correction", verified: false }, correction.trim(), 1200);
  for (const event of events) {
    if (!["tool_start", "tool_end", "run_end", "message_end"].includes(event.type)) continue;
    if (event.type === "message_end" && event.data.role !== undefined && event.data.role !== "assistant") continue;
    append({ id: event.id, kind: event.type === "message_end" ? "assistant_message" : event.type as LearningEvidenceItem["kind"],
      verified: event.type === "tool_end" && event.data.isError === false }, event.data, 600);
  }
  const basis = { schemaVersion: 1 as const, workspaceId: scope.workspaceId ?? DEFAULT_WORKSPACE_ID,
    runId: run.id, taskId: task?.id, turnId: turn?.id, channelId: scope.channelId, teammateId: scope.teammateId,
    sourceAttemptId: unit?.activeAttemptId, selectedSkillId: run.selectedSkillId,
    selectedSkillRevisionId, taskUpdatedAt: task?.updatedAt,
    ...(turn ? { turnUpdatedAt: turn.updatedAt } : {}),
    runStatus: run.status as LearningEvidenceBundle["runStatus"], sourceUpdatedAt: run.updatedAt, eventCount, items, missing };
  return { ...basis, digest: createHash("sha256").update(JSON.stringify(basis)).digest("hex") };
}

/** A confirmed decision is an independent source; it need not invent a task or Run. */
export function captureDecisionLearningEvidence(store: RunStore, decisionId: string): LearningEvidenceBundle {
  const decision = store.getChannelDecision(decisionId);
  if (!decision || decision.status !== "active" || decision.createdBy !== "local-user") throw new Error("learning_decision_unconfirmed");
  const channel = store.getChannel(decision.channelId);
  if (!channel || channel.status === "archived" || channel.workspaceId !== decision.workspaceId) throw new Error("learning_source_scope_unavailable");
  // Read only the selected decision, never referenced cross-scope raw conversations.
  const text = clipUtf8(JSON.stringify(redactSecrets({ title: decision.title, decision: decision.decision,
    rationale: decision.rationale, alternatives: decision.alternatives })), 6000);
  const basis = { schemaVersion: 1 as const, workspaceId: decision.workspaceId, decisionId: decision.id,
    channelId: decision.channelId, runStatus: "succeeded" as const, sourceUpdatedAt: decision.updatedAt,
    eventCount: 1, items: [{ id: `decision:${decision.id}`, kind: "decision" as const, text, verified: false }], missing: [] };
  return { ...basis, digest: createHash("sha256").update(JSON.stringify(basis)).digest("hex") };
}

export function learningEvidenceCurrent(store: RunStore, evidence: LearningEvidenceBundle): boolean {
  try {
    // Keep the Run's revision immutable while invalidating work whose target definition has since changed.
    if (evidence.selectedSkillRevisionId && (!evidence.selectedSkillId ||
      store.getSkillDefinitionRevision(evidence.selectedSkillId)?.id !== evidence.selectedSkillRevisionId)) return false;
    const correction = evidence.items.find(item => item.kind === "correction");
    const text = correction?.text;
    return (evidence.decisionId ? captureDecisionLearningEvidence(store, evidence.decisionId) :
      evidence.runId ? captureLearningEvidence(store, evidence.runId, text) : undefined)?.digest === evidence.digest;
  } catch { return false; }
}

/** Historical Runs without a verified frozen snapshot cannot acquire today's definition as provenance. */
function sourceSkillRevisionId(store: RunStore, skillId: string | undefined, requestSnapshot: unknown): string | undefined {
  if (!skillId || !isRecord(requestSnapshot) || !isRecord(requestSnapshot.skillDefinitionSnapshot)) return undefined;
  const snapshot = requestSnapshot.skillDefinitionSnapshot;
  if (snapshot.skillId !== skillId || typeof snapshot.revisionId !== "string" || !snapshot.revisionId ||
    typeof snapshot.definitionHash !== "string") return undefined;
  const revision = store.getSkillDefinitionRevision(skillId, snapshot.revisionId);
  if (!revision || revision.skillId !== skillId || snapshot.definitionHash !==
    `sha256:${createHash("sha256").update(JSON.stringify(revision.afterDefinition)).digest("hex")}`) return undefined;
  return revision.id;
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
