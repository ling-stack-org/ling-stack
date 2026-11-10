import { LingDaemonClient, daemonBaseUrlFromEnv } from "@ling-stack/api-client";
import { createDesktopLocalServiceFetch } from "../../../desktop/shared/local-service-capabilities.js";

export const daemonBaseUrl = window.lingDesktop?.daemonBaseUrl ??
  daemonBaseUrlFromEnv(import.meta.env as Record<string, string | undefined>);

export const daemonClient = new LingDaemonClient({
  baseUrl: daemonBaseUrl,
  ...(window.lingDesktop?.localServices ? { fetch: createDesktopLocalServiceFetch({
    baseUrl: daemonBaseUrl,
    localServices: window.lingDesktop.localServices,
    fetch: globalThis.fetch.bind(globalThis),
  }) } : {}),
});
