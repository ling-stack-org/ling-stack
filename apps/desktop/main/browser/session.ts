import type { Session } from "electron";
import { assertBrowserNetworkUrl, isBrowserLoopback } from "./url-policy.js";

export function configureBrowserSession(session: Session, options: {
  readonly forbiddenOrigins: readonly string[];
  readonly tabOrigin: (webContentsId: number) => string | undefined;
  readonly reportBlocked: (webContentsId: number, code: string) => void;
}): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setDevicePermissionHandler(() => false);
  session.on("will-download", (event, item, contents) => {
    event.preventDefault(); item.cancel();
    if (contents) options.reportBlocked(contents.id, "browser_download_blocked");
  });
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const origin = options.tabOrigin(details.webContentsId ?? -1);
    if ((details.url.startsWith("data:") || details.url.startsWith("blob:")) && details.resourceType !== "mainFrame") {
      callback({ cancel: !origin }); return;
    }
    const allowedLoopbackOrigin = origin && isBrowserLoopback(new URL(origin).hostname) ? origin : undefined;
    void assertBrowserNetworkUrl(details.url, { allowedLoopbackOrigin, forbiddenOrigins: options.forbiddenOrigins }).then(
      () => callback({ cancel: false }),
      () => { options.reportBlocked(details.webContentsId ?? -1, "browser_network_request_blocked"); callback({ cancel: true }); },
    );
  });
}
