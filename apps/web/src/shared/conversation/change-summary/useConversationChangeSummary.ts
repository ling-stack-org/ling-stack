import { useEffect, useMemo, useState } from "react";
import type { ThreadWorkspaceChangeSummaryResponse } from "@ling-stack/contracts";
import { daemonBaseUrl, getThreadWorkspaceChangeSummary } from "../../../api.js";
import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../observation/daemon-observation.js";
import { createChangeSummaryObserver } from "./change-summary-observer.js";

export const conversationChangeSummaryUpdated = "ling:conversation-change-summary-updated";
export interface ConversationChangeSummaryUpdate {
  readonly cwd: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: string;
}

export function useConversationChangeSummary(options: {
  readonly cwd: string;
  readonly threadId?: string;
  readonly active: boolean;
  readonly submitting: boolean;
}): ThreadWorkspaceChangeSummaryResponse | undefined {
  const { active, submitting, threadId } = options;
  const cwd = options.cwd.trim();
  const observation = useDaemonObservation();
  const paused = isDaemonObservationPausedForWorkspace(observation, cwd);
  // An identity token also separates successive submit transitions in the same thread.
  const identity = useMemo(() => ({}), [daemonBaseUrl, cwd, threadId, observation.epoch, submitting]);
  const [state, setState] = useState<{ identity: object; response?: ThreadWorkspaceChangeSummaryResponse }>();
  const response = !submitting && !paused && state?.identity === identity ? state.response : undefined;

  useEffect(() => {
    if (!cwd || !threadId || submitting || paused) return;
    const observer = createChangeSummaryObserver({
      active,
      read: async () => {
        const result = await getThreadWorkspaceChangeSummary(cwd, threadId);
        if (result.cwd !== cwd || result.threadId !== threadId || result.review &&
          (result.review.threadId !== threadId || result.review.scope.kind !== "turn" || result.review.scope.id !== result.turn?.id)) {
          throw new Error("Change summary does not match the requested conversation.");
        }
        return result;
      },
      publish: (result) => setState({ identity, response: result }),
    });
    observer.setPaused(document.visibilityState === "hidden");
    observer.refresh();
    const invalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || detail.cwd.trim() === cwd) observer.invalidate();
    };
    const visibility = () => observer.setPaused(document.visibilityState === "hidden");
    window.addEventListener("ling:work-summary-invalidated", invalidate);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.dispose();
      window.removeEventListener("ling:work-summary-invalidated", invalidate);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [cwd, threadId, identity, active, submitting, paused]);

  const revision = response?.review?.revision;
  const turnId = response?.turn?.id;
  useEffect(() => {
    if (threadId && turnId && revision) window.dispatchEvent(new CustomEvent<ConversationChangeSummaryUpdate>(conversationChangeSummaryUpdated, {
      detail: { cwd, threadId, turnId, revision },
    }));
  }, [cwd, threadId, turnId, revision]);
  return response;
}
