import { LingDaemonClient, daemonBaseUrlFromEnv } from "@ling-stack/api-client";

export const daemonBaseUrl = daemonBaseUrlFromEnv(import.meta.env as Record<string, string | undefined>);

export const daemonClient = new LingDaemonClient({ baseUrl: daemonBaseUrl });
