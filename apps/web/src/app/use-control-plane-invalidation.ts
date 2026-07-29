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
  readonly channelRunsForArtifacts: readonly RunSession[];
  readonly setSkillLibraryRefreshToken: (update: (current: number) => number) => void;
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
  readonly refreshChannelExecutionActions: (cwd?: string, channelId?: string, channelRuns?: readonly RunSession[]) => Promise<void>;
  readonly refreshChannelActivity: () => Promise<void>;
}): ControlPlaneInvalidationController {
  const workspaceIdentity = input.workspaceCwd.trim() || "workspace:unavailable";
  const errorOwner = useFocusedDomainErrorOwner<"control-plane", string>(workspaceIdentity);
  const invalidationRef = useRef<(domains: readonly ControlPlaneDomain[]) => void>(() => undefined);
  invalidationRef.current = (domains) => {
    const workspaceCwd = input.workspaceCwd;
    if (!workspaceCwd) {
      return;
    }
    const changed = new Set(domains);
    const trackRefresh = (domain: ControlPlaneDomain, action: string, refresh: Promise<unknown>): void => {
      const request = errorOwner.begin("control-plane", workspaceCwd, `${domain}:${action}`);
      errorOwner.clear(request);
      void refresh.then(
        () => errorOwner.clear(request),
        (caught: unknown) => {
          errorOwner.report(request, { scope: "stream", message: domainErrorMessage(caught) });
        },
      );
    };
    if (changed.has("runs")) {
      trackRefresh("runs", "list", input.refreshRuns(workspaceCwd));
      if (input.selectedChannelId) {
        trackRefresh("runs", `channel-activity:${input.selectedChannelId}`, input.refreshChannelActivity());
        trackRefresh("runs", "runtime", input.refreshRuntimeState(workspaceCwd));
        trackRefresh(
          "runs",
          `channel-execution:${input.selectedChannelId}`,
          input.refreshChannelExecutionActions(workspaceCwd, input.selectedChannelId, input.channelRunsForArtifacts),
        );
      }
    }
    if (changed.has("work_units")) {
      trackRefresh("work_units", "runtime", input.refreshRuntimeState(workspaceCwd));
    }
    if (changed.has("approvals")) {
      trackRefresh("approvals", "list", input.refreshApprovals(workspaceCwd));
      trackRefresh("approvals", "policy", input.refreshApprovalPolicy());
    }
    if (changed.has("providers")) {
      trackRefresh("providers", "list", input.refreshProviders(workspaceCwd));
    }
    if (changed.has("mcp")) {
      trackRefresh("mcp", "list", input.refreshMcp(workspaceCwd));
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
    if (changed.has("artifacts") && input.selectedChannelId) {
      trackRefresh(
        "artifacts",
        `channel:${input.selectedChannelId}`,
        input.refreshChannelRunArtifacts(workspaceCwd, input.selectedChannelId, input.channelRunsForArtifacts),
      );
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

  return {
    errors: errorOwner.errors() as readonly ControlPlaneInvalidationError[],
    error: errorOwner.latest() as ControlPlaneInvalidationError | undefined,
    clearError: errorOwner.clearAll,
  };
}
