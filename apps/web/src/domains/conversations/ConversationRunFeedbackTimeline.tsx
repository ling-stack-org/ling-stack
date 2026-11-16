import { useEffect, useMemo, useRef, useState } from "react";
import type { RunEventEnvelope } from "@ling-stack/contracts";
import { daemonBaseUrl } from "../../api/client.js";
import { getRunEvents } from "../../api/runs.js";
import { useI18n } from "../../i18n.js";
import { isDaemonObservationPausedForWorkspace, useDaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";
import { mountConversationTimeline, type ConversationTimelineMountInput } from "../../shared/conversation/timeline/mountConversationTimeline.js";
import { conversationFeedbackReadTargets, projectConversationFeedbackSnapshot } from "./run-feedback.js";

export function mountConversationRunFeedbackTimeline(timeline: ConversationTimelineMountInput): { readonly node: React.ReactNode } {
  return { node: <ConversationRunFeedbackTimeline timeline={timeline} /> };
}

/** Journal hydration belongs to the scoped surface adapter, not the renderer. */
function ConversationRunFeedbackTimeline({ timeline }: { readonly timeline: ConversationTimelineMountInput }): React.JSX.Element {
  const { t } = useI18n();
  const { snapshot } = timeline;
  const cwd = timeline.cwd?.trim() ?? "";
  const observation = useDaemonObservation();
  const paused = isDaemonObservationPausedForWorkspace(observation, cwd);
  const owner = JSON.stringify([daemonBaseUrl, observation.baseUrl, cwd, snapshot.scope]);
  const targets = conversationFeedbackReadTargets(snapshot);
  const readKey = JSON.stringify([owner, observation.epoch, observation.workspaceCwd, paused,
    targets.map(runId => [runId, snapshot.runLifecycles?.get(runId)?.status])]);
  const latest = useRef(readKey);
  latest.current = readKey;
  const [journal, setJournal] = useState<{ readonly owner: string; readonly events: ReadonlyMap<string, readonly RunEventEnvelope[]> }>({ owner, events: new Map() });

  useEffect(() => {
    if (!cwd || paused || !targets.length) return;
    let cancelled = false;
    let timer: number | undefined;
    const completedReads = new Set<string>();
    const current = (): boolean => !cancelled && latest.current === readKey;
    const refresh = async (): Promise<void> => {
      for (const runId of targets) {
        if (!current()) return;
        if (completedReads.has(runId)) continue;
        try {
          const response = await getRunEvents(runId, cwd);
          if (!current()) return;
          if (response.runId !== runId || response.events.some(event => event.runId !== runId)) continue;
          setJournal(previous => {
            const events = new Map(previous.owner === owner ? previous.events : []);
            events.set(runId, response.events);
            return { owner, events };
          });
          if (snapshot.runLifecycles?.get(runId)?.status === "failed") completedReads.add(runId);
        } catch {
          // A journal read failure is not a model execution failure.
        }
      }
      if (current() && completedReads.size < targets.length) timer = window.setTimeout(() => void refresh(), 750);
    };
    void refresh();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [readKey]);

  const projected = useMemo(() => projectConversationFeedbackSnapshot(snapshot,
    journal.owner === owner ? journal.events : new Map(), t), [snapshot, journal, owner, t]);
  return <>{mountConversationTimeline({ ...timeline, snapshot: projected }).node}</>;
}
