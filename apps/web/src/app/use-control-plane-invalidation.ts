import { useEffect, useRef } from "react";
import { getControlPlaneSnapshot } from "../api/control-plane.js";
import {
  controlPlaneRpcStreamUrl,
  controlPlaneStreamUrl,
  controlPlaneSummaryDomains,
  parseControlPlaneEventMessage,
  parseControlPlaneReplayWindowMessage,
  parseControlPlaneRpcEventMessage,
  parseControlPlaneRpcSubscribeMessage,
} from "../lib/control-plane.js";
import type { ControlPlaneDomain, ControlPlaneReplayWindow, RunSession } from "../types.js";
import {
  domainErrorMessage,
  type FocusedDomainError,
  useFocusedDomainErrorOwner,
} from "./use-focused-domain-error-owner.js";

export type ControlPlaneInvalidationError = FocusedDomainError<"control-plane", string>;

export interface ControlPlaneInvalidationController {
  readonly errors: readonly ControlPlaneInvalidationError[];
  readonly error: ControlPlaneInvalidationError | undefined;
  readonly clearError: () => void;
}

export function useControlPlaneInvalidation(input: {
  readonly daemonBaseUrl: string;
  readonly daemonHealthy: boolean | undefined;
  readonly localWebSocketRpcEnabled: boolean;
  readonly workspaceCwd: string;
  readonly selectedChannelId: string;
  readonly selectedTeammateId: string;
  readonly channelRunsForArtifacts: readonly RunSession[];
  readonly setSkillLibraryRefreshToken: (update: (current: number) => number) => void;
  readonly refreshRuns: (cwd?: string) => Promise<void>;
  readonly refreshSelectedConversation: (cwd?: string) => Promise<void>;
  readonly refreshRuntimeState: (cwd?: string) => Promise<void>;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
  readonly refreshApprovalPolicy: () => Promise<void>;
  readonly refreshProviders: (cwd?: string) => Promise<void>;
  readonly refreshMcp: (cwd?: string) => Promise<void>;
  readonly refreshPlugins: (cwd?: string) => Promise<void>;
  readonly refreshRuntimeSettings: () => Promise<void>;
  readonly refreshAiTeammates: (cwd?: string) => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd?: string) => Promise<void>;
  readonly refreshChannelRunArtifacts: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelExecutionActions: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelActivity: () => Promise<void>;
  readonly refreshSelectedChannelConversation: () => Promise<void>;
  readonly invalidateSelectedTeammateConversation: () => void;
}): ControlPlaneInvalidationController {
  const workspaceIdentity = input.workspaceCwd.trim() || "workspace:unavailable";
  const errorOwner = useFocusedDomainErrorOwner<"control-plane", string>(workspaceIdentity);
  const invalidationRef = useRef<(domains: readonly ControlPlaneDomain[]) => Promise<void>>(async () => undefined);
  invalidationRef.current = async (domains) => {
    const workspaceCwd = input.workspaceCwd;
    if (!workspaceCwd) {
      return;
    }
    const changed = new Set(domains);
    if (domains.some((domain) => ["runs", "work_units", "approvals", "artifacts", "channels", "teammates"].includes(domain))) {
      window.dispatchEvent(new CustomEvent("ling:work-summary-invalidated", { detail: { cwd: workspaceCwd } }));
    }

    const refreshes: Promise<unknown>[] = [];
    const trackRefresh = (domain: ControlPlaneDomain, action: string, refresh: Promise<unknown>): void => {
      const request = errorOwner.begin("control-plane", workspaceCwd, `${domain}:${action}`);
      errorOwner.clear(request);
      refreshes.push(refresh.then(
        (value) => {
          errorOwner.clear(request);
          return value;
        },
        (caught: unknown) => {
          errorOwner.report(request, { scope: "stream", message: domainErrorMessage(caught) });
          throw caught;
        },
      ));
    };
    if (changed.has("runs")) {
      if (!input.selectedChannelId) {
        trackRefresh("runs", "list", input.refreshRuns(workspaceCwd));
      }
    }
    const runtimeDomain = changed.has("runs")
      ? "runs"
      : changed.has("work_units")
        ? "work_units"
        : undefined;
    if (runtimeDomain) {
      trackRefresh(runtimeDomain, "runtime", input.refreshRuntimeState(workspaceCwd));
    }
    const channelActivityDomain = changed.has("runs")
      ? "runs"
      : changed.has("work_units")
        ? "work_units"
        : undefined;
    if (channelActivityDomain && input.selectedChannelId) {
      trackRefresh(
        channelActivityDomain,
        `channel-activity:${input.selectedChannelId}`,
        input.refreshChannelActivity(),
      );
    }
    const channelActivityOwnsSelectedRefreshes = Boolean(channelActivityDomain && input.selectedChannelId);
    if (changed.has("approvals") && !channelActivityOwnsSelectedRefreshes) {
      trackRefresh("approvals", "list", input.refreshApprovals(workspaceCwd));
    }
    if (changed.has("approvals")) {
      trackRefresh("approvals", "policy", input.refreshApprovalPolicy());
    }
    if (changed.has("providers")) {
      trackRefresh("providers", "list", input.refreshProviders(workspaceCwd));
    }
    if (changed.has("mcp")) {
      trackRefresh("mcp", "list", input.refreshMcp(workspaceCwd));
      trackRefresh("mcp", "plugins", input.refreshPlugins(workspaceCwd));
    }
    if (changed.has("runners")) {
      trackRefresh("runners", "settings", input.refreshRuntimeSettings());
    }
    if (changed.has("teammates")) {
      trackRefresh("teammates", "list", input.refreshAiTeammates(workspaceCwd));
    }
    if (changed.has("memory")) {
      trackRefresh("memory", "audit", input.refreshUsedMemoryAudit(workspaceCwd));
    }
    if (changed.has("skills")) {
      input.setSkillLibraryRefreshToken((current) => current + 1);
    }
    if (changed.has("artifacts") && input.selectedChannelId && !channelActivityOwnsSelectedRefreshes) {
      trackRefresh(
        "artifacts",
        `channel:${input.selectedChannelId}`,
        input.refreshChannelRunArtifacts(workspaceCwd, input.selectedChannelId, input.channelRunsForArtifacts),
      );
    }
    const conversationDomain = (["runs", "work_units", "approvals", "artifacts"] as const)
      .find((domain) => changed.has(domain));
    if (conversationDomain) {
      if (!input.selectedChannelId) {
        trackRefresh(conversationDomain, "selected-conversation", input.refreshSelectedConversation(workspaceCwd));
      } else if (!changed.has("runs") && !channelActivityOwnsSelectedRefreshes) {
        trackRefresh(
          conversationDomain,
          `channel-conversation:${input.selectedChannelId}`,
          input.refreshSelectedChannelConversation(),
        );
      }
      if (input.selectedTeammateId) {
        input.invalidateSelectedTeammateConversation();
      }
    }
    await Promise.all(refreshes);
  };

  useEffect(() => {
    const workspaceCwd = input.workspaceCwd;
    if (!workspaceCwd || input.daemonHealthy !== true) {
      return undefined;
    }
    let closed = false;
    let source: EventSource | undefined;
    let ws: WebSocket | undefined;
    let retryTimer: number | undefined;
    let flushTimer: number | undefined;
    let connectionGeneration = 0;
    let opening = false;
    let lastAppliedSeq = 0;
    let lastReceivedSeq = 0;
    let pendingLatestSeq = 0;
    let pendingProofSeq = 0;
    let hasAppliedSnapshot = false;
    let handshakeComplete = false;
    let baselinePending = false;
    let flushChain = Promise.resolve();
    const pendingDomains = new Set<ControlPlaneDomain>();

    const closeTransport = (): void => {
      const closingSource = source;
      const closingWs = ws;
      source = undefined;
      ws = undefined;
      closingSource?.close();
      closingWs?.close();
    };
    const resetUnapplied = (): void => {
      pendingDomains.clear();
      pendingLatestSeq = 0;
      pendingProofSeq = 0;
      lastReceivedSeq = lastAppliedSeq;
      if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer);
        flushTimer = undefined;
      }
    };
    const abandonTransport = (): void => {
      connectionGeneration += 1;
      handshakeComplete = false;
      baselinePending = false;
      closeTransport();
      resetUnapplied();
    };
    const scheduleRetry = (delayMs = 2_000): void => {
      if (closed || retryTimer !== undefined) return;
      abandonTransport();
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void openStream();
      }, delayMs);
    };
    const scheduleFlush = (): void => {
      if (closed || !handshakeComplete || baselinePending || flushTimer !== undefined) return;
      flushTimer = window.setTimeout(() => {
        flushChain = flushChain.then(flushDomains);
      }, 150);
    };
    const flushDomains = async (): Promise<void> => {
      flushTimer = undefined;
      if (closed || !handshakeComplete || baselinePending) return;
      if (pendingDomains.size === 0 && pendingProofSeq <= lastAppliedSeq) return;
      const applyGeneration = connectionGeneration;
      const domains = [...pendingDomains];
      const batchLatestSeq = pendingLatestSeq;
      const batchProofSeq = pendingProofSeq;
      pendingDomains.clear();
      pendingLatestSeq = 0;
      pendingProofSeq = 0;
      try {
        if (domains.length > 0) await invalidationRef.current(domains);
        if (closed || applyGeneration !== connectionGeneration) return;
        lastAppliedSeq = Math.max(lastAppliedSeq, batchLatestSeq, batchProofSeq);
        if (pendingDomains.size > 0 || pendingProofSeq > lastAppliedSeq) scheduleFlush();
      } catch {
        scheduleRetry();
      }
    };
    const enqueueDomain = (domain: ControlPlaneDomain, seq: number): void => {
      if (seq <= lastAppliedSeq || seq <= lastReceivedSeq) return;
      lastReceivedSeq = seq;
      pendingDomains.add(domain);
      pendingLatestSeq = Math.max(pendingLatestSeq, seq);
      scheduleFlush();
    };

    const handleSnapshotRequired = (generation: number): void => {
      if (closed || generation !== connectionGeneration) return;
      hasAppliedSnapshot = false;
      scheduleRetry(0);
    };
    const handleReplayReady = async (
      generation: number,
      windowState: ControlPlaneReplayWindow,
      baselineSeq: number | undefined,
    ): Promise<void> => {
      if (closed || generation !== connectionGeneration) return;
      handshakeComplete = true;
      pendingProofSeq = Math.max(pendingProofSeq, windowState.nextAfterSeq);
      if (baselineSeq !== undefined) {
        try {
          await invalidationRef.current(controlPlaneSummaryDomains);
        } catch {
          if (generation === connectionGeneration) scheduleRetry();
          return;
        }
        if (closed || generation !== connectionGeneration) return;
        lastAppliedSeq = Math.max(lastAppliedSeq, baselineSeq);
        hasAppliedSnapshot = true;
      }
      baselinePending = false;
      scheduleFlush();
    };
    const openSseStream = (generation: number, afterSeq: number, baselineSeq: number | undefined): void => {
      if (closed || generation !== connectionGeneration) return;
      source = new EventSource(controlPlaneStreamUrl(input.daemonBaseUrl, workspaceCwd, {
        afterSeq,
        domains: controlPlaneSummaryDomains,
      }));
      source.addEventListener("control_plane_event", (message) => {
        if (generation !== connectionGeneration) return;
        const event = parseControlPlaneEventMessage((message as MessageEvent<string>).data);
        if (event) enqueueDomain(event.domain, event.seq);
      });
      source.addEventListener("control_plane_replay_ready", (message) => {
        if (generation !== connectionGeneration) return;
        const replayWindow = parseControlPlaneReplayWindowMessage((message as MessageEvent<string>).data);
        if (!replayWindow || replayWindow.disposition !== "complete") {
          scheduleRetry();
          return;
        }
        void handleReplayReady(generation, replayWindow, baselineSeq);
      });
      source.addEventListener("control_plane_snapshot_required", () => {
        handleSnapshotRequired(generation);
      });
      source.addEventListener("error", () => {
        if (generation === connectionGeneration) scheduleRetry();
      });
    };
    const openRpcStream = (generation: number, afterSeq: number, baselineSeq: number | undefined): void => {
      if (!input.localWebSocketRpcEnabled || typeof WebSocket === "undefined") {
        openSseStream(generation, afterSeq, baselineSeq);
        return;
      }
      let subscribed = false;
      let fellBack = false;
      const fallbackToSse = (): void => {
        if (fellBack || subscribed || closed || generation !== connectionGeneration) return;
        fellBack = true;
        const closingWs = ws;
        ws = undefined;
        closingWs?.close();
        openSseStream(generation, afterSeq, baselineSeq);
      };
      ws = new WebSocket(controlPlaneRpcStreamUrl(input.daemonBaseUrl, workspaceCwd));
      ws.addEventListener("open", () => {
        if (generation !== connectionGeneration) return;
        ws?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { cwd: workspaceCwd } }));
        ws?.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "controlPlane.subscribe",
          params: {
            cwd: workspaceCwd,
            afterSeq,
            domains: controlPlaneSummaryDomains,
          },
        }));
      });
      ws.addEventListener("message", (message) => {
        if (generation !== connectionGeneration) return;
        const text = typeof message.data === "string" ? message.data : "";
        const subscribeMessage = parseControlPlaneRpcSubscribeMessage(text, 2);
        if (subscribeMessage) {
          if (subscribeMessage.error || !subscribeMessage.result) {
            fallbackToSse();
            return;
          }
          if (subscribeMessage.result.disposition === "snapshot_required") {
            handleSnapshotRequired(generation);
            return;
          }
          subscribed = true;
          void handleReplayReady(generation, subscribeMessage.result.window, baselineSeq);
          return;
        }
        const event = parseControlPlaneRpcEventMessage(text);
        if (event) enqueueDomain(event.domain, event.seq);
      });
      ws.addEventListener("error", () => {
        if (generation !== connectionGeneration || fellBack) return;
        if (!subscribed) {
          fallbackToSse();
          return;
        }
        scheduleRetry();
      });
      ws.addEventListener("close", () => {
        if (closed || generation !== connectionGeneration || fellBack) return;
        if (!subscribed) {
          fallbackToSse();
          return;
        }
        scheduleRetry();
      });
    };
    const openStream = async (): Promise<void> => {
      if (closed || opening) return;
      opening = true;
      let baselineSeq: number | undefined;
      try {
        if (!hasAppliedSnapshot) {
          const snapshot = await getControlPlaneSnapshot(workspaceCwd, controlPlaneSummaryDomains);
          if (closed) return;
          baselineSeq = snapshot.latestEventSeq;
        }
        const afterSeq = baselineSeq ?? lastAppliedSeq;
        lastReceivedSeq = afterSeq;
        pendingProofSeq = afterSeq;
        handshakeComplete = false;
        baselinePending = baselineSeq !== undefined;
        const generation = connectionGeneration + 1;
        connectionGeneration = generation;
        closeTransport();
        openRpcStream(generation, afterSeq, baselineSeq);
      } catch {
        if (!closed) scheduleRetry();
      } finally {
        opening = false;
      }
    };
    void openStream();
    return () => {
      closed = true;
      connectionGeneration += 1;
      closeTransport();
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      if (flushTimer !== undefined) {
        window.clearTimeout(flushTimer);
      }
    };
  }, [
    input.daemonBaseUrl,
    input.daemonHealthy,
    input.localWebSocketRpcEnabled,
    input.workspaceCwd,
  ]);

  return {
    errors: errorOwner.errors() as readonly ControlPlaneInvalidationError[],
    error: errorOwner.latest() as ControlPlaneInvalidationError | undefined,
    clearError: errorOwner.clearAll,
  };
}
