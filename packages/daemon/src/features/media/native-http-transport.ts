import { createHash } from "node:crypto";
import { takePinnedPublicHttpRequest } from "../../shared/public-http-transport.js";

const nativeFetch = globalThis.fetch.bind(globalThis);
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
const CLEANUP_DEADLINE_MS = 1_000;
const SAFE_WIRE_HEADERS = ["accept", "content-encoding", "content-length", "content-type", "if-match", "if-none-match"] as const;
const issuedTransports = new WeakSet<HostMediaNativeTransport>();
declare const exchangeBrand: unique symbol;

/** Non-secret identity of the exact materialized request, not its earlier intent. */
export interface HostMediaWireRequest {
  readonly method: string;
  readonly routeDigest: string;
  readonly wireDigest: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodySha256: string;
  readonly bodySizeBytes: number;
}
/** A complete actual response. It is not a remote terminal or whole-chain safe receipt. */
export interface HostMediaHttpExchange {
  readonly [exchangeBrand]: true;
  readonly request: HostMediaWireRequest;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly bodySha256: string;
  readonly bodySizeBytes: number;
  readonly completedAt: string;
}
export interface HostMediaNativeTransport {
  readonly fetch: typeof globalThis.fetch;
  assertExchange(exchange: HostMediaHttpExchange): void;
  readExchange(response: Response): HostMediaHttpExchange;
  /** Parse the privately held actual bytes, never caller-shaped recovery JSON. */
  readJson(exchange: HostMediaHttpExchange): unknown;
}
interface TransportOptions {
  /** Host-owned local generation signal; caller/Provider deadlines remain independently effective. */
  readonly signal?: AbortSignal;
  /** Called after serialization, immediately around the one actual native send. */
  readonly launch: (mode: "forward" | "observation", request: HostMediaWireRequest, send: () => void) => void;
  readonly onCompleted?: (exchange: HostMediaHttpExchange) => void;
  readonly maxResponseBytes?: number;
}

/**
 * Native-only producer. No injectable fetch/Response can mint these facts.
 * Multipart serialization occurs once before launch; those same bytes and
 * headers go on the wire. Redirects fail closed. The vendor receives a buffered
 * Response only after its original body reaches EOF, so helpers which swallow
 * body read failures cannot accidentally create completed transport evidence.
 */
export function createHostMediaNativeTransport(options: TransportOptions): HostMediaNativeTransport {
  if (Reflect.ownKeys(options).some(key => typeof key !== "string" || !["launch", "onCompleted", "maxResponseBytes", "signal"].includes(key))) {
    throw new Error("media_native_transport_invalid_option");
  }
  assertSynchronousHook(options.launch);
  if (options.onCompleted) assertSynchronousHook(options.onCompleted);
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new Error("media_native_transport_invalid_response_budget");
  }
  // Capture hooks before the first await; mutation of an options object does not
  // change authority halfway through request preparation or body consumption.
  const { launch, onCompleted, signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("media_native_transport_invalid_signal");
  const responses = new WeakMap<Response, HostMediaHttpExchange>();
  const bodies = new WeakMap<HostMediaHttpExchange, Uint8Array>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const pinned = takePinnedPublicHttpRequest(input, init);
    try {
      // Request copies URL, headers and body state synchronously. The caller's
      // FormData or Headers is no longer authoritative after this point.
      const original = new Request(input, { ...init, redirect: "error" });
      // Fragments are not transmitted by HTTP fetch. Bind the effective wire URL
      // rather than rejecting a valid artifact URL as a different namespace.
      const wireUrl = new URL(original.url);
      wireUrl.hash = "";
      const body = original.body ? new Uint8Array(await original.arrayBuffer()) : undefined;
      const headers = new Headers(original.headers);
      if (!headers.has("accept")) headers.set("accept", "*/*");
      // Native fetch computes the framing length from these fixed bytes. Do not
      // pass an explicit length through Node's legacy dispatcher bridge: installed
      // Undici may reject its numeric representation. The effective wire fact
      // below includes the native-generated length and tests compare upstream.
      headers.delete("content-length");
      const actual = new Request(wireUrl, {
        method: original.method, headers, body, signal: signal ? AbortSignal.any([original.signal, signal]) : original.signal, redirect: "error",
        credentials: original.credentials, cache: original.cache, integrity: original.integrity,
        keepalive: original.keepalive, referrer: original.referrer, referrerPolicy: original.referrerPolicy,
      });
      const request = wireRequest(actual, body);
      let pending: Promise<Response> | undefined;
      let launchOpen = true;
      try {
        const result = launch(request.method === "GET" || request.method === "HEAD" ? "observation" : "forward", request, () => {
          // Assignment is synchronous. If the enclosing SQLite COMMIT fails,
          // retain and observe this original Promise; never dispatch again.
          if (!launchOpen || pending) throw new Error("media_native_transport_send_outside_exact_launch");
          pending = pinned ? pinned.sendNative(actual, nativeFetch) : nativeFetch(actual);
        });
        assertNoThenable(result);
      } catch (error) {
        launchOpen = false;
        if (pending) await observeFailedLaunch(pending);
        throw error;
      } finally { launchOpen = false; }
      if (!pending) throw new Error("media_native_transport_send_not_entered");
      const originalResponse = await pending;
      if (originalResponse.redirected || originalResponse.url !== actual.url) {
        await boundedCancel(originalResponse.body);
        throw new Error("media_native_transport_redirect_namespace_unconfirmed");
      }
      const bytes = await readCompleteBody(originalResponse, maxResponseBytes);
      // Cleanup is part of local transport completion, never a remote success.
      // A cleanup failure cannot issue a completed exchange.
      await pinned?.dispose();
      const exchange = Object.freeze({ request, httpStatus: originalResponse.status,
        contentType: originalResponse.headers.get("content-type"),
        bodySha256: sha(bytes), bodySizeBytes: bytes.byteLength, completedAt: new Date().toISOString() }) as HostMediaHttpExchange;
      bodies.set(exchange, bytes);
      if (onCompleted) assertNoThenable(onCompleted(exchange));
      const response = new Response(originalResponse.body === null ? null : bytes, {
        status: originalResponse.status, statusText: originalResponse.statusText, headers: originalResponse.headers,
      });
      // Consumers sometimes inspect URL/redirect flags. Preserve the exact native
      // values without granting structural clones or new Response() any authority.
      Object.defineProperties(response, { url: { value: originalResponse.url }, redirected: { value: false } });
      responses.set(response, exchange);
      return response;
    } finally { await pinned?.dispose(); }
  };
  const transport: HostMediaNativeTransport = Object.freeze({ fetch,
    assertExchange: (exchange: HostMediaHttpExchange): void => {
      if (!bodies.has(exchange)) throw new Error("media_native_transport_unissued_exchange");
    },
    readExchange: (response: Response): HostMediaHttpExchange => {
      const exchange = responses.get(response);
      if (!exchange) throw new Error("media_native_transport_unissued_response");
      return exchange;
    },
    readJson: (exchange: HostMediaHttpExchange): unknown => {
      const bytes = bodies.get(exchange);
      if (!bytes) throw new Error("media_native_transport_unissued_exchange");
      return JSON.parse(new TextDecoder().decode(bytes));
    },
  });
  issuedTransports.add(transport);
  return transport;
}

/** Only the native producer, not a structural client or mutable recovery, can issue body facts. */
export function assertHostMediaNativeTransport(transport: HostMediaNativeTransport): void {
  if (!issuedTransports.has(transport)) throw new Error("media_native_transport_unissued_transport");
}

function wireRequest(request: Request, body: Uint8Array | undefined): HostMediaWireRequest {
  const headers: Record<string, string> = {};
  for (const name of SAFE_WIRE_HEADERS) {
    const value = name === "content-length" && (body || request.method === "POST" || request.method === "PUT")
      ? String(body?.byteLength ?? 0) : request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const payload = { schemaVersion: 1, method: request.method, routeDigest: sha(request.url),
    headers: Object.freeze(headers), bodySha256: sha(body ?? new Uint8Array()), bodySizeBytes: body?.byteLength ?? 0 };
  const { schemaVersion: _, ...identity } = payload;
  return Object.freeze({ ...identity, wireDigest: sha(JSON.stringify(payload)) });
}
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function assertSynchronousHook(hook: unknown): void {
  if (typeof hook !== "function" || Object.prototype.toString.call(hook) === "[object AsyncFunction]") {
    throw new Error("media_native_transport_hook_must_be_synchronous");
  }
}
function assertNoThenable(value: unknown): void {
  if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
    // Observe accidental hook Promises so rejection cannot escape as unhandled;
    // their return never authorizes or proves a transport completion.
    void Promise.resolve(value).catch(() => {});
    throw new Error("media_native_transport_hook_must_be_synchronous");
  }
}
async function readCompleteBody(response: Response, budget: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > budget) throw new Error("media_native_transport_response_budget_exceeded");
      chunks.push(value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    await boundedCancel({ cancel: () => reader.cancel() });
    throw error;
  } finally { reader.releaseLock(); }
}
async function observeFailedLaunch(pending: Promise<Response>): Promise<void> {
  // This is cleanup observation only, not a completed body or remote-stop fact.
  // A hung upstream remains subject to the original request signal/deadline.
  try { await boundedCancel((await pending).body); } catch { /* Original admission/COMMIT error wins. */ }
}
async function boundedCancel(body: { cancel(): Promise<unknown> } | null): Promise<void> {
  if (!body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.resolve observes the original cancellation even after the bounded
    // wait expires. Timeout/rejection is never reclassified as completed EOF.
    const cleanup = Promise.resolve().then(() => body.cancel()).catch(() => {});
    await Promise.race([cleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, CLEANUP_DEADLINE_MS); })]);
  } finally { if (timer) clearTimeout(timer); }
}
