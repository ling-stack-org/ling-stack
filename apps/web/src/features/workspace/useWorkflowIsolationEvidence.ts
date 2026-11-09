import { useEffect, useMemo, useRef, useState } from "react";
import { getChannelWorkflowEvidence } from "../../api/channels.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "../../types.js";
import { shouldPollWorkflowIsolation, workflowHasIsolationPlan, type WorkflowIsolationObservation } from "../../lib/workflow-isolation-evidence.js";
import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";

export const WORKFLOW_ISOLATION_POLL_LIMIT = 6;
export const WORKFLOW_ISOLATION_POLL_MS = 1_500;
export const WORKFLOW_ISOLATION_READ_TIMEOUT_MS = 15_000;

/** Scoped view reads only. A refresh/SSE invalidation starts a new bounded observation episode. */
export function useWorkflowIsolationEvidence(input: {
  readonly cwd: string;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly workflows: readonly ChannelWorkflow[];
  readonly steps: readonly ChannelWorkflowStep[];
  readonly refreshSignature: string;
  readonly refreshToken: number;
}): ReadonlyMap<string, WorkflowIsolationObservation> {
  const observation = useDaemonObservation();
  const cwd = input.cwd.trim();
  const { channelId, enabled, refreshSignature, refreshToken } = input;
  const paused = isDaemonObservationPausedForWorkspace(observation, cwd);
  const owner = useMemo(() => ({ cwd, channelId, epoch: observation.epoch, baseUrl: observation.baseUrl }),
    [cwd, channelId, observation.epoch, observation.baseUrl]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const selected = input.workflows.filter(workflow => workflow.channelId === channelId);
  const membership = JSON.stringify(selected.map(workflow => [workflow.id, workflow.workspaceId]).sort());
  const episode = useMemo(() => ({}), [owner, membership, enabled, paused, refreshSignature, refreshToken]);
  const currentEpisode = useRef(episode);
  currentEpisode.current = episode;
  const latestInput = useRef(input);
  latestInput.current = input;
  const [snapshot, setSnapshot] = useState<{ readonly owner: typeof owner; readonly entries: ReadonlyMap<string, WorkflowIsolationObservation> }>(
    () => ({ owner, entries: new Map() }),
  );
  const records = useRef(snapshot);

  useEffect(() => {
    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const current = (): boolean => !disposed && currentOwner.current === owner && currentEpisode.current === episode;
    const previous = records.current.owner === owner ? records.current.entries : new Map<string, WorkflowIsolationObservation>();
    const entries = new Map<string, WorkflowIsolationObservation>();
    const workflows = latestInput.current.workflows.filter(workflow => workflow.channelId === channelId);
    for (const workflow of workflows) {
      const before = previous.get(workflow.id);
      entries.set(workflow.id, { status: "loading", expected: before?.expected === true
        || workflowHasIsolationPlan(latestInput.current.steps.filter(step => step.workflowId === workflow.id)), isolation: before?.isolation });
    }
    const publish = (): void => {
      if (!current()) return;
      const next = { owner, entries: new Map(entries) };
      records.current = next;
      setSnapshot(next);
    };
    publish();
    const later = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => { timers.delete(timer); if (current()) callback(); }, delay);
      timers.add(timer);
      return timer;
    };
    const load = async (workflow: ChannelWorkflow, remaining: number): Promise<void> => {
      if (!current()) return;
      let finished = false;
      const complete = (next: WorkflowIsolationObservation, observedWorkflow = workflow): void => {
        if (finished || !current()) return;
        finished = true;
        clearTimeout(deadline);
        timers.delete(deadline);
        entries.set(workflow.id, next);
        publish();
        if (remaining > 0 && shouldPollWorkflowIsolation(next, observedWorkflow)) {
          later(() => { void load(observedWorkflow, remaining - 1); }, WORKFLOW_ISOLATION_POLL_MS);
        }
      };
      const failed = (): void => complete({ ...entries.get(workflow.id)!, status: "error" });
      const deadline = later(failed, WORKFLOW_ISOLATION_READ_TIMEOUT_MS);
      try {
        const response = await getChannelWorkflowEvidence(cwd, workflow.id);
        if (!current() || finished) return;
        if (response.workflow.id !== workflow.id || response.workflow.workspaceId !== workflow.workspaceId || response.workflow.channelId !== channelId) {
          failed();
          return;
        }
        const before = entries.get(workflow.id)!;
        // Retained isolation cannot silently disappear into the ordinary-workflow fallback.
        if (before.expected && !response.isolation) { failed(); return; }
        complete({ status: "loaded", expected: before.expected || Boolean(response.isolation), isolation: response.isolation }, response.workflow);
      } catch {
        failed();
      }
    };
    if (cwd && channelId && enabled && !paused) {
      for (const workflow of workflows) void load(workflow, WORKFLOW_ISOLATION_POLL_LIMIT);
    }
    return () => { disposed = true; for (const timer of timers) clearTimeout(timer); };
  }, [owner, episode]);

  return snapshot.owner === owner ? snapshot.entries : new Map();
}
