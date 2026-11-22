import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { z } from "zod";
import { readJsonBody } from "../shared/request.js";
import { isRecord } from "../shared/validation.js";
import { runLingCodexHost, type LingCodexHostOptions } from "./app-server-codex-host.js";
import { codexHostViewHtml, codexHostViewScript, codexHostViewStyles } from "./codex-host-view-content.js";

const command = z.strictObject({
  method: z.enum(["ling/snapshot", "ling/queue", "ling/interrupt", "codex/thread/start", "codex/snapshot", "codex/turn/start", "codex/steer"]),
  params: z.unknown().optional(),
});

const maxActivityEntries = 100;
const maxViewConnections = 8;
const commandTimeout = 30_000;

export async function runLingCodexHostView(
  options: LingCodexHostOptions, signal: AbortSignal, onListen: (url: string) => void,
): Promise<void> {
  if (signal.aborted) return;
  const accessKey = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${accessKey}`);
  const sessions = new Set<ServerResponse>();
  const pending = new Map<number, (status: number, frame: unknown) => void>();
  const history: { readonly sequence: number; readonly source: string; readonly line: string }[] = [];
  const input = new PassThrough();
  let authority = "";
  let commandId = 0;
  let eventId = 0;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        if (!chunk.length) return done();
        const frame: unknown = JSON.parse(chunk.toString("utf8"));
        if (!isRecord(frame)) return done();
        if (typeof frame.id === "number") {
          pending.get(frame.id)?.(frame.error ? 409 : 200, frame);
        } else {
          const activity = projectActivity(frame);
          if (activity) {
            if (activity.resetLing) {
              for (let index = history.length - 1; index >= 0; index--) {
                if (history[index]?.source === "ling") history.splice(index, 1);
              }
            }
            const sequence = ++eventId;
            const line = JSON.stringify({ ...activity, sequence }) + "\n";
            history.push({ source: activity.source, sequence, line });
            if (history.length > maxActivityEntries) history.shift();
            for (const session of sessions) {
              if (session.writableLength > 256 * 1024) session.destroy();
              else session.write(line);
            }
          }
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) reply(response, 400, { error: "Invalid browser command." });
    });
  });
  server.requestTimeout = commandTimeout;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The Codex host view could not bind to loopback.");
    authority = `127.0.0.1:${address.port}`;
    if (signal.aborted) return;
    onListen(`http://${authority}/#${accessKey}`);
    await runLingCodexHost(options, signal, input, output);
  } finally {
    for (const finish of pending.values()) finish(503, { error: "The Codex host has stopped." });
    for (const session of sessions) session.end();
    input.destroy();
    output.destroy();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    if (!authority || request.headers.host !== authority) {
      reply(response, 421, { error: "Use the loopback address shown by the Codex host." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${authority}`);
    if (request.method === "GET") {
      if (url.pathname === "/") return asset(response, "text/html", codexHostViewHtml);
      if (url.pathname === "/view.js") return asset(response, "text/javascript", codexHostViewScript);
      if (url.pathname === "/view.css") return asset(response, "text/css", codexHostViewStyles);
    }
    const presented = Buffer.from(request.headers.authorization ?? "");
    if (presented.length !== authorization.length || !timingSafeEqual(presented, authorization)) {
      reply(response, 401, { error: "Open the private URL printed by the Codex host." });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      if (sessions.size >= maxViewConnections) {
        reply(response, 503, { error: "Close an existing Codex host view." });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" });
      response.flushHeaders();
      const after = Number(url.searchParams.get("after") ?? "0");
      const checkpoint = Number.isSafeInteger(after) && after >= 0 ? after : 0;
      for (const entry of history) if (entry.sequence > checkpoint) response.write(entry.line);
      sessions.add(response);
      response.once("close", () => sessions.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/command") {
      if (request.headers.origin !== `http://${authority}`) {
        reply(response, 403, { error: "The browser command must come from this Codex host view." });
        return;
      }
      if (pending.size >= 16) {
        reply(response, 503, { error: "Wait for outstanding commands before retrying." });
        return;
      }
      const payload = command.parse(await readJsonBody(request, 64 * 1024));
      if (response.destroyed) return;
      const id = ++commandId;
      const release = () => { clearTimeout(deadline); pending.delete(id); };
      const finish = (status: number, frame: unknown) => { release(); reply(response, status, frame); };
      const deadline = setTimeout(() => finish(504, { error: "Command outcome is unknown. Check the current session before retrying." }), commandTimeout);
      response.once("close", release);
      pending.set(id, finish);
      input.write(JSON.stringify({ ...payload, id }) + "\n");
      return;
    }
    reply(response, 404, { error: "This Codex host route is unavailable." });
  }
}

function projectActivity(frame: Record<string, unknown>) {
  if (typeof frame.method !== "string" || (frame.source !== "ling" && frame.source !== "codex" && frame.source !== "host")) return undefined;
  const params = isRecord(frame.params) ? frame.params : {};
  const event = isRecord(params.event) ? params.event : {};
  const turn = isRecord(params.turn) ? params.turn : {};
  const data = isRecord(event.data) ? event.data : {};
  const method = frame.method;
  if (frame.source === "codex" && !method.startsWith("turn/") && method !== "connection/status") return undefined;
  const state = params.state ?? params.status ?? turn.status;
  const turnId = turn.id ?? params.turnId ?? data.turnId;
  return {
    source: frame.source, method,
    ...(typeof params.eventId === "string" ? { eventId: params.eventId } : {}),
    ...(typeof turnId === "string" ? { turnId } : {}),
    ...(typeof state === "string" ? { state } : {}),
    ...(frame.source === "host" && typeof params.codexThreadId === "string" ? { codexThreadId: params.codexThreadId } : {}),
    ...(frame.source === "ling" && (method === "thread/scope/reset"
      || method === "thread/resync/required" && params.reason === "authorization_changed"
      || method === "connection/status" && state === "authorization_required") ? { resetLing: true } : {}),
  };
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (!response.destroyed) response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

function asset(response: ServerResponse, contentType: string, value: string): void {
  response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` }).end(value);
}
