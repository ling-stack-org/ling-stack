import type { ServerResponse } from "node:http";
import type {
  AppendControlPlaneEventInput,
  ControlPlaneDomain,
  ControlPlaneEvent,
  RunExecutionStoreFacet,
} from "@ling-stack/core";
import type { ControlPlaneReplayWindow } from "@ling-stack/contracts";
import { writeSse } from "../../shared/response.js";
import { coalesceAndSortControlPlaneEvents } from "./event-queue.js";

export const CONTROL_PLANE_POLL_DEFAULT_LIMIT = 200;
export const CONTROL_PLANE_POLL_MAX_LIMIT = 1000;
export const CONTROL_PLANE_SSE_HEARTBEAT_MS = 15_000;
export const CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT = 500;
export const CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD = 400;
export const CONTROL_PLANE_SSE_FLUSH_MS = 100;
export const CONTROL_PLANE_SSE_MAX_EVENT_BYTES = 64 * 1024;

export interface ControlPlaneStreamSubscription {
  close(): void;
}

export interface ControlPlaneEventListenerSubscription {
  activate(replayEvents: readonly ControlPlaneEvent[]): void;
  close(): void;
}

export interface ControlPlaneReplayWindowResult {
  readonly window: ControlPlaneReplayWindow;
  readonly events: readonly ControlPlaneEvent[];
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
  phase: "provisional" | "active";
  closed: boolean;
}

interface ControlPlaneEventListenerClient {
  readonly id: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly domains?: ReadonlySet<ControlPlaneDomain>;
  readonly onEvent: (event: ControlPlaneEvent) => void;
  readonly queue: ControlPlaneEvent[];
  phase: "provisional" | "active";
  closed: boolean;
}

export class ControlPlaneEventHub {
  private nextClientId = 1;
  private readonly clients = new Set<ControlPlaneStreamClient>();
  private readonly listeners = new Set<ControlPlaneEventListenerClient>();

  subscribe(input: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly domains?: readonly ControlPlaneDomain[];
    readonly response: ServerResponse;
    readonly latestEventSeq: () => number;
    readonly replayWindow: () => ControlPlaneReplayWindowResult;
  }): ControlPlaneStreamSubscription {
    const client: ControlPlaneStreamClient = {
      id: this.nextClientId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      domains: input.domains && input.domains.length > 0 ? new Set(input.domains) : undefined,
      response: input.response,
      queue: [],
      overLimitFlushes: 0,
      phase: "provisional",
      closed: false,
    };
    this.nextClientId += 1;
    this.clients.add(client);

    try {
      const replay = input.replayWindow();
      if (replay.window.disposition === "snapshot_required") {
        writeSse(client.response, "control_plane_snapshot_required", replay.window);
        this.closeClient(client);
        return { close: () => this.closeClient(client) };
      }
      mergeClientReplayEvents(client, replay.events);
      flushClientQueueThrough(client, replay.window.upperBoundSeq, () => this.closeClient(client));
      writeSse(client.response, "control_plane_replay_ready", replay.window);
      client.phase = "active";
      flushClientQueue(client, () => this.closeClient(client));
    } catch (error) {
      this.closeClient(client);
      throw error;
    }

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

  subscribeListener(input: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly domains?: readonly ControlPlaneDomain[];
    readonly onEvent: (event: ControlPlaneEvent) => void;
  }): ControlPlaneEventListenerSubscription {
    const client: ControlPlaneEventListenerClient = {
      id: this.nextClientId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      domains: input.domains && input.domains.length > 0 ? new Set(input.domains) : undefined,
      onEvent: input.onEvent,
      queue: [],
      phase: "provisional",
      closed: false,
    };
    this.nextClientId += 1;
    this.listeners.add(client);
    return {
      activate: (replayEvents) => this.activateListener(client, replayEvents),
      close: () => this.closeListener(client),
    };
  }

  publish(event: ControlPlaneEvent): void {
    for (const client of this.clients) {
      if (!clientMatchesEvent(client, event)) {
        continue;
      }
      enqueueClientEvent(client, event, () => this.closeClient(client));
    }
    for (const listener of this.listeners) {
      if (!listenerMatchesEvent(listener, event)) {
        continue;
      }
      enqueueListenerEvent(listener, event);
    }
  }

  closeAll(): void {
    for (const client of [...this.clients]) {
      this.closeClient(client);
    }
    for (const listener of [...this.listeners]) {
      this.closeListener(listener);
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

  private closeListener(client: ControlPlaneEventListenerClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    this.listeners.delete(client);
  }

  private activateListener(client: ControlPlaneEventListenerClient, replayEvents: readonly ControlPlaneEvent[]): void {
    if (client.closed || client.phase === "active") {
      return;
    }
    mergeListenerReplayEvents(client, replayEvents);
    client.phase = "active";
    while (client.queue.length > 0 && !client.closed) {
      const event = client.queue.shift();
      if (event) client.onEvent(event);
    }
  }
}

export function appendControlPlaneEvent(
  store: RunExecutionStoreFacet,
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

function listenerMatchesEvent(client: ControlPlaneEventListenerClient, event: ControlPlaneEvent): boolean {
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
  if (client.phase === "active") scheduleClientFlush(client, close);
}

function mergeClientReplayEvents(client: ControlPlaneStreamClient, replayEvents: readonly ControlPlaneEvent[]): void {
  const bySeq = new Map(client.queue.map((event) => [event.seq, event]));
  for (const event of replayEvents) {
    if (clientMatchesEvent(client, event)) {
      bySeq.set(event.seq, trimOversizedEvent(event));
    }
  }
  client.queue.splice(0, client.queue.length, ...[...bySeq.values()].sort((left, right) => left.seq - right.seq));
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

function flushClientQueueThrough(client: ControlPlaneStreamClient, upperBoundSeq: number, close: () => void): void {
  if (client.closed || client.response.writableEnded) {
    close();
    return;
  }
  while (client.queue.length > 0 && !client.response.writableEnded) {
    const event = client.queue[0];
    if (!event || event.seq > upperBoundSeq) break;
    client.queue.shift();
    writeSse(client.response, "control_plane_event", event);
  }
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
  client.queue.splice(0, client.queue.length, ...coalesceAndSortControlPlaneEvents(client.queue));
}

function enqueueListenerEvent(client: ControlPlaneEventListenerClient, event: ControlPlaneEvent): void {
  if (client.closed) return;
  const trimmed = trimOversizedEvent(event);
  if (client.phase === "active") {
    client.onEvent(trimmed);
    return;
  }
  client.queue.push(trimmed);
}

function mergeListenerReplayEvents(
  client: ControlPlaneEventListenerClient,
  replayEvents: readonly ControlPlaneEvent[],
): void {
  const bySeq = new Map(client.queue.map((event) => [event.seq, event]));
  for (const event of replayEvents) {
    if (listenerMatchesEvent(client, event)) bySeq.set(event.seq, trimOversizedEvent(event));
  }
  client.queue.splice(0, client.queue.length, ...[...bySeq.values()].sort((left, right) => left.seq - right.seq));
}
