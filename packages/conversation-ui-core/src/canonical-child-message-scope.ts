import type { CanonicalConversationItem, CanonicalExecutionAction, CanonicalTranscriptDiagnostic, CanonicalTranscriptScope } from "./canonical-transcript-projector.js";
import type { ConversationTimelineMessageItem } from "./transcript-item.js";

type ChildMessageLineage = Pick<ConversationTimelineMessageItem, "runId" | "attemptId" | "participantId" | "workflowStepId">;
type Resolution = { readonly lineage: ChildMessageLineage } | { readonly diagnostic: CanonicalTranscriptDiagnostic };

/** A shared turn is context, not ownership. Resolve child prose from explicit Host run refs. */
export function createCanonicalChildMessageResolver(
  scope: CanonicalTranscriptScope,
  actions: readonly CanonicalExecutionAction[],
): (item: CanonicalConversationItem) => Resolution {
  const ownedActions = actions.filter((action) => action.runId === scope.runId
    && action.workspaceId === scope.workspaceId && action.threadId === scope.threadId);
  const attempts = new Set(ownedActions.flatMap((action) => action.attemptId ? [action.attemptId] : []));
  const participants = new Set(ownedActions.flatMap((action) => action.participantId ? [action.participantId] : []));
  const steps = new Set(ownedActions.flatMap((action) => action.workflowStepId ? [action.workflowStepId] : []));
  return (item) => {
    const reject = (code: CanonicalTranscriptDiagnostic["code"], reason: string): Resolution => ({
      diagnostic: { code, sourceRefs: [{ kind: "conversation_item", id: item.id }], message: `Child message ${item.id}: ${reason}` },
    });
    const runIds = new Set(item.domainRefs?.filter((ref) => ref.type === "run").map((ref) => ref.id));
    if (runIds.size === 0) return reject("missing_lineage", "no explicit Run owner.");
    if (runIds.size !== 1) return reject("owner_conflict", "multiple Run owners.");
    const runId = [...runIds][0]!;
    if (runId !== scope.runId || (scope.turnId && item.turnId !== scope.turnId)) {
      return reject("scope_mismatch", "Run or Turn does not match the participant span.");
    }
    const actorId = item.actorType === "teammate" || item.actorType === "ling_agent" ? item.actorId : undefined;
    const ownerIds = new Set([...participants, ...(actorId ? [actorId] : [])]);
    if (ownerIds.size !== 1 || !ownerIds.has(scope.participantId ?? "")) {
      return reject("scope_mismatch", "participant ownership is missing or conflicting.");
    }
    if (attempts.size > 1 || (scope.attemptId && !attempts.has(scope.attemptId))) {
      return reject("scope_mismatch", "attempt ownership is missing or conflicting.");
    }
    return { lineage: {
      runId,
      participantId: [...ownerIds][0],
      ...(attempts.size === 1 ? { attemptId: [...attempts][0] } : {}),
      ...(steps.size === 1 ? { workflowStepId: [...steps][0] } : {}),
    } };
  };
}
