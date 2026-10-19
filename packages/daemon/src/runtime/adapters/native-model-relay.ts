import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest, validateHeaderName, validateHeaderValue, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface NativeModelRoute {
  readonly path: string;
  readonly upstreamUrl: string;
  /** Omit only for an exact route whose URL already identifies the selected model. */
  readonly modelId?: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Only Anthropic protocol features may come from the native request; auth stays host-owned. */
  readonly forwardAnthropicBeta?: boolean;
}
export interface NativeModelRelayOptions {
  readonly routes: readonly NativeModelRoute[];
  readonly signal: AbortSignal;
  /** Revalidate the host's execution/profile owner immediately before forwarding. */
  readonly assertCurrent?: () => void;
  /** Host-only current credentials; native route/body fields never select this callback. */
  readonly resolveHeaders?: (signal: AbortSignal) => Promise<Readonly<Record<string, string>>>;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxConcurrentRequests?: number;
}

const tokenHeader = "x-ling-model-token";
const invalid = (): Error => new Error("native_model_relay_invalid");
const forbiddenHeader = /^(host|connection|content-length|content-type|transfer-encoding|upgrade|expect|trailer|te|origin|referer|cookie|proxy-.*|x-forwarded-.*|forwarded|x-ling-model-token)$/i;

/** One execution's fixed inference routes, never a general-purpose network proxy. */
export async function openNativeModelRelay(options: NativeModelRelayOptions) {
  options.signal.throwIfAborted();
  const routes = validateRoutes(options.routes);
  const timeout = bounded(options.timeoutMs, 300_000, 600_000);
  const requestLimit = bounded(options.maxRequestBytes, 16 * 1024 * 1024, 16 * 1024 * 1024);
  const responseLimit = bounded(options.maxResponseBytes, 128 * 1024 * 1024, 128 * 1024 * 1024);
  const concurrency = bounded(options.maxConcurrentRequests, 4, 4);
  const assertCurrent = options.assertCurrent;
  const resolveHeaders = options.resolveHeaders;
  if (resolveHeaders !== undefined && typeof resolveHeaders !== "function") throw invalid();
  const token = randomBytes(32).toString("hex"), expectedToken = Buffer.from(token);
  const active = new Map<AbortController, Promise<void>>();
  let closing: Promise<void> | undefined;
  let baseUrl = "";
  const server = createServer({ maxHeaderSize: 8192 }, (incoming, outgoing) => {
    if (closing || active.size >= concurrency) { reject(outgoing, 503); return; }
    const controller = new AbortController();
    const expiresAt = performance.now() + timeout;
    const deadline = setTimeout(() => controller.abort(), timeout);
    const abort = (): void => controller.abort();
    incoming.once("aborted", abort);
    outgoing.once("close", abort);
    const task = forward(incoming, outgoing, controller.signal, expiresAt).catch(() => {
      if (outgoing.headersSent) outgoing.destroy(); else reject(outgoing, 502);
    }).finally(() => {
      clearTimeout(deadline);
      incoming.removeListener("aborted", abort);
      outgoing.removeListener("close", abort);
      active.delete(controller);
    });
    active.set(controller, task);
  });
  server.maxConnections = 32;
  server.maxHeadersCount = 32;
  server.requestTimeout = timeout;
  server.headersTimeout = Math.min(timeout, 5000);
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 32;
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());

  async function forward(incoming: IncomingMessage, outgoing: ServerResponse, signal: AbortSignal, expiresAt: number): Promise<void> {
    const assertRequestCurrent = (): void => {
      assertLive();
      assertCurrent?.();
      assertLive();
    };
    const assertLive = (): void => {
      signal.throwIfAborted();
      if (performance.now() >= expiresAt) throw invalid();
    };
    const authorization = incoming.headers[tokenHeader];
    const route = routes.get(incoming.url ?? "");
    if (typeof authorization !== "string" || !/^[a-f0-9]{64}$/.test(authorization)
      || !timingSafeEqual(Buffer.from(authorization), expectedToken)) { reject(outgoing, 401); return; }
    if (incoming.method !== "POST" || !route || incoming.headers.origin !== undefined
      || incoming.headers.host !== new URL(baseUrl).host
      || !/^application\/json(?:\s*;|$)/i.test(incoming.headers["content-type"] ?? "")
      || incoming.headers["content-encoding"] !== undefined) { reject(outgoing, 400); return; }
    if (Number(incoming.headers["content-length"] ?? 0) > requestLimit) { reject(outgoing, 413); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    const abortRead = (): void => { incoming.destroy(); };
    signal.addEventListener("abort", abortRead, { once: true });
    try {
      signal.throwIfAborted();
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > requestLimit) throw invalid();
        chunks.push(chunk);
      }
    } finally { signal.removeEventListener("abort", abortRead); }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { reject(outgoing, 400); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (route.modelId !== undefined && (!Object.hasOwn(value, "model")
        || (value as Record<string, unknown>).model !== route.modelId))
      || (route.modelId === undefined && Object.hasOwn(value, "model"))) { reject(outgoing, 400); return; }
    const body = Buffer.from(JSON.stringify(value));
    const featureHeaders: Record<string, string> = {};
    const beta = incoming.headers["anthropic-beta"];
    if (route.forwardAnthropicBeta && beta !== undefined) {
      if (typeof beta !== "string" || beta.length > 2048 || !/^[a-z0-9-]+(?:,\s*[a-z0-9-]+)*$/i.test(beta)) {
        reject(outgoing, 400); return;
      }
      featureHeaders["anthropic-beta"] = beta;
    }
    assertRequestCurrent();
    const credentialHeaders = resolveHeaders ? await resolveHostHeaders(resolveHeaders, signal) : {};
    if (resolveHeaders) assertRequestCurrent();
    const upstream = (route.upstream.protocol === "https:" ? httpsRequest : httpRequest)(route.upstream, {
      method: "POST", agent: false, signal,
      headers: { ...featureHeaders, ...route.headers, ...credentialHeaders, "content-type": "application/json", "content-length": body.length, "accept-encoding": "identity" },
    });
    let upstreamResponse: IncomingMessage | undefined;
    upstream.on("error", error => upstreamResponse?.destroy(error));
    const response = waitForResponse(upstream, signal);
    upstream.end(body);
    const result = await response;
    upstreamResponse = result;
    try {
      const status = result.statusCode ?? 502;
      const contentType = result.headers["content-type"] ?? "";
      if ((status >= 300 && status < 400) || !/^(application\/json|text\/event-stream)(?:\s*;|$)/i.test(contentType)
        || (result.headers["content-encoding"] && result.headers["content-encoding"] !== "identity")) {
        reject(outgoing, 502); return;
      }
      outgoing.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
      let bytes = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(bytes > responseLimit ? invalid() : null, bytes > responseLimit ? undefined : chunk);
      } });
      await pipeline(result, limiter, outgoing, { signal });
    } finally { result.destroy(); upstream.destroy(); }
  }

  const abort = (): void => { void close(); };
  let lifetime: NodeJS.Timeout | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      options.signal.removeEventListener("abort", abort);
      clearTimeout(lifetime);
      for (const controller of active.keys()) controller.abort();
      await new Promise<void>((resolve, rejectClose) => {
        server.close(error => error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING") ? rejectClose(error) : resolve());
        server.closeAllConnections();
      });
      await Promise.all(active.values());
    })();
  }
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw invalid();
    baseUrl = `http://127.0.0.1:${address.port}`;
    options.signal.addEventListener("abort", abort, { once: true });
    options.signal.throwIfAborted();
    lifetime = setTimeout(abort, 60 * 60 * 1000);
    lifetime.unref();
    return { baseUrl, port: address.port, headers: Object.freeze({ [tokenHeader]: token }), close };
  } catch (error) { await close(); throw error; }
}

function waitForResponse(request: ClientRequest, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, rejectResponse) => {
    let settled = false;
    const finish = (response?: IncomingMessage): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", fail);
      request.removeListener("error", fail);
      request.removeListener("close", fail);
      request.removeListener("upgrade", upgrade);
      request.removeListener("response", finish);
      if (response) resolve(response);
      else { request.destroy(); rejectResponse(invalid()); }
    };
    const fail = (): void => finish();
    const upgrade = (_response: IncomingMessage, socket: Socket): void => { socket.destroy(); fail(); };
    request.once("response", finish);
    request.once("error", fail);
    request.once("close", fail);
    request.once("upgrade", upgrade);
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
  });
}

async function resolveHostHeaders(resolve: NonNullable<NativeModelRelayOptions["resolveHeaders"]>, signal: AbortSignal) {
  let abort = (): void => {};
  const stopped = new Promise<never>((_resolve, rejectHeaders) => {
    abort = () => rejectHeaders(invalid());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const operation = (async () => { signal.throwIfAborted(); return resolve(signal); })();
  try { return validateHeaders(await Promise.race([operation, stopped])); }
  finally { signal.removeEventListener("abort", abort); }
}

function validateRoutes(input: readonly NativeModelRoute[]) {
  if (!Array.isArray(input) || !input.length || input.length > 16) throw invalid();
  const routes = new Map<string, NativeModelRoute & { readonly upstream: URL }>();
  for (const item of structuredClone(input)) {
    if (typeof item.path !== "string" || !/^\/[a-zA-Z0-9_/?=:.%+-]+$/.test(item.path)
      || item.path.includes("..") || item.path.startsWith("//") || routes.has(item.path)
      || (item.forwardAnthropicBeta !== undefined && typeof item.forwardAnthropicBeta !== "boolean")
      || (item.modelId !== undefined && (typeof item.modelId !== "string" || !item.modelId.trim()))) throw invalid();
    const upstream = new URL(item.upstreamUrl);
    if (!["https:", "http:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.hash) throw invalid();
    routes.set(item.path, { ...item, headers: validateHeaders(item.headers), upstream });
  }
  return routes;
}
function validateHeaders(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (forbiddenHeader.test(key) || typeof value !== "string") throw invalid();
    validateHeaderName(key); validateHeaderValue(key, value);
    headers[key.toLowerCase()] = value;
  }
  return headers;
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw invalid();
  return selected;
}
function reject(response: ServerResponse, status: number): void {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end('{"error":{"message":"Native model request failed"}}');
}
