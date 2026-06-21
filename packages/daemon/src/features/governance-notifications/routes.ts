import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  GovernanceNotificationKind,
  GovernanceNotificationStatus,
  GovernanceNotificationSurfaceKind,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalBooleanQuery, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  flushLingAgentGovernanceNotificationDigests,
  flushTeammateDirectGovernanceNotifications,
} from "./private-delivery.js";

export type GovernanceNotificationRoute =
  | { readonly kind: "seen"; readonly notificationId: string }
  | { readonly kind: "dismiss"; readonly notificationId: string };

export function parseGovernanceNotificationRoute(pathname: string): GovernanceNotificationRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "governance-notifications" && segments[2] === "seen") {
    return { kind: "seen", notificationId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "governance-notifications" && segments[2] === "dismiss") {
    return { kind: "dismiss", notificationId: segments[1] };
  }
  return undefined;
}

export async function handleGovernanceNotificationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route?: GovernanceNotificationRoute,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (url.pathname === "/governance-notifications/summary") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /governance-notifications/summary` });
        return;
      }
      flushTeammateDirectGovernanceNotifications(store);
      flushLingAgentGovernanceNotificationDigests(store);
      writeJson(response, 200, {
        cwd,
        summary: store.getGovernanceNotificationSummary(undefined, new Date().toISOString()),
      });
      return;
    }

    if (url.pathname === "/governance-notifications") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /governance-notifications` });
        return;
      }
      flushTeammateDirectGovernanceNotifications(store);
      flushLingAgentGovernanceNotificationDigests(store);
      writeJson(response, 200, {
        cwd,
        notifications: store.listGovernanceNotifications({
          surface: readOptionalSurfaceKindQuery(url),
          channelId: url.searchParams.get("channelId") ?? undefined,
          teammateId: url.searchParams.get("teammateId") ?? undefined,
          threadId: url.searchParams.get("threadId") ?? undefined,
          kind: readOptionalKindQuery(url),
          status: readOptionalStatusQuery(url),
          includeResolved: readOptionalBooleanQuery(url, "includeResolved"),
          includeDismissed: readOptionalBooleanQuery(url, "includeDismissed"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (route) {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for governance notification mutations` });
        return;
      }
      const now = new Date().toISOString();
      const notification = route.kind === "seen"
        ? store.markGovernanceNotificationSeen(route.notificationId, now)
        : store.dismissGovernanceNotification(route.notificationId, now);
      if (!notification) {
        writeJson(response, 404, {
          error: "governance_notification_not_found",
          message: `Governance notification not found: ${route.notificationId}`,
        });
        return;
      }
      writeJson(response, 200, { cwd, notification });
      return;
    }

    writeJson(response, 404, { error: "not_found", message: `No governance notification route for ${url.pathname}` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function readOptionalSurfaceKindQuery(url: URL): GovernanceNotificationSurfaceKind | undefined {
  const value = url.searchParams.get("surface");
  if (value === null) {
    return undefined;
  }
  if (value !== "teammate_direct" && value !== "channel" && value !== "ling_agent" && value !== "workspace") {
    throw new Error("surface must be one of: teammate_direct, channel, ling_agent, workspace");
  }
  return value;
}

function readOptionalStatusQuery(url: URL): GovernanceNotificationStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (value !== "unread" && value !== "seen" && value !== "dismissed" && value !== "resolved") {
    throw new Error("status must be one of: unread, seen, dismissed, resolved");
  }
  return value;
}

function readOptionalKindQuery(url: URL): GovernanceNotificationKind | undefined {
  const value = url.searchParams.get("kind");
  if (value === null) {
    return undefined;
  }
  if (
    value !== "memory_candidate" &&
    value !== "memory_health_finding" &&
    value !== "skill_candidate" &&
    value !== "procedure_cluster" &&
    value !== "channel_protocol_candidate" &&
    value !== "channel_playbook_candidate" &&
    value !== "workflow_fanin"
  ) {
    throw new Error("kind is not a supported governance notification kind");
  }
  return value;
}
