import { useEffect, useRef, useState } from "react";
import {
  cancelRunIntervention,
  createRunIntervention,
  listRunInterventions,
  promoteRunIntervention,
} from "../../api.js";
import type { RunIntervention, RunSession } from "../../types.js";

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
  const identityRef = useRef("");
  const sourceRunId = input.run.parentRunId ?? input.run.id;
  identityRef.current = `${input.cwd.trim()}::${sourceRunId}`;

  useEffect(() => {
    requestRevisionRef.current += 1;
    busyRef.current.clear();
    setBusyKeys(new Set());
    setInstruction("");
    setInterventions([]);
    setErrors({});
    setLoadState("loading");
    void loadInterventions(false);
    // identity reset owns initial request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.cwd, sourceRunId]);

  async function loadInterventions(retain = true): Promise<void> {
    const identity = `${input.cwd.trim()}::${sourceRunId}`;
    const revision = ++requestRevisionRef.current;
    const key = "refresh";
    if (!begin(key)) return;
    setErrors((current) => omitKey(current, key));
    if (!retain) setLoadState("loading");
    try {
      const response = await listRunInterventions(input.cwd.trim(), sourceRunId, 100);
      if (identityRef.current !== identity || requestRevisionRef.current !== revision) return;
      setInterventions(response.interventions);
      setLoadState("ready");
    } catch (error) {
      if (identityRef.current !== identity || requestRevisionRef.current !== revision) return;
      setErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }));
      setLoadState(interventions.length > 0 && retain ? "stale" : "failed");
    } finally {
      if (identityRef.current === identity && requestRevisionRef.current === revision) end(key);
    }
  }

  async function create(mode: RunIntervention["mode"]): Promise<void> {
    const trimmed = instruction.trim();
    const key = `create:${mode}`;
    if (!trimmed) {
      setErrors((current) => ({ ...current, [key]: "missing_instruction" }));
      return;
    }
    await runMutation(key, async () => {
      const response = await createRunIntervention(input.cwd.trim(), sourceRunId, {
        mode,
        instruction: trimmed,
        idempotencyKey: `web:${input.run.id}:${mode}:${Date.now()}`,
      });
      setInterventions((current) => upsertIntervention(current, response.intervention));
      setInstruction("");
      input.onRefreshRun();
    });
  }

  async function cancel(interventionId: string): Promise<void> {
    await runMutation(`cancel:${interventionId}`, async () => {
      const response = await cancelRunIntervention(input.cwd.trim(), interventionId);
      setInterventions((current) => upsertIntervention(current, response.intervention));
    });
  }

  async function promote(interventionId: string): Promise<void> {
    await runMutation(`promote:${interventionId}`, async () => {
      const response = await promoteRunIntervention(input.cwd.trim(), interventionId);
      setInterventions((current) => upsertIntervention(current, response.intervention));
      input.onRefreshRun();
    });
  }

  async function runMutation(key: string, operation: () => Promise<void>): Promise<void> {
    if (!begin(key)) return;
    const identity = identityRef.current;
    setErrors((current) => omitKey(current, key));
    try {
      await operation();
    } catch (error) {
      if (identityRef.current === identity) {
        setErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      end(key);
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
