import { useEffect, useState } from "react";
import type { DesktopDaemonStatus } from "../../../desktop/shared/desktop-capabilities.js";

/** One shell-level Host projection shared by ordinary, private and channel views. */
export function useDesktopDaemonStatus(): DesktopDaemonStatus | undefined {
  const [status, setStatus] = useState<DesktopDaemonStatus>();
  useEffect(() => {
    if (typeof window === "undefined" || !window.lingDesktop) return;
    return window.lingDesktop.daemon.onStatusChanged(setStatus);
  }, []);
  return status;
}
