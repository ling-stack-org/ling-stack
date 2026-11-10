import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import type { DaemonContext } from "../../context.js";
import type {
  NotificationListResponse,
  NotificationPreferencesResponse,
  NotificationPreferencesUpdate,
} from "@ling-stack/contracts";

const DEFAULT_POLL_WAIT_MS = 20_000;
const POLL_TICK_MS = 500;

function pollWaitMs(): number {
  const configured = Number.parseInt(process.env.LING_NOTIFICATIONS_POLL_WAIT_MS ?? "", 10);
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, DEFAULT_POLL_WAIT_MS) : DEFAULT_POLL_WAIT_MS;
}

export async function handleNotifications(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const hub = context.notificationHub;

  if (url.pathname === "/notifications/preferences") {
    if (request.method === "GET") {
      await hub.ensureLoaded();
      const body: NotificationPreferencesResponse = { schemaVersion: 1, preferences: hub.getPreferences() };
      writeJson(response, 200, body);
      return;
    }
    if (request.method === "PATCH") {
      try {
        const raw = await readJsonBody(request, context.config.maxBodyBytes);
        const update = parsePreferencesUpdate(raw);
        const preferences = await hub.updatePreferences(update);
        const body: NotificationPreferencesResponse = { schemaVersion: 1, preferences };
        writeJson(response, 200, body);
      } catch (error) {
        writeJson(response, 400, {
          error: "bad_request",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET or PATCH for notification preferences" });
    return;
  }

  if (url.pathname === "/notifications/stream") {
    // Long-poll: respond as soon as a record newer than `since` exists, or
    // after POLL_WAIT_MS with an empty window. Clients treat this as polling
    // with server-side waiting.
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for the notification stream" });
      return;
    }
    const since = url.searchParams.get("since") ?? undefined;
    const deadline = Date.now() + pollWaitMs();
    await hub.ensureLoaded();
    let window = hub.list(since);
    while (window.notifications.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_TICK_MS));
      window = hub.list(since);
    }
    const body: NotificationListResponse = {
      schemaVersion: 1,
      notifications: window.notifications,
      nextSince: window.nextSince,
    };
    writeJson(response, 200, body);
    return;
  }

  if (url.pathname === "/notifications") {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for notifications" });
      return;
    }
    await hub.ensureLoaded();
    const since = url.searchParams.get("since") ?? undefined;
    const window = hub.list(since);
    const body: NotificationListResponse = {
      schemaVersion: 1,
      notifications: window.notifications,
      nextSince: window.nextSince,
    };
    writeJson(response, 200, body);
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `Unknown notifications route ${url.pathname}` });
}

function parsePreferencesUpdate(raw: unknown): NotificationPreferencesUpdate {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Notification preferences update must be an object");
  }
  const input = raw as Record<string, unknown>;
  const update: NotificationPreferencesUpdate = {};
  if (input.globalEnabled !== undefined) {
    if (typeof input.globalEnabled !== "boolean") throw new Error("globalEnabled must be a boolean");
    update.globalEnabled = input.globalEnabled;
  }
  if (input.events !== undefined) {
    if (input.events === null || typeof input.events !== "object" || Array.isArray(input.events)) {
      throw new Error("events must be an object");
    }
    const events: Record<string, "all" | "failures" | "off"> = {};
    for (const [kind, tone] of Object.entries(input.events as Record<string, unknown>)) {
      if (!["automation_run_finished", "automation_run_failed", "approval_required"].includes(kind)) {
        throw new Error(`Unknown notification event kind: ${kind}`);
      }
      if (!["all", "failures", "off"].includes(String(tone))) {
        throw new Error(`Unknown notification tone for ${kind}: ${String(tone)}`);
      }
      events[kind] = String(tone) as "all" | "failures" | "off";
    }
    update.events = events;
  }
  if (input.quietHours !== undefined) {
    if (input.quietHours === null) {
      update.quietHours = null;
    } else if (typeof input.quietHours === "object" && !Array.isArray(input.quietHours)) {
      const candidate = input.quietHours as Record<string, unknown>;
      const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;
      if (!timePattern.test(String(candidate.start ?? "")) || !timePattern.test(String(candidate.end ?? ""))) {
        throw new Error("quietHours must use HH:MM (00:00-23:59) start and end");
      }
      update.quietHours = { start: String(candidate.start), end: String(candidate.end) };
    } else {
      throw new Error("quietHours must be an object or null");
    }
  }
  return update;
}
