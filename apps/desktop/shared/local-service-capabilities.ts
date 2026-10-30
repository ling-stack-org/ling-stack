export const LOCAL_SERVICE_REQUEST_BODY_LIMIT = 64 * 1024;

export interface DesktopLocalServiceRequest {
  /** A whitelisted pathname and query, never an absolute URL. */
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: string;
}

export interface DesktopLocalServiceResponse {
  readonly status: number;
  readonly body: string;
}

export interface DesktopLocalServiceCapabilities {
  request(request: DesktopLocalServiceRequest): Promise<DesktopLocalServiceResponse>;
}

/** Shared for early renderer rejection; Main always repeats this validation. */
export function readDesktopLocalServiceRequest(value: unknown): DesktopLocalServiceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["path", "method", "body"].includes(key))
    || typeof record.path !== "string" || record.path.length > 16_384
    || !record.path.startsWith("/") || record.path.startsWith("//")
    || /[\\#\u0000-\u0020\u007f]/u.test(record.path)) invalid();
  const [pathname] = record.path.split("?");
  // Never normalize a renderer-supplied pathname into a permitted route.
  if (pathname.includes("%") || pathname.includes("//")) invalid();
  let parsed: URL;
  try { parsed = new URL(record.path, "http://127.0.0.1"); } catch { invalid(); }
  if (parsed.pathname !== pathname || parsed.hash || parsed.origin !== "http://127.0.0.1") invalid();
  const rules = routeRules(pathname);
  if (!rules || typeof record.method !== "string" || !rules.methods.includes(record.method)) invalid();
  const seen = new Set<string>();
  for (const [key, entry] of parsed.searchParams) {
    if (!rules.query.includes(key) || seen.has(key) || !entry || /[\u0000-\u001f\u007f]/u.test(entry)) invalid();
    seen.add(key);
  }
  // Query keys are exact names; values may use URL encoding (for example cwd).
  if (parsed.search && parsed.search.slice(1).split("&").some((part) => !/^[a-z]+=/u.test(part))) invalid();
  if (record.body !== undefined) {
    if (record.method === "GET" || typeof record.body !== "string"
      || new TextEncoder().encode(record.body).byteLength > LOCAL_SERVICE_REQUEST_BODY_LIMIT) invalid();
    try { JSON.parse(record.body); } catch { invalid(); }
  }
  return { path: record.path, method: record.method as DesktopLocalServiceRequest["method"],
    ...(record.body !== undefined ? { body: record.body as string } : {}) };
}

function routeRules(path: string): { readonly methods: readonly string[]; readonly query: readonly string[] } | undefined {
  if (path === "/notifications" || path === "/notifications/stream") return { methods: ["GET"], query: ["since"] };
  if (path === "/notifications/preferences") return { methods: ["GET", "PATCH"], query: [] };
  if (path === "/startup/status" || path === "/diagnostics/doctor") return { methods: ["GET"], query: ["cwd"] };
  if (path === "/startup/refresh") return { methods: ["POST"], query: ["cwd"] };
  if (path === "/diagnostics/logs") return { methods: ["GET"], query: ["lines"] };
  if (path === "/skills/marketplace/inspect") return { methods: ["GET"], query: ["url"] };
  if (path === "/im-destinations") return { methods: ["GET", "POST"], query: [] };
  if (/^\/im-destinations\/[A-Za-z0-9_-]+$/u.test(path)) return { methods: ["PATCH", "DELETE"], query: [] };
  if (/^\/im-destinations\/[A-Za-z0-9_-]+\/test$/u.test(path)) return { methods: ["POST"], query: [] };
  return undefined;
}

/** Only selected API-client requests use IPC; all other fetch calls retain their transport. */
export function createDesktopLocalServiceFetch(input: {
  readonly baseUrl: string;
  readonly localServices: DesktopLocalServiceCapabilities;
  readonly fetch: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const origin = new URL(input.baseUrl).origin;
  return async (resource, init) => {
    const raw = typeof resource === "string" ? resource : resource instanceof URL ? resource.href : undefined;
    // API-client uses absolute string URLs. Request objects keep their original fetch semantics.
    const path = raw?.startsWith(`${origin}/`) ? raw.slice(origin.length) : undefined;
    const pathname = path?.split("?")[0];
    if (!pathname || !routeRules(pathname)) return input.fetch(resource, init);
    const request = readDesktopLocalServiceRequest({ path, method: init?.method ?? "GET",
      ...(init?.body !== undefined && init.body !== null ? { body: init.body } : {}) });
    init?.signal?.throwIfAborted();
    const response = await input.localServices.request(request);
    init?.signal?.throwIfAborted();
    return new Response(response.status === 204 || response.status === 205 ? null : response.body,
      { status: response.status, headers: { "Content-Type": "application/json" } });
  };
}

function invalid(): never { throw new Error("local_service_invalid_request"); }
