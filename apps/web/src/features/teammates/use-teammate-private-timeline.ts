import { useEffect, useRef, useState } from "react";
import { LingDaemonTransportError } from "@ling-stack/api-client";
import type { CanonicalTranscriptProjection } from "@ling-stack/conversation-ui-core";
import { listTeammateDirectMessages } from "../../api.js";
import { projectConversationDetailTimeline } from "../../domains/conversations/canonical-transcript-snapshot.js";
import { mergeConversationDetailSnapshots } from "../../domains/conversations/conversation-detail-merge.js";
import type { ConversationDetailResponse, LingTurn, LingTurnRun, RunSession } from "../../types.js";
import { privateMessageIdsByCanonicalItemId, privateTimelineResponseIsOwned } from "./teammate-private-timeline-items.js";
import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";

interface PrivateObservationRead {
  readonly cwd: string;
  readonly epoch: number;
  readonly baseUrl: string;
  readonly workspaceCwd: string;
}

/** Only gates observation reads, never accepted commands or their receipts. */
export function useTeammateObservationReads(cwd: string) {
  const observation = useDaemonObservation();
  const latest = useRef({ cwd: cwd.trim(), observation });
  latest.current = { cwd: cwd.trim(), observation };
  return {
    paused: isDaemonObservationPausedForWorkspace(observation, cwd),
    epoch: observation.epoch,
    baseUrl: observation.baseUrl,
    workspaceCwd: observation.workspaceCwd,
    begin(): PrivateObservationRead | undefined {
      const current = latest.current;
      return isDaemonObservationPausedForWorkspace(current.observation, current.cwd) ? undefined
        : { cwd: current.cwd, epoch: current.observation.epoch, baseUrl: current.observation.baseUrl,
          workspaceCwd: current.observation.workspaceCwd };
    },
    isCurrent(read: PrivateObservationRead): boolean {
      const current = latest.current;
      return read.cwd === current.cwd && read.epoch === current.observation.epoch
        && read.baseUrl === current.observation.baseUrl && read.workspaceCwd === current.observation.workspaceCwd
        && !isDaemonObservationPausedForWorkspace(current.observation, current.cwd);
    },
    shouldMergeTransport(error: unknown): boolean {
      const current = latest.current;
      return error instanceof LingDaemonTransportError
        && isDaemonObservationPausedForWorkspace(current.observation, current.cwd);
    },
  };
}

interface PrivateTimelineState {
  readonly owner: string;
  readonly status: "loading" | "loaded" | "error";
  readonly projection?: CanonicalTranscriptProjection;
  readonly messageIds?: ReadonlyMap<string, string>;
  readonly runLinks?: readonly LingTurnRun[];
  readonly turns?: readonly LingTurn[];
  readonly runs?: readonly RunSession[];
  readonly directThreadId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
}

/**
 * Read only the selected teammate's durable transcript. Owner changes hide the
 * old snapshot immediately; late responses cannot overwrite the new owner.
 * A pending first load is distinct from a loaded-but-missing evidence graph.
 */
export function useTeammatePrivateTimeline(input: {
  readonly cwd: string;
  readonly teammateId: string;
  readonly directThreadId?: string;
  readonly refreshKey: string;
  readonly active: boolean;
}): PrivateTimelineState {
  const cwd = input.cwd.trim();
  const observationReads = useTeammateObservationReads(cwd);
  const owner = JSON.stringify([cwd, input.teammateId, input.directThreadId ?? ""]);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [snapshot, setSnapshot] = useState<PrivateTimelineState>({ owner, status: "loading" });
  const activeRef = useRef(input.active);
  const previousActiveRef = useRef(input.active);
  const refreshRef = useRef<((urgent?: boolean) => void) | undefined>(undefined);
  activeRef.current = input.active;
  useEffect(() => {
    // This effect owns a serialized read epoch. Teammate changes/cancellation
    // destroy its cache before another owner can observe any hydrated content.
    let currentDetail: ConversationDetailResponse | undefined;
    let cancelled = false;
    let loading = false;
    let pending = false;
    let urgentPending = false;
    let lastStartedAt = 0;
    let timeout: number | undefined;
    const schedule = (urgent = false): void => {
      if (cancelled || ownerRef.current !== owner || !cwd || !observationReads.begin()) return;
      pending = true;
      urgentPending ||= urgent;
      if (loading) return;
      if (timeout !== undefined) {
        if (!urgentPending) return;
        window.clearTimeout(timeout);
      }
      const delay = urgentPending ? 0 : Math.max(0, 750 - (Date.now() - lastStartedAt));
      timeout = window.setTimeout(() => { timeout = undefined; void refresh(); }, delay);
    };
    const refresh = async (): Promise<void> => {
      const observationRead = observationReads.begin();
      if (loading || cancelled || ownerRef.current !== owner || !cwd || !observationRead) return;
      loading = true;
      pending = false;
      urgentPending = false;
      lastStartedAt = Date.now();
      try {
        const response = await listTeammateDirectMessages(cwd, input.teammateId);
        if (cancelled || ownerRef.current !== owner || !observationReads.isCurrent(observationRead)) return;
        if (!privateTimelineResponseIsOwned(response, input)) {
          currentDetail = undefined;
          setSnapshot({ owner, status: "error" });
          return;
        }
        const detail = response.timeline ? mergeConversationDetailSnapshots(currentDetail, response.timeline) : undefined;
        currentDetail = detail;
        const projection = detail ? projectConversationDetailTimeline(detail, {
          surface: "private", participantId: input.teammateId,
        }) : undefined;
        setSnapshot({
          owner,
          status: "loaded",
          projection,
          messageIds: detail ? privateMessageIdsByCanonicalItemId(detail.conversationItems) : undefined,
          runLinks: detail?.runLinks,
          turns: detail?.turns,
          runs: detail?.runs,
          directThreadId: response.thread.id,
          threadId: detail?.thread.id,
          workspaceId: detail?.thread.workspaceId,
        });
      } catch (error) {
        if (!cancelled && ownerRef.current === owner && !observationReads.shouldMergeTransport(error)) setSnapshot((current) => ({
          ...(current.owner === owner ? current : { owner }),
          status: "error",
        }));
      } finally {
        loading = false;
        if (pending) schedule(urgentPending);
      }
    };
    refreshRef.current = schedule;
    schedule(true);
    const interval = window.setInterval(() => {
      if (activeRef.current && document.visibilityState === "visible") schedule();
    }, 750);
    return () => {
      cancelled = true;
      refreshRef.current = undefined;
      window.clearInterval(interval);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [cwd, input.teammateId, input.directThreadId, owner]);
  useEffect(() => {
    if (!observationReads.paused) refreshRef.current?.(true);
  }, [observationReads.paused, observationReads.epoch, observationReads.baseUrl, observationReads.workspaceCwd, owner]);
  useEffect(() => {
    // Coalesce action/message revisions, but flush terminal state promptly.
    // This does not restart an in-flight request for every streaming token.
    refreshRef.current?.(previousActiveRef.current && !input.active);
    previousActiveRef.current = input.active;
  }, [input.active, input.refreshKey, owner]);
  return snapshot.owner === owner ? snapshot : { owner, status: "loading" };
}
