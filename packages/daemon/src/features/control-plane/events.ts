import type { ServerResponse } from "node:http";
import type {
  AppendControlPlaneEventInput,
  ControlPlaneDomain,
  ControlPlaneEvent,
  RunStore,
} from "@ling-stack/core";
import { writeSse } from "../../shared/response.js";

export const CONTROL_PLANE_POLL_DEFAULT_LIMIT = 200;
export const CONTROL_PLANE_POLL_MAX_LIMIT = 1000;
export const CONTROL_PLANE_SSE_HEARTBEAT_MS = 15_000;
export const CONTROL_PLANE_SSE_INITIAL_REPLAY_LIMIT = 1000;
export const CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT = 500;
export const CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD = 400;
export const CONTROL_PLANE_SSE_FLUSH_MS = 100;
export const CONTROL_PLANE_SSE_MAX_EVENT_BYTES = 64 * 1024;

export interface ControlPlaneStreamSubscription {
  close(): void;
}

interface ControlPlaneStreamClient {
  readonly id: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly domains?: ReadonlySet<ControlPlaneDomain>;
  readonly response: ServerResponse;
  readonly queue: ControlPlaneEvent[];
  heartbeatTimer?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  overLimitFlushes: number;
  closed: boolean;
}

export class ControlPlaneEventHub {
  private nextClientId = 1;
  private readonly clients = new Set<ControlPlaneStreamClient>();

  subscribe(input: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly domains?: readonly ControlPlaneDomain[];
    readonly response: ServerResponse;
    readonly latestEventSeq: () => number;
  }): ControlPlaneStreamSubscription {
    const client: ControlPlaneStreamClient = {
      id: this.nextClientId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      domains: input.domains && input.domains.length > 0 ? new Set(input.domains) : undefined,
      response: input.response,
      queue: [],
      overLimitFlushes: 0,
      closed: false,
    };
    this.nextClientId += 1;
    this.clients.add(client);

    const sendHeartbeat = (): void => {
      if (client.closed || client.response.writableEnded) {
        this.closeClient(client);
        return;
      }
      writeSse(client.response, "heartbeat", {
        ts: new Date().toISOString(),
        latestEventSeq: input.latestEventSeq(),
      });
    };
    client.heartbeatTimer = setInterval(sendHeartbeat, CONTROL_PLANE_SSE_HEARTBEAT_MS);
    setTimeout(sendHeartbeat, 0);

    return {
      close: () => this.closeClient(client),
    };
  }

  publish(event: ControlPlaneEvent): void {
    for (const client of this.clients) {
      if (!clientMatchesEvent(client, event)) {
        continue;
      }
      enqueueClientEvent(client, event, () => this.closeClient(client));
    }
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      this.closeClient(client);
    }
  }

  private closeClient(client: ControlPlaneStreamClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
    }
    if (client.flushTimer) {
      clearTimeout(client.flushTimer);
    }
    this.clients.delete(client);
    if (!client.response.writableEnded) {
      client.response.end();
    }
  }
}

export function appendControlPlaneEvent(
  store: RunStore,
  hub: ControlPlaneEventHub,
  input: AppendControlPlaneEventInput,
  now = new Date().toISOString(),
): ControlPlaneEvent {
  const event = store.appendControlPlaneEvent(input, now);
  hub.publish(trimOversizedEvent(event));
  return event;
}

export function trimOversizedEvent(event: ControlPlaneEvent): ControlPlaneEvent {
  const serializedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  if (serializedBytes <= CONTROL_PLANE_SSE_MAX_EVENT_BYTES) {
    return event;
  }
  return {
    ...event,
    data: {
      summary: "control-plane event payload exceeded 64KiB and was omitted",
      originalAction: event.action,
      originalBytes: serializedBytes,
    },
  };
}

function clientMatchesEvent(client: ControlPlaneStreamClient, event: ControlPlaneEvent): boolean {
  return (
    client.workspaceId === event.workspaceId &&
    client.cwd === event.cwd &&
    (!client.domains || client.domains.has(event.domain))
  );
}

function enqueueClientEvent(client: ControlPlaneStreamClient, event: ControlPlaneEvent, close: () => void): void {
  if (client.closed || client.response.writableEnded) {
    close();
    return;
  }
  client.queue.push(trimOversizedEvent(event));
  if (client.queue.length >= CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD) {
    coalesceClientQueue(client);
  }
  scheduleClientFlush(client, close);
}

function scheduleClientFlush(client: ControlPlaneStreamClient, close: () => void): void {
  if (client.flushTimer) {
    return;
  }
  client.flushTimer = setTimeout(() => {
    client.flushTimer = undefined;
    flushClientQueue(client, close);
  }, CONTROL_PLANE_SSE_FLUSH_MS);
}

function flushClientQueue(client: ControlPlaneStreamClient, close: () => void): void {
  if (client.closed || client.response.writableEnded) {
    close();
    return;
  }

  if (client.queue.length > CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT) {
    coalesceClientQueue(client);
    client.overLimitFlushes += 1;
    if (client.queue.length > CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT && client.overLimitFlushes >= 2) {
      writeSse(client.response, "slow_client_disconnect", {
        ts: new Date().toISOString(),
        reason: "control-plane stream client could not keep up",
        queued: client.queue.length,
      });
      close();
      return;
    }
  } else {
    client.overLimitFlushes = 0;
  }

  while (client.queue.length > 0 && !client.response.writableEnded) {
    const event = client.queue.shift();
    if (event) {
      writeSse(client.response, "control_plane_event", event);
    }
  }
}

function coalesceClientQueue(client: ControlPlaneStreamClient): void {
  const preserved: ControlPlaneEvent[] = [];
  const coalesced = new Map<string, { event: ControlPlaneEvent; count: number }>();

  for (const event of client.queue) {
    if (shouldPreserveEvent(event)) {
      preserved.push(event);
      continue;
    }
    const key = `${event.domain}:${event.entityType}:${event.entityId}:${event.action}`;
    const existing = coalesced.get(key);
    if (existing) {
      coalesced.set(key, { event, count: existing.count + 1 });
    } else {
      coalesced.set(key, { event, count: 1 });
    }
  }

  client.queue.splice(0, client.queue.length, ...preserved, ...[...coalesced.values()].map(({ event, count }) => ({
    ...event,
    data: {
      ...event.data,
      summary: count > 1 ? "coalesced control-plane invalidations" : event.data.summary,
      count,
    },
  })));
}

function shouldPreserveEvent(event: ControlPlaneEvent): boolean {
  return (
    event.action.startsWith("approval.") ||
    event.action === "run.completed" ||
    event.action === "run.cancelled"
  );
}
