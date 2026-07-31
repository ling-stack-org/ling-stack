export interface LockedTaskContinuationDaemonSnapshot {
  readonly revision: number;
  readonly continueWhileLocked: boolean;
  readonly locked: boolean;
  readonly blocked: boolean;
}

export interface LockedTaskContinuationDaemonClient {
  publish(input: {
    readonly workspaceCwd: string;
    readonly desktopInstanceId: string;
    readonly leaseTtlMs: number;
    readonly continueWhileLocked: boolean;
    readonly locked: boolean;
  }): Promise<LockedTaskContinuationDaemonSnapshot>;
  release?(input: {
    readonly workspaceCwd: string;
    readonly desktopInstanceId: string;
  }): Promise<LockedTaskContinuationDaemonSnapshot>;
}

export class LockedTaskContinuationDaemonClientError extends Error {
  constructor(readonly clientCode: "invalid_response" | "request_failed") {
    super(`locked_task_continuation_daemon_${clientCode}`);
    this.name = "LockedTaskContinuationDaemonClientError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;

export function createLockedTaskContinuationDaemonClient(options: {
  readonly daemonBaseUrl: string;
  readonly bridgeToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}): LockedTaskContinuationDaemonClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const configuredRequestTimeoutMs = options.requestTimeoutMs;
  const requestTimeoutMs = configuredRequestTimeoutMs !== undefined
      && Number.isFinite(configuredRequestTimeoutMs)
      && configuredRequestTimeoutMs > 0
    ? configuredRequestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const stateUrl = new URL("/computer-use/locked-task-continuation/desktop/state", options.daemonBaseUrl);
  const releaseUrl = new URL("/computer-use/locked-task-continuation/desktop/release", options.daemonBaseUrl);
  return Object.freeze({
    async publish(input: {
      readonly workspaceCwd: string;
      readonly desktopInstanceId: string;
      readonly leaseTtlMs: number;
      readonly continueWhileLocked: boolean;
      readonly locked: boolean;
    }) {
      return post(fetchImpl, stateUrl, options.bridgeToken, input, requestTimeoutMs);
    },
    async release(input: { readonly workspaceCwd: string; readonly desktopInstanceId: string }) {
      return post(fetchImpl, releaseUrl, options.bridgeToken, input, requestTimeoutMs);
    },
  });
}

async function post(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  bridgeToken: string,
  input: unknown,
  requestTimeoutMs: number,
): Promise<LockedTaskContinuationDaemonSnapshot> {
  let response: Response;
  let value: unknown;
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error("locked_task_continuation_daemon_timeout"));
  }, Math.max(1, requestTimeoutMs));
  if (typeof timeout.unref === "function") timeout.unref();
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ling-Desktop-Bridge-Token": bridgeToken,
      },
      body: JSON.stringify(input),
      signal: abortController.signal,
    });
    value = await response.json().catch((error: unknown) => {
      if (abortController.signal.aborted) throw error;
      return undefined;
    }) as unknown;
  } catch {
    throw new LockedTaskContinuationDaemonClientError("request_failed");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || !isSnapshot(value)) {
    throw new LockedTaskContinuationDaemonClientError(
      response.ok ? "invalid_response" : "request_failed",
    );
  }
  return value;
}

function isSnapshot(value: unknown): value is LockedTaskContinuationDaemonSnapshot {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.revision)
    && typeof value.continueWhileLocked === "boolean"
    && typeof value.locked === "boolean"
    && typeof value.blocked === "boolean"
    && value.blocked === (value.locked && !value.continueWhileLocked);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
