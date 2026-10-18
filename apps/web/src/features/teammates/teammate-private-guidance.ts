import { createTeammateDirectIntervention, listTeammateDirectInterventions } from "../../api.js";
import { guidanceLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";
import { resolveGuidanceSubmission } from "../../shared/conversation/conversation-submission-recovery.js";
import type { CreateTeammateDirectReplyInterventionRequest, TeammateDirectReplyIntervention, TeammateDirectRuntimeResponse } from "../../types.js";

export function hasPendingPrivateGuidance(cwd: string, teammateId: string): boolean {
  try { return Boolean(guidanceLookupJournal.read({ cwd, surface: "private", ownerId: teammateId })); }
  catch { return true; }
}

export async function submitPrivateGuidance(input: {
  readonly cwd: string;
  readonly teammateId: string;
  readonly threadId?: string;
  readonly sourceWorkUnitId?: string;
  readonly request: Omit<CreateTeammateDirectReplyInterventionRequest, "idempotencyKey">;
  readonly notReadyMessage: string;
  readonly onSubmitting: () => void;
}) {
  let runtime: TeammateDirectRuntimeResponse | undefined;
  const result = await resolveGuidanceSubmission<TeammateDirectReplyIntervention>({
    scope: { cwd: input.cwd, surface: "private", ownerId: input.teammateId },
    journal: guidanceLookupJournal,
    prepare: () => {
      if (!input.sourceWorkUnitId || !input.threadId) throw new Error(input.notReadyMessage);
      return { key: `web-direct-guidance:${crypto.randomUUID()}`, sourceId: input.sourceWorkUnitId,
        threadId: input.threadId, mode: input.request.mode };
    },
    create: async record => {
      input.onSubmitting();
      const response = await createTeammateDirectIntervention(input.cwd, input.teammateId, { ...input.request, idempotencyKey: record.key });
      const item = response.intervention;
      if (response.cwd !== input.cwd || item.idempotencyKey !== record.key || item.mode !== record.mode
        || item.sourceWorkUnitId !== record.sourceId || item.threadId !== record.threadId || item.teammateId !== input.teammateId) {
        throw new Error("Guidance receipt scope mismatch");
      }
      runtime = response.runtime;
      return item;
    },
    read: async record => {
      const response = await listTeammateDirectInterventions(input.cwd, input.teammateId, record.key);
      if (response.cwd !== input.cwd || response.teammateId !== input.teammateId || response.thread.id !== record.threadId
        || response.idempotencyKey !== record.key || response.interventions.length > 1
        || response.interventions.some(item => item.teammateId !== input.teammateId || item.threadId !== record.threadId
          || item.sourceWorkUnitId !== record.sourceId || item.mode !== record.mode || item.idempotencyKey !== record.key)) {
        throw new Error("Guidance receipt scope mismatch");
      }
      const intervention = response.interventions[0];
      return intervention ? { status: "accepted", intervention } : { status: "unknown" };
    },
  });
  return { ...result, runtime };
}
