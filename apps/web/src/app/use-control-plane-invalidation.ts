import { useEffect, useRef } from "react";
import { getControlPlaneSnapshot } from "../api/control-plane.js";
import {
  controlPlaneRpcStreamUrl,
  controlPlaneStreamUrl,
  controlPlaneSummaryDomains,
  parseControlPlaneEventMessage,
  parseControlPlaneRpcEventMessage,
} from "../lib/control-plane.js";
import type { ControlPlaneDomain, RunSession } from "../types.js";

export function useControlPlaneInvalidation(input: {
  readonly daemonBaseUrl: string;
  readonly daemonHealthy: boolean | undefined;
  readonly localWebSocketRpcEnabled: boolean;
  readonly workspaceCwd: string;
  readonly selectedChannelId: string;
  readonly channelRunsForArtifacts: readonly RunSession[];
  readonly setSkillLibraryRefreshToken: (update: (current: number) => number) => void;
  readonly setErrorMessage: (message: string) => void;
  readonly refreshRuns: (cwd?: string) => Promise<void>;
  readonly refreshRuntimeState: (cwd?: string) => Promise<void>;
  readonly refreshApprovals: (cwd?: string, runId?: string) => Promise<void>;
  readonly refreshApprovalPolicy: () => Promise<void>;
  readonly refreshProviders: (cwd?: string) => Promise<void>;
  readonly refreshMcp: (cwd?: string) => Promise<void>;
  readonly refreshRuntimeSettings: () => Promise<void>;
  readonly refreshAiTeammates: (cwd?: string) => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd?: string) => Promise<void>;
  readonly refreshChannelRunArtifacts: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelActivity: () => Promise<void>;
}): void {
  const invalidationRef = useRef<(domains: readonly ControlPlaneDomain[]) => void>(() => undefined);
  invalidationRef.current = (domains) => {
    const workspaceCwd = input.workspaceCwd;
    if (!workspaceCwd) {
      return;
    }
    const changed = new Set(domains);
    const refreshes: Promise<unknown>[] = [];
    if (changed.has("runs")) {
      refreshes.push(input.refreshRuns(workspaceCwd));
      if (input.selectedChannelId) {
        refreshes.push(input.refreshChannelActivity());
        refreshes.push(input.refreshRuntimeState(workspaceCwd));
      }
    }
    if (changed.has("work_units")) {
      refreshes.push(input.refreshRuntimeState(workspaceCwd));
    }
    if (changed.has("approvals")) {
      refreshes.push(input.refreshApprovals(workspaceCwd));
      refreshes.push(input.refreshApprovalPolicy());
    }
    if (changed.has("providers")) {
      refreshes.push(input.refreshProviders(workspaceCwd));
    }
    if (changed.has("mcp")) {
      refreshes.push(input.refreshMcp(workspaceCwd));
    }
    if (changed.has("runners")) {
      refreshes.push(input.refreshRuntimeSettings());
    }
    if (changed.has("teammates")) {
      refreshes.push(input.refreshAiTeammates(workspaceCwd));
    }
    if (changed.has("memory")) {
      refreshes.push(input.refreshUsedMemoryAudit(workspaceCwd));
    }
    if (changed.has("skills")) {
      input.setSkillLibraryRefreshToken((current) => current + 1);
    }
    if (changed.has("artifacts") && input.selectedChannelId) {
      refreshes.push(input.refreshChannelRunArtifacts(workspaceCwd, input.selectedChannelId, input.channelRunsForArtifacts));
    }
    if (refreshes.length > 0) {
      void Promise.all(refreshes).catch((error: unknown) => {
        input.setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    }
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
    let latestSeq = 0;
    const pendingDomains = new Set<ControlPlaneDomain>();
    const flushDomains = (): void => {
      flushTimer = undefined;
      if (pendingDomains.size === 0) {
        return;
      }
      const domains = [...pendingDomains];
      pendingDomains.clear();
      invalidationRef.current(domains);
    };
    const enqueueDomain = (domain: ControlPlaneDomain): void => {
      pendingDomains.add(domain);
      if (flushTimer !== undefined) {
        return;
      }
      flushTimer = window.setTimeout(flushDomains, 150);
    };
    const scheduleRetry = (): void => {
      if (closed || retryTimer !== undefined) {
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void openStream();
      }, 2_000);
    };
    const openSseStream = (): void => {
      if (closed) {
        return;
      }
      source = new EventSource(controlPlaneStreamUrl(input.daemonBaseUrl, workspaceCwd, {
        afterSeq: latestSeq,
        domains: controlPlaneSummaryDomains,
      }));
      source.addEventListener("control_plane_event", (message) => {
        const event = parseControlPlaneEventMessage((message as MessageEvent<string>).data);
        if (!event || event.seq <= latestSeq) {
          return;
        }
        latestSeq = event.seq;
        enqueueDomain(event.domain);
      });
      source.addEventListener("error", () => {
        source?.close();
        scheduleRetry();
      });
    };
    const openRpcStream = (): void => {
      if (!input.localWebSocketRpcEnabled || typeof WebSocket === "undefined") {
        openSseStream();
        return;
      }
      let subscribed = false;
      let fellBack = false;
      const fallbackToSse = (): void => {
        if (fellBack || subscribed || closed) {
          return;
        }
        fellBack = true;
        openSseStream();
      };
      ws = new WebSocket(controlPlaneRpcStreamUrl(input.daemonBaseUrl, workspaceCwd));
      ws.addEventListener("open", () => {
        ws?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { cwd: workspaceCwd } }));
        ws?.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "controlPlane.subscribe",
          params: {
            cwd: workspaceCwd,
            afterSeq: latestSeq,
            domains: controlPlaneSummaryDomains,
          },
        }));
      });
      ws.addEventListener("message", (message) => {
        const text = typeof message.data === "string" ? message.data : "";
        if (text.includes("\"id\":2")) {
          subscribed = !text.includes("\"error\"");
          if (!subscribed) {
            ws?.close();
            fallbackToSse();
          }
          return;
        }
        const event = parseControlPlaneRpcEventMessage(text);
        if (!event || event.seq <= latestSeq) {
          return;
        }
        latestSeq = event.seq;
        enqueueDomain(event.domain);
      });
      ws.addEventListener("error", () => {
        ws?.close();
        if (!subscribed) {
          fallbackToSse();
          return;
        }
        scheduleRetry();
      });
      ws.addEventListener("close", () => {
        if (closed) {
          return;
        }
        if (!subscribed) {
          fallbackToSse();
          return;
        }
        scheduleRetry();
      });
    };
    const openStream = async (): Promise<void> => {
      const snapshot = await getControlPlaneSnapshot(workspaceCwd, ["runs"]).catch(() => undefined);
      if (closed) {
        return;
      }
      latestSeq = snapshot?.latestEventSeq ?? 0;
      openRpcStream();
    };
    void openStream();
    return () => {
      closed = true;
      source?.close();
      ws?.close();
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
}
