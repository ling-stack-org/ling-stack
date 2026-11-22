import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import { LING_PRODUCT_VERSION, type LingAppServerThreadSnapshotResult } from "@ling-stack/contracts";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { CodexDuplex, CodexRpcError } from "../runtime/adapters/codex/duplex.js";
import { connectToAppServer, type AppServerLocalTransportOptions } from "./app-server-local-transport.js";

export interface LingCodexHostOptions extends AppServerLocalTransportOptions {
  readonly threadId: string;
  readonly codexThreadId?: string;
  readonly codexExecutable: string;
  readonly statePath: string;
}

const id = z.string().min(1).max(256);
const text = z.string().min(1).max(16_384);
const turnRevision = { expectedTurnId: id, expectedTurnRevision: id };
const controllerRequest = z.strictObject({ jsonrpc: z.literal("2.0").optional(),
  id: z.union([id, z.number().int()]), method: id, params: z.unknown().optional() });
const queueParams = z.strictObject({ ...turnRevision, message: text, idempotencyKey: id });
const interruptParams = z.strictObject(turnRevision);
const steerParams = z.strictObject({ expectedTurnId: id, eventId: id });

/** A JSONL task view and explicit controller for one Ling and one Codex Thread. */
export async function runLingCodexHost(
  options: LingCodexHostOptions, signal: AbortSignal, input: Readable = process.stdin, output: Writable = process.stdout,
): Promise<void> {
  const url = new URL(options.daemonUrl);
  if (url.username || url.password) throw new Error("Use the App Server bearer header for credentials.");
  const cwd = realpathSync(options.cwd);
  const ling = connectToAppServer(options, "ling-codex-host", true);
  const state = openHostState(options.statePath, JSON.stringify([url.origin, cwd, options.threadId]));
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const lines = createInterface({ input, crlfDelay: Infinity });
  controller.signal.addEventListener("abort", () => lines.close(), { once: true });
  if (controller.signal.aborted) lines.close();
  let codexThreadId = state.read("codex-thread");
  let pendingSnapshot: Promise<void> | undefined;
  let hostError: Error | undefined;
  let cursorGeneration = 0;
  const pendingEvents = new Set<string>();

  function fail(error: Error): void {
    hostError ??= error;
    stop();
  }

  function emit(frame: unknown, applied?: () => void): void {
    if (controller.signal.aborted) return;
    if (output.writableLength > 1024 * 1024) {
      fail(new Error("The control host output is not being consumed."));
      return;
    }
    output.write(JSON.stringify(frame) + "\n", error => {
      if (error) fail(error);
      else if (!controller.signal.aborted && applied) {
        try { applied(); } catch (error) { fail(asError(error)); }
      }
    });
  }

  const emitOutputError = (error: Error) => fail(error);
  output.on("error", emitOutputError);
  const offNotify = ling.onNotification(notification => {
    const params = record(notification.params);
    if (notification.method === "thread/resync/required") {
      emit({ source: "ling", method: notification.method, params });
      if (params?.reason !== "authorization_changed") refreshSubscription();
      return;
    }
    const eventId = typeof params?.eventId === "string" ? params.eventId : undefined;
    const cursor = typeof params?.cursor === "string" ? params.cursor : undefined;
    const sequence = record(params?.event)?.seq ?? record(params?.window)?.nextAfterSeq;
    const position = typeof sequence === "number" && Number.isSafeInteger(sequence) ? sequence : undefined;
    const generation = cursorGeneration;
    if (notification.method === "$/control_plane_event") {
      // Typed notices precede the underlying event frame on the same connection.
      if (cursor) output.write("", error => {
        if (error) fail(error);
        else if (!controller.signal.aborted) {
          try { advanceCursor(cursor, generation, position); } catch (error) { fail(asError(error)); }
        }
      });
      return;
    }
    if (notification.method === "$/run_event") return;
    if (eventId && (pendingEvents.has(eventId) || state.observed(eventId))) return;
    if (eventId) pendingEvents.add(eventId);
    emit({ source: "ling", method: notification.method, params: notification.params }, () => {
      if (eventId) {
        pendingEvents.delete(eventId);
        if (generation === cursorGeneration) state.remember(eventId, notification.method);
      }
      if (cursor) advanceCursor(cursor, generation, position);
    });
  });
  const offRequest = ling.onServerRequest(request => emit({ source: "ling", method: request.method, params: request.params }));
  const offStatus = ling.onConnectionState(status => {
    if (status.state === "connected") {
      try {
        if (state.setAuthorization(JSON.stringify([status.storeIncarnation, status.authorizationEpoch]))) {
          cursorGeneration++;
          pendingEvents.clear();
          emit({ source: "ling", method: "thread/scope/reset" });
        }
      } catch (error) { fail(asError(error)); }
    }
    emit({ source: "ling", method: "connection/status", params: status });
  });

  function advanceCursor(cursor: string, generation: number, position?: number): void {
    if (generation !== cursorGeneration) return;
    state.advanceCursor(cursor, position ?? -1);
  }

  async function freshSubscription(): Promise<void> {
    const snapshot = await ling.readThreadSnapshot({ threadId: options.threadId });
    const generation = ++cursorGeneration;
    state.clearCursor();
    emit({ source: "ling", method: "thread/snapshot", params: publicSnapshot(snapshot) }, () => advanceCursor(snapshot.cursor, generation));
    const next = await ling.subscribe({ threadId: options.threadId, cursor: snapshot.cursor });
    if (next.disposition !== "complete") throw new Error("Ling could not subscribe from the current snapshot.");
  }

  function refreshSubscription(): void {
    pendingSnapshot ??= freshSubscription()
      .catch(error => emit({ source: "ling", method: "thread/resync/failed", error: errorProjection(error) }))
      .finally(() => { pendingSnapshot = undefined; });
  }

  const env = { ...process.env };
  delete env.LING_STACK_AUTH_TOKEN;
  const codexProcess = spawn(options.codexExecutable, ["app-server", "--stdio"], {
    cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  });
  const reaped = new Promise<void>(resolve => codexProcess.once("close", () => resolve()));
  codexProcess.once("error", fail);
  const codex = new CodexDuplex({ input: codexProcess.stdin, output: codexProcess.stdout, signal: controller.signal,
    onNotification(notification) {
      if (codexThreadId && record(notification.params)?.threadId === codexThreadId) {
        emit({ source: "codex", method: notification.method, params: notification.params });
      }
    },
  });
  void codex.closed.then(error => {
    if (!controller.signal.aborted) emit({ source: "codex", method: "connection/status", params: { status: "closed", error: errorProjection(error) } });
  });

  try {
    if (options.codexThreadId && codexThreadId && codexThreadId !== options.codexThreadId) {
      throw new Error("The host state belongs to another Codex Thread.");
    }
    const initialized = await codex.request("initialize", { clientInfo: { name: "ling-codex-host", version: LING_PRODUCT_VERSION },
      capabilities: { experimentalApi: true } });
    const userAgent = record(initialized)?.userAgent;
    if (typeof userAgent !== "string") throw new Error("Codex did not negotiate its App Server protocol.");
    await codex.notify("initialized");
    const selectedThread = options.codexThreadId ?? codexThreadId;
    if (selectedThread) await bindCodexThread(await codex.request("thread/resume", { threadId: selectedThread, cwd, excludeTurns: true }), selectedThread);
    const cursor = state.readCursor();
    const restored = cursor ? await ling.subscribe({ threadId: options.threadId, cursor }) : undefined;
    if (!restored || restored.disposition !== "complete") await freshSubscription();
    emit({ source: "host", method: "ready", params: { threadId: options.threadId, codexThreadId, codexUserAgent: userAgent,
      resumed: restored?.disposition === "complete" } });

    for await (const line of lines) {
      if (controller.signal.aborted) break;
      if (!line.trim()) continue;
      let request: z.infer<typeof controllerRequest> | undefined;
      try {
        if (Buffer.byteLength(line) > 65_536) throw new Error("The control host command exceeds 64 KiB.");
        request = controllerRequest.parse(JSON.parse(line));
        emit({ id: request.id, result: await dispatch(request.method, request.params) });
      } catch (error) {
        emit({ id: request?.id ?? null, error: errorProjection(error) });
      }
    }
    if (hostError) throw hostError;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    offNotify();
    offRequest();
    offStatus();
    ling.close();
    codex.close();
    lines.close();
    codexProcess.stdin.end();
    const deadline = setTimeout(() => codexProcess.kill("SIGKILL"), 2_000);
    try { await reaped; } finally { clearTimeout(deadline); }
    await pendingSnapshot;
    state.close();
    output.off("error", emitOutputError);
  }

  async function bindCodexThread(response: unknown, expectedId?: string): Promise<unknown> {
    const thread = record(record(response)?.thread);
    const resultId = id.parse(thread?.id);
    if (expectedId && resultId !== expectedId || typeof thread?.cwd !== "string" || realpathSync(thread.cwd) !== cwd) {
      throw new Error("The Codex Thread does not match the control host binding.");
    }
    state.write("codex-thread", resultId);
    codexThreadId = resultId;
    emit({ source: "host", method: "codex/thread/bound", params: { codexThreadId } });
    return { threadId: resultId };
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "ling/snapshot":
        return publicSnapshot(await ling.readThreadSnapshot({ threadId: options.threadId }));
      case "ling/queue":
        return ling.queueTurn({ threadId: options.threadId, ...queueParams.parse(params) });
      case "ling/interrupt":
        return ling.interruptTurn({ threadId: options.threadId, ...interruptParams.parse(params) });
      case "codex/thread/start":
        if (codexThreadId) return { threadId: codexThreadId };
        return bindCodexThread(await codex.request("thread/start", { cwd }));
      case "codex/snapshot":
        return codex.request("thread/read", { threadId: id.parse(codexThreadId), includeTurns: true });
      case "codex/turn/start":
        return codex.request("turn/start", { threadId: id.parse(codexThreadId), input: [{ type: "text", text: text.parse(record(params)?.message), text_elements: [] }] });
      case "codex/steer": {
        const threadId = id.parse(codexThreadId);
        const { expectedTurnId, eventId } = steerParams.parse(params);
        if (!state.observed(eventId)) throw new Error("Select a durable Ling event observed in this host.");
        const key = JSON.stringify([threadId, expectedTurnId, eventId]);
        const existing = state.delivery(key);
        if (existing && existing.status !== "retryable") return { ...existing, replayed: true };
        if (!state.reserveDelivery(key)) return { ...state.delivery(key), replayed: true };
        let status: "accepted" | "rejected" | "retryable" | "unknown" = "unknown";
        let remoteCode: number | undefined;
        let failureCode: string | undefined;
        try {
          const response = await codex.request("turn/steer", { threadId, expectedTurnId,
            input: [{ type: "text", text: `Ling event reference: ${eventId}`, text_elements: [] }] });
          if (record(response)?.turnId === expectedTurnId) status = "accepted";
          else failureCode = "unexpected_reply";
        } catch (error) {
          const failure = error instanceof CodexRpcError ? error : undefined;
          remoteCode = failure?.remoteCode;
          if (failure?.requestWrite === "not_written") status = "retryable";
          else if (failure?.code === "remote_error" && [-32601, -32602].includes(remoteCode ?? 0)) status = "rejected";
          if (status !== "rejected") failureCode = failure?.code ?? "delivery_unconfirmed";
        }
        state.finishDelivery(key, status, remoteCode, failureCode);
        return state.delivery(key);
      }
      default:
        throw Object.assign(new Error("Unsupported control host method."), { code: "method_not_found" });
    }
  }
}

function openHostState(path: string, binding: string) {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("Control host state must be a regular file.");
  } finally { closeSync(descriptor); }
  const unlock = lockfile.lockSync(path);
  let database: DatabaseSync | undefined;
  try {
    const db = database = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS host_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ling_replay (id INTEGER PRIMARY KEY, cursor TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observed_events (id TEXT PRIMARY KEY, method TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, status TEXT NOT NULL, remote_code INTEGER, failure_code TEXT);`);
    db.prepare("INSERT OR IGNORE INTO host_state(key,value) VALUES ('binding', ?)").run(binding);
    const read = (key: string) => db.prepare("SELECT value FROM host_state WHERE key=?").get(key)?.value as string | undefined;
    if (read("binding") !== binding) throw new Error("The control host state belongs to a different Ling workspace or Thread.");
    if (!db.prepare("PRAGMA table_info(deliveries)").all().some(column => column.name === "failure_code")) {
      db.exec("ALTER TABLE deliveries ADD COLUMN failure_code TEXT");
    }
    return {
      read,
      write: (key: string, value: string) => db.prepare("INSERT OR REPLACE INTO host_state(key,value) VALUES (?, ?)").run(key, value),
      advanceCursor(cursor: string, position: number) {
        db.prepare(`INSERT INTO ling_replay(id,cursor,position) VALUES(1,?,?)
          ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor, position=excluded.position WHERE excluded.position >= ling_replay.position`)
          .run(cursor, position);
      },
      readCursor: () => db.prepare("SELECT cursor FROM ling_replay WHERE id=1").get()?.cursor as string | undefined,
      clearCursor: () => db.exec("DELETE FROM ling_replay"),
      setAuthorization(authorization: string) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const previous = read("authorization");
          const changed = previous !== undefined && previous !== authorization;
          if (changed) db.exec("DELETE FROM observed_events; DELETE FROM ling_replay");
          db.prepare("INSERT OR REPLACE INTO host_state(key,value) VALUES ('authorization', ?)").run(authorization);
          db.exec("COMMIT");
          return changed;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      observed: (eventId: string) => Boolean(db.prepare("SELECT 1 FROM observed_events WHERE id=?").get(eventId)),
      remember: (eventId: string, method: string) => db.prepare("INSERT OR IGNORE INTO observed_events(id,method) VALUES (?, ?)").run(eventId, method),
      delivery: (key: string) => {
        const row = db.prepare("SELECT status, remote_code, failure_code FROM deliveries WHERE id=?").get(key);
        return row ? { status: row.status, ...(row.remote_code === null ? {} : { remoteCode: row.remote_code }),
          ...(row.failure_code === null ? {} : { failureCode: row.failure_code }) } : undefined;
      },
      reserveDelivery: (key: string) => db.prepare(`INSERT INTO deliveries(id,status) VALUES (?, 'unknown')
        ON CONFLICT(id) DO UPDATE SET status='unknown', remote_code=NULL, failure_code=NULL WHERE deliveries.status='retryable'`).run(key).changes === 1,
      finishDelivery: (key: string, status: "accepted" | "rejected" | "retryable" | "unknown", remoteCode?: number, failureCode?: string) =>
        db.prepare("UPDATE deliveries SET status=?, remote_code=?, failure_code=? WHERE id=? AND status='unknown'")
          .run(status, remoteCode ?? null, failureCode ?? null, key),
      close: () => { try { db.close(); } finally { unlock(); } },
    };
  } catch (error) {
    try { database?.close(); } finally { unlock(); }
    throw error;
  }
}

function publicSnapshot(snapshot: LingAppServerThreadSnapshotResult) {
  return { ...snapshot, pendingInputs: snapshot.pendingInputs.map(({ answerAuthority: _authority, ...input }) => input) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorProjection(error: unknown) {
  return { code: record(error)?.code ?? "invalid_request", message: asError(error).message };
}
