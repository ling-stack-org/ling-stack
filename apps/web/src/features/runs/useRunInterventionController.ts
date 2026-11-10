import { useEffect, useRef, useState } from "react";
import {
  cancelRunIntervention,
  createRunIntervention,
  listRunInterventions,
  promoteRunIntervention,
} from "../../api.js";
import type { RunIntervention, RunSession } from "../../types.js";
import { guidanceLookupJournal, type GuidanceLookupScope } from "../../shared/conversation/conversation-submission-journal.js";
import { resolveGuidanceSubmission } from "../../shared/conversation/conversation-submission-recovery.js";

export function useRunInterventionController(input: {
  readonly cwd: string;
  readonly run: RunSession;
  readonly onRefreshRun: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [interventions, setInterventions] = useState<readonly RunIntervention[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "stale" | "failed">("loading");
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const busyRef = useRef(new Set<string>());
  const requestRevisionRef = useRef(0);
  const sourceRunId = input.run.parentRunId ?? input.run.id;
  const identity = `${input.cwd.trim()}::${sourceRunId}`;
  const ownerRef = useRef({ identity, revision: 0 });
  if (ownerRef.current.identity !== identity) ownerRef.current = { identity, revision: ownerRef.current.revision + 1 };
  const scope: GuidanceLookupScope = { cwd: input.cwd.trim(), surface: "run", ownerId: sourceRunId };
  let pendingConfirmation = false;
  let pendingMode: RunIntervention["mode"] | undefined;
  try {
    const pending = guidanceLookupJournal.read(scope);
    pendingConfirmation = Boolean(pending);
    pendingMode = pending?.mode;
  } catch { pendingConfirmation = true; }

  useEffect(() => {
    requestRevisionRef.current += 1;
    busyRef.current.clear();
    setBusyKeys(new Set());
    setInstruction("");
    setInterventions([]);
    setErrors({});
    setLoadState("loading");
    void loadInterventions(false);
    return () => { ownerRef.current = { ...ownerRef.current, revision: ownerRef.current.revision + 1 }; };
    // identity reset owns initial request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.cwd, sourceRunId]);

  async function loadInterventions(retain = true): Promise<void> {
    const owner = ownerRef.current;
    const key = "refresh";
    if (!begin(key)) return;
    const revision = ++requestRevisionRef.current;
    setErrors((current) => omitKey(current, key));
    if (!retain) setLoadState("loading");
    try {
      const response = await listRunInterventions(input.cwd.trim(), sourceRunId, 100);
      if (ownerRef.current !== owner || requestRevisionRef.current !== revision) return;
      setInterventions(response.interventions);
      setLoadState("ready");
    } catch (error) {
      if (ownerRef.current !== owner || requestRevisionRef.current !== revision) return;
      setErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }));
      setLoadState(interventions.length > 0 && retain ? "stale" : "failed");
    } finally {
      if (ownerRef.current === owner && requestRevisionRef.current === revision) end(key);
    }
  }

  async function create(mode: RunIntervention["mode"]): Promise<void> {
    const trimmed = instruction.trim();
    const key = `create:${pendingMode ?? mode}`;
    if (!pendingConfirmation && !trimmed) {
      setErrors((current) => ({ ...current, [key]: "missing_instruction" }));
      return;
    }
    if ([...busyRef.current].some(candidate => candidate.startsWith("create:"))) return;
    await runMutation(key, async commit => {
      const { intervention, queryOnly } = await resolveGuidanceSubmission<RunIntervention>({
        scope,
        journal: guidanceLookupJournal,
        prepare: () => ({ key: `web-guidance:${crypto.randomUUID()}`, sourceId: sourceRunId,
          threadId: input.run.threadId ?? sourceRunId, mode }),
        create: async record => {
          const response = await createRunIntervention(scope.cwd, record.sourceId, {
            mode: record.mode, instruction: trimmed, idempotencyKey: record.key,
          });
          if (response.cwd !== scope.cwd || response.intervention.sourceRunId !== record.sourceId
            || response.intervention.idempotencyKey !== record.key || response.intervention.mode !== record.mode) {
            throw new Error("Guidance receipt scope mismatch");
          }
          return response.intervention;
        },
        read: async record => {
          const response = await listRunInterventions(scope.cwd, record.sourceId, 1, record.key);
          if (response.cwd !== scope.cwd || response.idempotencyKey !== record.key || response.interventions.length > 1
            || response.interventions.some(item => item.sourceRunId !== record.sourceId || item.idempotencyKey !== record.key || item.mode !== record.mode)) {
            throw new Error("Guidance receipt scope mismatch");
          }
          return response.interventions[0] ? { status: "accepted", intervention: response.interventions[0] } : { status: "unknown" };
        },
      });
      commit(() => {
        setInterventions((current) => upsertIntervention(current, intervention));
        setInstruction(current => current.trim() === (queryOnly ? intervention.instruction.trim() : trimmed) ? "" : current);
        setErrors(current => omitKey(omitKey(current, "create:queue_followup"), "create:interrupt_redirect"));
        input.onRefreshRun();
      });
    });
  }

  async function cancel(interventionId: string): Promise<void> {
    await runMutation(`cancel:${interventionId}`, async commit => {
      const response = await cancelRunIntervention(input.cwd.trim(), interventionId);
      commit(() => setInterventions((current) => upsertIntervention(current, response.intervention)));
    });
  }

  async function promote(interventionId: string): Promise<void> {
    await runMutation(`promote:${interventionId}`, async commit => {
      const response = await promoteRunIntervention(input.cwd.trim(), interventionId);
      commit(() => {
        setInterventions((current) => upsertIntervention(current, response.intervention));
        input.onRefreshRun();
      });
    });
  }

  async function runMutation(key: string, operation: (commit: (update: () => void) => void) => Promise<void>): Promise<void> {
    if (!begin(key)) return;
    const owner = ownerRef.current;
    setErrors((current) => omitKey(current, key));
    try {
      await operation(update => { if (ownerRef.current === owner) update(); });
    } catch (error) {
      if (ownerRef.current === owner) {
        setErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (ownerRef.current === owner) end(key);
    }
  }

  function begin(key: string): boolean {
    if (busyRef.current.has(key)) return false;
    busyRef.current.add(key);
    setBusyKeys(new Set(busyRef.current));
    return true;
  }

  function end(key: string): void {
    busyRef.current.delete(key);
    setBusyKeys(new Set(busyRef.current));
  }

  return {
    state: {
      instruction,
      interventions: interventions.filter((item) => item.sourceRunId === sourceRunId),
      loadState,
      busyKeys,
      errors,
      sourceRunId,
      pendingConfirmation,
    },
    actions: { setInstruction, loadInterventions, create, cancel, promote },
  };
}

function upsertIntervention(current: readonly RunIntervention[], intervention: RunIntervention): readonly RunIntervention[] {
  return [...current.filter((item) => item.id !== intervention.id), intervention]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function omitKey(input: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(input).filter(([candidate]) => candidate !== key));
}
