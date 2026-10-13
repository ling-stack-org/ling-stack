import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client, type Dispatcher } from "undici";

export type PublicHttpFailure = "local_or_private_host" | "dns_failed" | "timeout" | "unsafe_url";
export class PublicHttpError extends Error {
  constructor(readonly code: PublicHttpFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicHttpError";
  }
}
interface PreparationOptions {
  readonly resolveHostAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs: number;
}
/** Host-private lifetime; never a caller-shaped transport receipt or public option. */
export interface PinnedPublicHttpRequest {
  readonly request: Request;
  fetch(fetchImpl: typeof globalThis.fetch): Promise<Response>;
  sendNative(actual: Request, fetchImpl: typeof globalThis.fetch): Promise<Response>;
  dispose(): Promise<void>;
}
const requestBindings = new WeakMap<object, PinnedPublicHttpRequest>();
const claimedBindings = new WeakSet<PinnedPublicHttpRequest>();
const sendScope = new AsyncLocalStorage<PinnedPublicHttpRequest>();
const CLEANUP_TIMEOUT_MS = 1_000;

/** Reject malformed addresses, local ranges and IPv4-mapped local IPv6 alike. */
export function isLocalOrPrivateHttpAddress(value: string): boolean {
  const host = value.replace(/^\[|\]$/gu, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family !== 6) return true;
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
  if (canonical.startsWith("::ffff:")) {
    const words = canonical.slice(7).split(":").map(word => Number.parseInt(word, 16));
    if (words.length !== 2) return true;
    const [high, low] = words;
    return isLocalOrPrivateHttpAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  return canonical === "::" || canonical === "::1" || canonical.startsWith("fc") || canonical.startsWith("fd") ||
    /^fe[89ab]/u.test(canonical) || canonical.startsWith("ff");
}

/**
 * Resolve once under the complete request deadline, then create a fresh Client
 * whose native lookup can only return this immutable, fully reviewed answer.
 * URL/Host/SNI are unchanged; no global dispatcher or TLS policy is modified.
 */
export async function preparePinnedPublicHttpRequest(
  input: string | URL, init: RequestInit, options: PreparationOptions,
): Promise<PinnedPublicHttpRequest> {
  const url = new URL(input);
  url.hash = "";
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
    throw new PublicHttpError("unsafe_url", "Public HTTP requires a finite supported request deadline.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PublicHttpError("unsafe_url", "Only HTTP(S) targets are allowed.");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || (isIP(hostname) && isLocalOrPrivateHttpAddress(hostname))) {
    throw new PublicHttpError("local_or_private_host", "Public HTTP blocks local or private network targets.");
  }
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new DOMException("Public HTTP request timed out.", "AbortError")), options.timeoutMs);
  const assertLive = (): void => {
    if (signal.aborted) throw new PublicHttpError("timeout", "Public HTTP request was cancelled or timed out.", { cause: signal.reason });
  };
  let client: Client | undefined;
  try {
    assertLive();
    const resolver = options.resolveHostAddresses ?? defaultResolveHostAddresses;
    const answers = isIP(hostname) ? [hostname] : await resolveWithinSignal(resolver, hostname, signal);
    assertLive();
    if (answers.length === 0 || answers.some(address => isIP(address.replace(/^\[|\]$/gu, "")) === 0)) {
      throw new PublicHttpError("dns_failed", `Unable to resolve host: ${hostname}.`);
    }
    if (answers.some(isLocalOrPrivateHttpAddress)) throw new PublicHttpError("local_or_private_host", "Public HTTP blocks local or private network targets.");
    const addresses = Object.freeze(answers.map(address => Object.freeze({
      address: address.replace(/^\[|\]$/gu, ""), family: isIP(address.replace(/^\[|\]$/gu, "")) as 4 | 6,
    })));
    const first = addresses[0]!;
    client = new Client(url.origin, {
      autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250, pipelining: 0, maxRequestsPerClient: 1,
      connectTimeout: options.timeoutMs, headersTimeout: options.timeoutMs, bodyTimeout: options.timeoutMs,
      connect: { lookup: (_name, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [...addresses]);
        else callback(null, first.address, first.family);
      } },
    });
    const dispatcher = client;
    const request = new Request(url, { ...init, signal });
    const boundInit: RequestInit & { dispatcher: Dispatcher } = { ...init, signal, dispatcher };
    let invoked = false, enteredNative = false, disposed = false;
    let cleanup: Promise<void> | undefined;
    const prepared: PinnedPublicHttpRequest = Object.freeze({
      request,
      fetch: async (fetchImpl: typeof globalThis.fetch): Promise<Response> => {
        assertLive();
        if (invoked || disposed) throw new Error("public_http_binding_reused");
        invoked = true;
        // Exact init preserves existing logical fetch(url, init) fixtures. The
        // private scope makes a cloning intermediary fail closed at native send.
        try {
          const response = await sendScope.run(prepared, () => fetchImpl(url, boundInit));
          if (enteredNative) return response;
          if (!response.body) { await prepared.dispose(); return response; }
          return responseWithCleanup(response, prepared.dispose);
        } catch (error) { await prepared.dispose(); throw error; }
      },
      sendNative: (actual: Request, fetchImpl: typeof globalThis.fetch): Promise<Response> => {
        assertLive();
        if (enteredNative || disposed) throw new Error("public_http_binding_reused");
        if (actual.url !== request.url || new URL(actual.url).origin !== url.origin) throw new Error("public_http_binding_url_mismatch");
        enteredNative = true;
        return (fetchImpl as (input: Request, init: RequestInit & { dispatcher: Dispatcher }) => Promise<Response>)(actual, { dispatcher, signal: request.signal });
      },
      dispose: (): Promise<void> => {
        if (cleanup) return cleanup;
        disposed = true;
        clearTimeout(timeout);
        controller.abort();
        cleanup = boundedDestroy(dispatcher);
        return cleanup;
      },
    });
    requestBindings.set(request, prepared);
    requestBindings.set(boundInit, prepared);
    Object.defineProperty(request, "clone", { value: () => { throw new Error("public_http_binding_clone_rejected"); } });
    return prepared;
  } catch (error) {
    clearTimeout(timeout);
    controller.abort();
    if (client) await boundedDestroy(client);
    if (error instanceof PublicHttpError) throw error;
    if (signal.aborted && error instanceof DOMException && error.name === "AbortError") {
      throw new PublicHttpError("timeout", "Public HTTP request was cancelled or timed out.", { cause: error });
    }
    throw new PublicHttpError("dns_failed", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** Read before Request reconstruction; structural copies cannot carry authority. */
export function takePinnedPublicHttpRequest(input: RequestInfo | URL, init?: RequestInit): PinnedPublicHttpRequest | undefined {
  const binding = (typeof input === "object" ? requestBindings.get(input) : undefined) ?? (init && requestBindings.get(init));
  const required = sendScope.getStore();
  if (required && binding !== required) throw new Error("public_http_binding_missing_or_cloned");
  if (!binding) return undefined;
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).toString() !== binding.request.url) throw new Error("public_http_binding_url_mismatch");
  if (claimedBindings.has(binding)) throw new Error("public_http_binding_reused");
  claimedBindings.add(binding);
  return binding;
}

async function defaultResolveHostAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);
}
async function resolveWithinSignal(
  resolver: (hostname: string) => Promise<readonly string[]>, hostname: string, signal: AbortSignal,
): Promise<readonly string[]> {
  return await new Promise((resolve, reject) => {
    const aborted = (): void => reject(new PublicHttpError("timeout", "Public HTTP DNS resolution timed out.", { cause: signal.reason }));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { signal.removeEventListener("abort", aborted); aborted(); return; }
    Promise.resolve().then(() => resolver(hostname)).then(resolve, error => reject(new PublicHttpError("dns_failed",
      error instanceof Error ? error.message : String(error), { cause: error }))).finally(() => signal.removeEventListener("abort", aborted));
  });
}
async function boundedDestroy(client: Client): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.destroy(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("public_http_cleanup_unconfirmed")), CLEANUP_TIMEOUT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Streaming public clients retain their deadline until EOF/cancel, not headers. */
function responseWithCleanup(response: Response, dispose: () => Promise<void>): Response {
  const reader = response.body!.getReader();
  let finished = false, released = false;
  const release = (): void => { if (!released) { released = true; reader.releaseLock(); } };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (result.done) { finished = true; await dispose(); release(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) {
        if (finished && released) return;
        finished = true;
        try { await dispose(); } catch (cleanupError) { error = cleanupError; }
        release(); controller.error(error);
      }
    },
    async cancel(reason) {
      // EOF prefetch can race a budget cancellation. Never cancel a released
      // reader, and never turn rejected/stalled cancellation into success.
      if (finished) { await dispose(); return; }
      finished = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reader.cancel(reason), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("public_http_body_cleanup_unconfirmed")), CLEANUP_TIMEOUT_MS);
        })]);
      } finally {
        if (timer) clearTimeout(timer);
        try { await dispose(); } finally { release(); }
      }
    },
  });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected } });
  return wrapped;
}
