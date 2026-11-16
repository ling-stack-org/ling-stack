import { useEffect, useMemo, useRef, useState } from "react";
import { LingDaemonError } from "@ling-stack/api-client";
import type { WorkflowConflictRecoveryRequest, WorkflowConflictRecoveryResponse } from "@ling-stack/contracts";
import { getChannelWorkflowConflictRecovery, orchestrateChannelWorkflow, recoverChannelWorkflowConflict } from "../../api/channels.js";
import type { ChannelWorkflow } from "../../types.js";
import { canRetryWorkflowConflictRecoveryPlanning, validWorkflowRepairInstruction, workflowConflictRecoveryRequest } from "../../lib/workflow-conflict-recovery.js";
import { workflowConflictRecoveryRound, type WorkflowIsolationObservation } from "../../lib/workflow-isolation-evidence.js";
import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";

export const WORKFLOW_RECOVERY_TIMEOUT_MS = 15_000;
type Phase = "checking" | "editing" | "creating" | "unknown" | "retry" | "planning" | "ready" | "starting" | "started" | "unavailable";
interface Owner { readonly cwd: string; readonly channelId: string; readonly threadId?: string }
interface Transport { readonly epoch: number; readonly baseUrl: string; readonly connected: boolean }
interface Session {
  readonly owner: Owner;
  readonly token: object;
  readonly transport: Transport;
  readonly workflow: ChannelWorkflow;
  readonly round: Pick<WorkflowConflictRecoveryRequest, "roundId" | "generation" | "expectedRevision">;
  readonly instruction: string;
  readonly request?: WorkflowConflictRecoveryRequest;
  readonly response?: WorkflowConflictRecoveryResponse;
  readonly phase: Phase;
  readonly error?: string;
}
interface Operation { readonly token: object; readonly owner: Owner; readonly transport: Transport }

/** View ownership fences responses; only explicit commands can create, retry or start a repair. */
export function useWorkflowConflictRecovery(input: {
  readonly cwd: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly enabled: boolean;
  readonly workflows: readonly ChannelWorkflow[];
  readonly observations: ReadonlyMap<string, WorkflowIsolationObservation>;
  readonly onChanged: () => void;
}) {
  const observation = useDaemonObservation();
  const cwd = input.cwd.trim();
  const connected = input.enabled && !isDaemonObservationPausedForWorkspace(observation, cwd);
  const owner = useMemo<Owner>(() => ({ cwd, channelId: input.channelId, threadId: input.threadId }), [cwd, input.channelId, input.threadId]);
  const transport = useMemo<Transport>(() => ({ epoch: observation.epoch, baseUrl: observation.baseUrl, connected }), [observation.epoch, observation.baseUrl, connected]);
  const [snapshot, setSnapshot] = useState<Session>();
  const sessionRef = useRef<Session | undefined>(undefined);
  const ownerRef = useRef(owner), transportRef = useRef(transport), latest = useRef(input);
  const operationRef = useRef<Operation | undefined>(undefined);
  const mounted = useRef(true);
  const pendingDeadlines = useRef(new Set<() => void>());
  ownerRef.current = owner;
  transportRef.current = transport;
  latest.current = input;
  if (sessionRef.current?.owner !== owner) sessionRef.current = undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationRef.current = undefined;
      for (const cancel of pendingDeadlines.current) cancel();
    };
  }, []);

  function publish(session: Session): void { sessionRef.current = session; setSnapshot(session); }
  function current(operation: Operation): boolean {
    return mounted.current && ownerRef.current === operation.owner && transportRef.current === operation.transport
      && sessionRef.current?.token === operation.token && operationRef.current === operation;
  }
  function begin(session: Session, phase: Phase): Operation | undefined {
    if (!mounted.current || ownerRef.current !== owner || sessionRef.current?.token !== session.token
      || transportRef.current !== transport || !transport.connected
      || operationRef.current?.token === session.token && operationRef.current.transport === transport) return;
    const operation = { token: session.token, owner, transport };
    operationRef.current = operation;
    publish({ ...session, transport, phase, error: undefined });
    return operation;
  }
  async function bounded<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    try {
      return await Promise.race([request, new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("workflow_recovery.result_unconfirmed"));
        pendingDeadlines.current.add(cancel);
        timer = setTimeout(cancel, WORKFLOW_RECOVERY_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(timer); pendingDeadlines.current.delete(cancel); }
  }
  function finish(operation: Operation): void { if (operationRef.current === operation) operationRef.current = undefined; }
  function accept(session: Session, response: WorkflowConflictRecoveryResponse): Session {
    const request = workflowConflictRecoveryRequest(response, session.workflow, session.round, session.request);
    return { ...session, transport, request, response, instruction: request.repairInstruction, phase: response.phase, error: undefined };
  }

  async function read(session: Session): Promise<void> {
    const operation = begin(session, "checking");
    if (!operation) return;
    try {
      const response = await bounded(getChannelWorkflowConflictRecovery(owner.cwd, session.workflow.id));
      if (!current(operation)) return;
      publish(accept(session, response));
      latest.current.onChanged();
    } catch (error) {
      if (!current(operation)) return;
      const absent = error instanceof LingDaemonError && error.status === 404 && error.code === "workflow_recovery.not_found";
      const editable = !session.request && workflowConflictRecoveryRound(session.workflow, latest.current.observations.get(session.workflow.id))
        && ["blocked", "running"].includes(session.workflow.status);
      publish({ ...session, transport, phase: absent ? session.request ? "retry" : editable ? "editing" : "unavailable" : "unknown",
        error: absent ? undefined : error instanceof Error ? error.message : String(error) });
    } finally { finish(operation); }
  }

  async function write(session: Session): Promise<void> {
    if (!session.request) return;
    const operation = begin(session, "creating");
    if (!operation) return;
    try {
      const response = await bounded(recoverChannelWorkflowConflict(owner.cwd, session.workflow.id, session.request));
      if (!current(operation)) return;
      publish(accept(session, response));
      latest.current.onChanged();
    } catch (error) {
      if (current(operation)) publish({ ...session, transport, phase: "unknown", error: error instanceof Error ? error.message : String(error) });
    } finally { finish(operation); }
  }

  async function open(workflowId: string, roundId: string, generation: number, revision: number): Promise<void> {
    if (ownerRef.current !== owner || transportRef.current !== transport || !connected || !cwd || !owner.channelId) return;
    const workflow = latest.current.workflows.find(value => value.id === workflowId && value.channelId === owner.channelId);
    const round = workflow && workflowConflictRecoveryRound(workflow, latest.current.observations.get(workflowId));
    if (!workflow || !round || round.roundId !== roundId || round.generation !== generation || round.revision !== revision) return;
    if (sessionRef.current) return;
    const session: Session = { owner, transport, token: {}, workflow,
      round: { roundId, generation, expectedRevision: revision }, instruction: "", phase: "checking" };
    publish(session);
    await read(session);
  }

  function close(): void {
    if (ownerRef.current !== owner) return;
    sessionRef.current = undefined;
    operationRef.current = undefined;
    setSnapshot(undefined);
  }
  function setInstruction(instruction: string): void {
    const session = sessionRef.current;
    if (ownerRef.current === owner && session && session.phase === "editing" && !session.request && session.transport === transport) {
      publish({ ...session, instruction });
    }
  }
  async function submit(): Promise<void> {
    if (ownerRef.current !== owner || transportRef.current !== transport || !connected) return;
    const session = sessionRef.current;
    if (!session || session.transport !== transport || session.phase !== "editing" || session.request || !validWorkflowRepairInstruction(session.instruction)) return;
    const workflow = latest.current.workflows.find(value => value.id === session.workflow.id);
    const round = workflow && workflowConflictRecoveryRound(workflow, latest.current.observations.get(workflow.id));
    if (!workflow || !["blocked", "running"].includes(workflow.status) || !round || round.roundId !== session.round.roundId
      || round.generation !== session.round.generation || round.revision !== session.round.expectedRevision) {
      publish({ ...session, phase: "unavailable", error: "workflow_recovery.predecessor_changed" });
      return;
    }
    const request = Object.freeze({ ...session.round, idempotencyKey: globalThis.crypto.randomUUID(), repairInstruction: session.instruction });
    const next = { ...session, request };
    publish(next);
    await write(next);
  }
  async function check(): Promise<void> {
    const session = sessionRef.current;
    if (session) await read(session);
  }
  async function retry(): Promise<void> {
    const session = sessionRef.current;
    if (session && session.transport === transport && canRetryWorkflowConflictRecoveryPlanning(session.phase, session.response)) await write(session);
  }
  async function start(): Promise<void> {
    const session = sessionRef.current;
    if (!session || session.transport !== transport || session.phase !== "ready" || !session.response
      || session.response.workflow.status !== "ready" || session.response.workflowSteps.some(step => step.status !== "queued" || step.runId || step.taskId)) return;
    const operation = begin(session, "starting");
    if (!operation) return;
    try {
      const response = await bounded(orchestrateChannelWorkflow(owner.cwd, session.response.workflow.id, { executionProfile: "pi_host_isolated_files_v1" }));
      if (!current(operation)) return;
      if (response.workflow.id !== session.response.workflow.id || response.workflow.channelId !== owner.channelId
        || response.workflow.workspaceId !== session.workflow.workspaceId) throw new Error("workflow_recovery.response_unverified");
      const error = response.status === "blocked" || response.status === "failed" ? response.blocker
        : response.status === "idle" ? response.reason : undefined;
      publish({ ...session, transport, phase: "started", error });
      latest.current.onChanged();
    } catch (error) {
      if (current(operation)) publish({ ...session, transport, phase: "unknown", error: error instanceof Error ? error.message : String(error) });
    } finally { finish(operation); }
  }

  const session = snapshot?.owner === owner ? snapshot : undefined;
  const phase: Phase | undefined = session && (session.transport === transport ? session.phase : "unknown");
  const busy = Boolean(phase && ["checking", "creating", "starting"].includes(phase));
  return { session, phase, busy, connected, open, close, setInstruction, submit, check, retry, start };
}

export type WorkflowConflictRecoveryController = ReturnType<typeof useWorkflowConflictRecovery>;
