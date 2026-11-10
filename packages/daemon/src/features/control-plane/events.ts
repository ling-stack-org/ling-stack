import type { ServerResponse } from "node:http";
import type {
  AppendControlPlaneEventInput,
  ControlPlaneDomain,
  ControlPlaneEvent,
  RunExecutionStoreFacet,
} from "@ling-stack/core";
import type { ControlPlaneReplayWindow } from "@ling-stack/contracts";
import { SseStreamWriter, SSE_STREAM_MAX_BUFFERED_BYTES, type SseStreamWriterOptions } from "../../shared/sse-stream-writer.js";
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
  writer: SseStreamWriter;
  readonly queue: ControlPlaneEvent[];
  heartbeatTimer?: NodeJS.Timeout;
  initialHeartbeatTimer?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  phase: "provisional" | "active";
  closed: boolean;
}

interface ControlPlaneEventListenerClient {
  readonly id: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly domains?: ReadonlySet<ControlPlaneDomain>;
  readonly onEvent: (event: ControlPlaneEvent) => void;
  readonly onPendingChange?: (bytes: number, count: number) => boolean;
  readonly onOverflow?: () => void;
  readonly queue: ControlPlaneEvent[];
  phase: "provisional" | "activating" | "active";
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
    readonly initialComment?: string;
    readonly writerOptions?: SseStreamWriterOptions;
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
      writer: undefined as unknown as SseStreamWriter,
      phase: "provisional",
      closed: false,
    };
    this.nextClientId += 1;
    client.writer = new SseStreamWriter(input.response, { ...input.writerOptions,
      retainedUpstream: () => ({ bytes: queueBytes(client.queue), count: client.queue.length }),
      onClose: () => {
        this.closeClient(client);
        input.writerOptions?.onClose?.();
      } });
    this.clients.add(client);

    try {
      if (input.initialComment) client.writer.writeComment(input.initialComment);
      if (client.closed) return { close: () => this.closeClient(client) };
      const replay = input.replayWindow();
      if (replay.window.disposition === "snapshot_required") {
        client.writer.write("control_plane_snapshot_required", replay.window);
        this.retireClient(client);
        client.writer.finish();
        return { close: () => this.closeClient(client) };
      }
      mergeClientReplayEvents(client, replay.events, () => this.closeClient(client));
      if (client.closed) return { close: () => this.closeClient(client) };
      flushClientQueueThrough(client, replay.window.upperBoundSeq, () => this.closeClient(client));
      client.writer.write("control_plane_replay_ready", replay.window);
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
      client.writer.write("heartbeat", {
        ts: new Date().toISOString(),
        latestEventSeq: input.latestEventSeq(),
      }, "heartbeat");
    };
    if (client.closed) return { close: () => this.closeClient(client) };
    client.heartbeatTimer = setInterval(sendHeartbeat, CONTROL_PLANE_SSE_HEARTBEAT_MS);
    client.initialHeartbeatTimer = setTimeout(() => { client.initialHeartbeatTimer = undefined; sendHeartbeat(); }, 0);

    return {
      close: () => this.closeClient(client),
    };
  }

  subscribeListener(input: {
    readonly workspaceId: string;
    readonly cwd: string;
    readonly domains?: readonly ControlPlaneDomain[];
    readonly onEvent: (event: ControlPlaneEvent) => void;
    readonly onPendingChange?: (bytes: number, count: number) => boolean;
    readonly onOverflow?: () => void;
  }): ControlPlaneEventListenerSubscription {
    const client: ControlPlaneEventListenerClient = {
      id: this.nextClientId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      domains: input.domains && input.domains.length > 0 ? new Set(input.domains) : undefined,
      onEvent: input.onEvent,
      onPendingChange: input.onPendingChange,
      onOverflow: input.onOverflow,
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
      if (client.closed || !clientMatchesEvent(client, event)) {
        continue;
      }
      enqueueClientEvent(client, event, () => this.closeClient(client));
    }
    for (const listener of this.listeners) {
      if (!listenerMatchesEvent(listener, event)) {
        continue;
      }
      enqueueListenerEvent(listener, event, () => this.closeListener(listener));
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
    this.retireClient(client);
    this.clients.delete(client);
    client.writer.close();
  }

  private retireClient(client: ControlPlaneStreamClient): void {
    if (client.closed) return;
    client.closed = true;
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
    }
    if (client.flushTimer) {
      clearTimeout(client.flushTimer);
    }
    if (client.initialHeartbeatTimer) clearTimeout(client.initialHeartbeatTimer);
    client.heartbeatTimer = undefined;
    client.flushTimer = undefined;
    client.initialHeartbeatTimer = undefined;
    client.queue.length = 0;
  }

  private closeListener(client: ControlPlaneEventListenerClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    client.queue.length = 0;
    this.listeners.delete(client);
    client.onPendingChange?.(0, 0);
  }

  private activateListener(client: ControlPlaneEventListenerClient, replayEvents: readonly ControlPlaneEvent[]): void {
    if (client.closed || client.phase !== "provisional") {
      return;
    }
    mergeListenerReplayEvents(client, replayEvents, () => this.closeListener(client));
    if (client.closed) return;
    client.phase = "activating";
    while (client.queue.length > 0 && !client.closed) {
      const event = client.queue.shift();
      if (!checkListenerCapacity(client, () => this.closeListener(client))) return;
      if (event && !client.closed) client.onEvent(event);
    }
    if (!client.closed) client.phase = "active";
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
  if (!client.writer.checkCapacity()) return;
  if (client.phase === "active") scheduleClientFlush(client, close);
}

function mergeClientReplayEvents(client: ControlPlaneStreamClient, replayEvents: readonly ControlPlaneEvent[], close: () => void): void {
  for (const event of replayEvents) {
    if (client.closed) return;
    if (clientMatchesEvent(client, event)) {
      const index = client.queue.findIndex(candidate => candidate.seq === event.seq);
      if (index >= 0) client.queue[index] = trimOversizedEvent(event);
      else enqueueClientEvent(client, event, close);
    }
    if (!client.writer.checkCapacity()) return;
  }
  client.queue.sort((left, right) => left.seq - right.seq);
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
  while (client.queue.length > 0 && !client.closed && !client.response.writableEnded) {
    const event = client.queue[0];
    if (!event || event.seq > upperBoundSeq) break;
    client.queue.shift();
    if (!client.writer.write("control_plane_event", event)) return;
  }
}

function flushClientQueue(client: ControlPlaneStreamClient, close: () => void): void {
  if (client.closed || client.response.writableEnded) {
    close();
    return;
  }

  while (client.queue.length > 0 && !client.closed && !client.response.writableEnded) {
    const event = client.queue.shift();
    if (event) {
      if (!client.writer.write("control_plane_event", event)) return;
    }
  }
}

function coalesceClientQueue(client: ControlPlaneStreamClient): void {
  client.queue.splice(0, client.queue.length, ...coalesceAndSortControlPlaneEvents(client.queue));
}

function enqueueListenerEvent(client: ControlPlaneEventListenerClient, event: ControlPlaneEvent, close: () => void): void {
  if (client.closed) return;
  const trimmed = trimOversizedEvent(event);
  if (client.phase === "active") {
    client.onEvent(trimmed);
    return;
  }
  client.queue.push(trimmed);
  if (client.queue.length >= CONTROL_PLANE_SSE_QUEUE_WARNING_THRESHOLD) {
    client.queue.splice(0, client.queue.length, ...coalesceAndSortControlPlaneEvents(client.queue));
  }
  checkListenerCapacity(client, close);
}

function mergeListenerReplayEvents(
  client: ControlPlaneEventListenerClient,
  replayEvents: readonly ControlPlaneEvent[],
  close: () => void,
): void {
  for (const event of replayEvents) {
    if (client.closed) return;
    if (listenerMatchesEvent(client, event)) {
      const index = client.queue.findIndex(candidate => candidate.seq === event.seq);
      if (index >= 0) client.queue[index] = trimOversizedEvent(event);
      else enqueueListenerEvent(client, event, close);
    }
    if (!checkListenerCapacity(client, close)) return;
  }
  client.queue.sort((left, right) => left.seq - right.seq);
}

function queueBytes(queue: readonly ControlPlaneEvent[]): number {
  return queue.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 64, 0);
}

function checkListenerCapacity(client: ControlPlaneEventListenerClient, close: () => void): boolean {
  if (client.closed) return false;
  const bytes = queueBytes(client.queue);
  if (client.queue.length > CONTROL_PLANE_SSE_QUEUE_HARD_LIMIT || bytes > SSE_STREAM_MAX_BUFFERED_BYTES ||
    client.onPendingChange?.(bytes, client.queue.length) === false) {
    close();
    client.onOverflow?.();
    return false;
  }
  return true;
}
