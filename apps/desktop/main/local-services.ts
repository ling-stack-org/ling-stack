import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import { readDesktopLocalServiceRequest, type DesktopLocalServiceResponse } from "../shared/local-service-capabilities.js";

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function registerLocalServiceIpc(input: {
  readonly ipcMainImpl: Pick<IpcMain, "handle" | "removeHandler">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly trustedDocumentUrl: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}): () => void {
  const baseUrl = readLoopbackBaseUrl(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  input.ipcMainImpl.handle(DESKTOP_IPC_CHANNELS.localServiceRequest, async (event, ...args): Promise<DesktopLocalServiceResponse> => {
    try {
      assertSender(input, event);
      if (args.length !== 1) throw new Error("local_service_invalid_request");
      const request = readDesktopLocalServiceRequest(args[0]);
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const result = await withAbort(signal, async () => {
        const response = await fetchImpl(`${baseUrl}${request.path}`, {
          method: request.method,
          ...(request.body !== undefined ? { body: request.body } : {}),
          headers: request.body !== undefined ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
          redirect: "error", signal,
        });
        if (response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => {});
          throw new Error("local_service_unavailable");
        }
        return { status: response.status, body: await readBoundedBody(response, signal) };
      });
      assertSender(input, event);
      return result;
    } catch (error) {
      // Do not leak fetch internals, local paths, credentials or response headers.
      assertSender(input, event);
      const code = error instanceof Error ? error.message : "";
      throw new Error(/^local_service_(?:invalid_request|response_too_large|timeout|unavailable)$/u.test(code) ? code : "local_service_unavailable");
    }
  });
  return () => input.ipcMainImpl.removeHandler(DESKTOP_IPC_CHANNELS.localServiceRequest);
}

function readLoopbackBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("local_service_invalid_base_url"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (value !== url.origin && value !== `${url.origin}/`)) throw new Error("local_service_invalid_base_url");
  return url.origin;
}

function assertSender(input: { readonly getMainWindow: () => BrowserWindow | undefined; readonly trustedDocumentUrl: string }, event: IpcMainInvokeEvent): void {
  const window = input.getMainWindow();
  const owner = window?.webContents;
  if (!window || window.isDestroyed() || !owner || owner.isDestroyed() || event.sender !== owner
    || event.sender.id !== owner.id || event.sender.isDestroyed() || !event.senderFrame
    || event.senderFrame !== owner.mainFrame || event.senderFrame.detached
    || event.senderFrame.url !== owner.getURL() || !isTrustedDocument(owner.getURL(), input.trustedDocumentUrl)) {
    throw new Error("local_service_forbidden");
  }
}

function isTrustedDocument(actual: string, expected: string): boolean {
  try {
    const current = new URL(actual);
    const trusted = new URL(expected);
    // Hash navigation is used by the UI; a query or a different file is a different document.
    current.hash = trusted.hash = "";
    return current.protocol === "file:" && trusted.protocol === "file:" && current.href === trusted.href;
  } catch { return false; }
}

async function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("local_service_timeout");
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("local_service_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([aborted, operation()]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > RESPONSE_LIMIT) {
    void response.body?.cancel().catch(() => {});
    throw new Error("local_service_response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new Error("local_service_response_too_large");
      body += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    return body + decoder.decode();
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
