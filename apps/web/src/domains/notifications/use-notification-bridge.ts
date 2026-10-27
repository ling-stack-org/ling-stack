import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationRecord } from "@ling-stack/contracts";
import { daemonClient } from "../../api/client.js";
import { useLingToast, type LingToastInput } from "../../shared/ui/index.js";

const POLL_INTERVAL_MS = 10_000;

export interface NotificationBridgeState {
  readonly connected: boolean;
  readonly lastError: string;
}

/**
 * Polls the daemon notification journal and raises toasts for delivered
 * records. The `since` cursor lives for the page session only: on reload the
 * last 200 journal records exist server-side but a fresh page starts from the
 * current head so users are not replayed old notifications.
 *
 * OS-level desktop delivery is owned by the Electron main process; this hook
 * is the in-app (web) delivery path only.
 */
export function useNotificationBridge(input: { readonly cwd: string }): NotificationBridgeState {
  const { cwd } = input;
  const { showToast } = useLingToast();
  const [state, setState] = useState<NotificationBridgeState>({ connected: true, lastError: "" });
  const sinceRef = useRef<string>("");
  const busyRef = useRef(false);

  const poll = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const response = await daemonClient.listNotifications(sinceRef.current || undefined);
      for (const record of response.notifications) {
        showRecord(record, showToast, cwd);
      }
      sinceRef.current = response.nextSince || sinceRef.current;
      setState({ connected: true, lastError: "" });
    } catch (error) {
      setState({ connected: false, lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
    }
  }, [cwd, showToast]);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  return state;
}

function showRecord(
  record: NotificationRecord,
  showToast: (toast: LingToastInput) => string,
  cwd: string,
): void {
  if (record.cwd && record.cwd !== cwd) return;
  showToast({
    message: `${record.title}: ${record.body}`,
    scope: `notification:${record.id}`,
    tone: record.kind === "automation_run_failed" ? "error" : "info",
  });
}
