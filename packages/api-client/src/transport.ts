import { LingDaemonError } from "./errors.js";

export interface LingDaemonClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export type Query = Record<string, string | number | boolean | undefined>;

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

export interface LingDaemonEndpointContext {
  readonly baseUrl: string;
  _fetch(input: FetchInput, init?: FetchInit): Promise<Response>;
  _get<T>(path: string, query?: Query): Promise<T>;
  _post<T>(path: string, query?: Query, body?: unknown): Promise<T>;
  _put<T>(path: string, query?: Query, body?: unknown): Promise<T>;
  _patch<T>(path: string, query?: Query, body?: unknown): Promise<T>;
  _delete<T>(path: string, query?: Query, body?: unknown): Promise<T>;
  _requestJson<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T>;
  _request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T>;
  _url(path: string, query?: Query): string;
}

export type PublicEndpointGroup<T> = {
  [K in keyof T]: T[K] extends (this: LingDaemonEndpointContext, ...args: infer TArgs) => infer TReturn
    ? (...args: TArgs) => TReturn
    : T[K];
};

export function daemonBaseUrlFromEnv(env: Record<string, string | undefined> = {}): string {
  return env.VITE_LING_STACK_DAEMON_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:17891";
}

export class LingDaemonTransport implements LingDaemonEndpointContext {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: LingDaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? daemonBaseUrlFromEnv()).replace(/\/$/, "");
    const configuredFetch = options.fetch;
    if (configuredFetch) {
      this.fetchImpl = (input, init) => configuredFetch(input, init);
      return;
    }
    if (!globalThis.fetch) {
      throw new Error("A fetch implementation is required.");
    }
    this.fetchImpl = globalThis.fetch.bind(globalThis);
  }

  /** @internal Endpoint modules use this to preserve fetch binding semantics. */
  _fetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }

  /** @internal */
  _get<T>(path: string, query: Query = {}): Promise<T> {
    return this._request("GET", path, query);
  }

  /** @internal */
  _post<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this._request("POST", path, query, body);
  }

  /** @internal */
  _put<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this._request("PUT", path, query, body);
  }

  /** @internal */
  _patch<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this._request("PATCH", path, query, body);
  }

  /** @internal */
  _delete<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this._request("DELETE", path, query, body);
  }

  /** @internal */
  async _requestJson<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this._url(path, query), init);
    if (!response.ok) {
      const error = await readErrorDetails(response);
      throw new LingDaemonError(error.message, response.status, response.statusText, error.code);
    }
    return (await response.json()) as T;
  }

  /** @internal */
  async _request<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this._url(path, query), init);
    if (!response.ok) {
      const error = await readErrorDetails(response);
      throw new LingDaemonError(error.message, response.status, response.statusText, error.code);
    }
    if (method === "DELETE") {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /** @internal */
  _url(path: string, query: Query = {}): string {
    const parsed = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        parsed.searchParams.set(key, String(value));
      }
    }
    return parsed.toString();
  }
}

export async function readErrorMessage(response: Response): Promise<string> {
  return (await readErrorDetails(response)).message;
}

async function readErrorDetails(response: Response): Promise<{ readonly message: string; readonly code?: string }> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
    return {
      message: friendlyErrorMessage(message),
      ...(typeof body.error === "string" ? { code: body.error } : {}),
    };
  } catch {
    return { message: friendlyErrorMessage(message) };
  }
}

function friendlyErrorMessage(message: string): string {
  if ((message.includes("EACCES") || message.includes("ENOENT")) && message.includes(".ling-stack")) {
    return `Workspace path does not exist or is not writable. Use the absolute path to your local checkout. ${message}`;
  }
  return message;
}
