import { useEffect, useRef, useState, type RefObject } from "react";
import type { DesktopBrowserScope } from "@ling-stack/contracts";
import { useI18n } from "../../i18n.js";

/** Routes explicit conversation HTTP links without changing the trusted renderer's navigation policy. */
export function useConversationBrowserLinks(input: {
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly workspaceCwd: string;
  readonly surface: DesktopBrowserScope["surface"];
  readonly ownerId?: string;
  readonly onOpen: () => void;
}): string {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const current = useRef(input); current.current = input;
  const identity = JSON.stringify([input.workspaceCwd, input.surface, input.ownerId]);
  useEffect(() => {
    const { workspaceCwd, surface, ownerId } = current.current, browser = window.lingDesktop?.browser;
    if (!browser || !workspaceCwd || !ownerId) return;
    const workspace = { workspaceCwd, scope: { surface, ownerId } };
    void browser.act({ ...workspace, action: "activate_workspace" }).catch(() => undefined);
    return () => { void browser.act({ ...workspace, action: "deactivate_workspace" }).catch(() => undefined); };
  }, [identity]);
  useEffect(() => {
    setError("");
    let disposed = false;
    const click = (event: MouseEvent): void => {
      const owner = current.current, browser = window.lingDesktop?.browser;
      if (!browser || !owner.ownerId || !owner.workspaceCwd || event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return;
      const anchor = event.target.closest("a");
      if (!anchor || !owner.rootRef.current?.contains(anchor) || anchor.hasAttribute("download")
        || anchor.closest('[data-browser-route="system"]') || !/^https?:\/\//iu.test(anchor.getAttribute("href") ?? "")) return;
      const url = new URL(anchor.href);
      if (window.lingDesktop?.daemonBaseUrl && url.origin === new URL(window.lingDesktop.daemonBaseUrl).origin) return;
      event.preventDefault(); setError("");
      void browser.act({ workspaceCwd: owner.workspaceCwd, scope: { surface: owner.surface, ownerId: owner.ownerId }, action: "open_link", url: url.href })
        .then(state => { if (!disposed && state.openedIn === "in_app") owner.onOpen(); })
        .catch(() => { if (!disposed) setError(t("The browser link could not be opened. Check the address or open it in your system browser.")); });
    };
    document.addEventListener("click", click);
    return () => { disposed = true; document.removeEventListener("click", click); };
  }, [identity, t]);
  return error;
}
