import type { Session, DownloadItem, Event, WebContents } from "electron";
import { assertBrowserNetworkUrl, isBrowserLoopback } from "./url-policy.js";

export function configureBrowserSession(session: Session, options: {
  readonly permission?: (id: number, permission: string, origin: string) => boolean;
  readonly requestCompleted?: (id: number, url: string, status: number, method: string, type: string) => void;
  readonly download?: (event: Event, item: DownloadItem, contents: WebContents | undefined) => void;
  readonly forbiddenOrigins: readonly string[];
  readonly tabOrigin: (webContentsId: number) => string | undefined;
  readonly reportBlocked: (webContentsId: number, code: string) => void;
}): void {
  const permissions = (id: number, permission: string, origin: string, mediaTypes?: readonly string[]): boolean => {
    try { return permission === "media" ? Boolean(mediaTypes?.length) && mediaTypes!.every(type => options.permission?.(id, type === "video" ? "camera" : type === "audio" ? "microphone" : "unknown", new URL(origin).origin))
      : options.permission?.(id, permission, new URL(origin).origin) === true; } catch { return false; }
  };
  session.setPermissionCheckHandler((contents, permission, origin, details) => permissions(contents?.id ?? -1, permission, origin, "mediaType" in details ? [String(details.mediaType)] : undefined));
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(permissions(contents.id, permission, details.requestingUrl, "mediaTypes" in details ? details.mediaTypes : undefined)));
  session.setDevicePermissionHandler(() => false);
  session.on("will-download", (event, item, contents) => {
    try { if (options.download) options.download(event, item, contents); else { event.preventDefault(); item.cancel(); } } catch { event.preventDefault(); item.cancel(); }
    if (event.defaultPrevented && contents) options.reportBlocked(contents.id, "browser_download_blocked");
  });
  session.webRequest.onCompleted(details => options.requestCompleted?.(details.webContentsId ?? -1, details.url, details.statusCode, details.method, details.resourceType));
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
