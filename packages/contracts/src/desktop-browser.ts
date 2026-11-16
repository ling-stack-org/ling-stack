export const DESKTOP_BROWSER_PROTOCOL = "ling.desktop-browser.v1";
export const DESKTOP_BROWSER_PLUGIN_ID = "built-in:browser";
export const DESKTOP_BROWSER_MCP_SERVER_ID = "mcp_browser";
export const DESKTOP_BROWSER_MAX_TABS = 12;
export const DESKTOP_BROWSER_MAX_RESULT_BYTES = 2 * 1024 * 1024;

export const desktopBrowserMethods = [
  "browser_tabs", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_screenshot",
] as const;
export type DesktopBrowserMethod = typeof desktopBrowserMethods[number];

export interface DesktopBrowserScope {
  readonly surface: "normal_conversation" | "channel" | "teammate_direct";
  readonly ownerId: string;
}

export interface DesktopBrowserTab {
  readonly id: string;
  readonly scope: DesktopBrowserScope;
  readonly url: string;
  readonly title: string;
  readonly navigationRevision: number;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly control: "human" | "agent";
  readonly error?: string;
}

export interface DesktopBrowserState {
  readonly protocol: typeof DESKTOP_BROWSER_PROTOCOL;
  readonly desktopInstanceId: string;
  readonly generation: number;
  readonly revision: number;
  readonly workspaceCwd: string;
  readonly tabs: readonly DesktopBrowserTab[];
}

export interface DesktopBrowserTarget {
  readonly tabId: string;
  readonly navigationRevision: number;
}

export type DesktopBrowserOperation =
  | { readonly method: "browser_tabs"; readonly params: Record<string, never> }
  | { readonly method: "browser_navigate"; readonly params: { readonly url: string; readonly tabId?: string; readonly navigationRevision?: number } }
  | { readonly method: "browser_snapshot"; readonly params: DesktopBrowserTarget }
  | { readonly method: "browser_screenshot"; readonly params: DesktopBrowserTarget }
  | { readonly method: "browser_click"; readonly params: DesktopBrowserTarget & { readonly snapshotRevision: string; readonly ref: string } }
  | { readonly method: "browser_type"; readonly params: DesktopBrowserTarget & { readonly snapshotRevision: string; readonly ref: string; readonly text: string } };

export type DesktopBrowserCommand = DesktopBrowserOperation & {
  readonly protocol: typeof DESKTOP_BROWSER_PROTOCOL;
  readonly id: string;
  readonly desktopInstanceId: string;
  readonly generation: number;
  readonly workspaceCwd: string;
  readonly scope: DesktopBrowserScope;
  readonly runId: string;
  readonly deadlineAt: string;
};

export interface DesktopBrowserResult {
  readonly protocol: typeof DESKTOP_BROWSER_PROTOCOL;
  readonly id: string;
  readonly ok: boolean;
  readonly effect: "none" | "completed" | "unknown";
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export function parseDesktopBrowserScope(value: unknown): DesktopBrowserScope {
  const record = browserRecord(value, ["surface", "ownerId"]);
  if (record.surface !== "normal_conversation" && record.surface !== "channel" && record.surface !== "teammate_direct") invalid();
  return { surface: record.surface, ownerId: browserString(record.ownerId, 256) };
}

export function sameDesktopBrowserScope(left: DesktopBrowserScope, right: DesktopBrowserScope): boolean {
  return left.surface === right.surface && left.ownerId === right.ownerId;
}

/** Browser URLs never carry URL credentials or invoke privileged protocols. */
export function parseDesktopBrowserUrl(value: unknown): string {
  const text = browserString(value, 4096);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("browser_url_invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error("browser_url_forbidden");
  }
  return url.href;
}

export function parseDesktopBrowserOperation(method: unknown, value: unknown): DesktopBrowserOperation {
  const keys = method === "browser_tabs" ? []
    : method === "browser_navigate" ? ["url", "tabId", "navigationRevision"]
      : method === "browser_snapshot" || method === "browser_screenshot" ? ["tabId", "navigationRevision"]
        : method === "browser_click" ? ["tabId", "navigationRevision", "snapshotRevision", "ref"]
          : method === "browser_type" ? ["tabId", "navigationRevision", "snapshotRevision", "ref", "text"] : undefined;
  if (!keys) invalid();
  const record = browserRecord(value, keys);
  if (method === "browser_tabs") return { method, params: {} };
  if (method === "browser_navigate") {
    if ((record.tabId === undefined) !== (record.navigationRevision === undefined)) invalid();
    return { method, params: { url: parseDesktopBrowserUrl(record.url), ...(record.tabId === undefined ? {} : {
      tabId: browserString(record.tabId, 128), navigationRevision: browserInteger(record.navigationRevision),
    }) } };
  }
  const target = { tabId: browserString(record.tabId, 128), navigationRevision: browserInteger(record.navigationRevision) };
  if (method === "browser_snapshot" || method === "browser_screenshot") return { method, params: target };
  const reference = { ...target, snapshotRevision: browserString(record.snapshotRevision, 128), ref: browserString(record.ref, 128) };
  if (method === "browser_click") return { method, params: reference };
  if (method === "browser_type") return { method, params: { ...reference, text: browserString(record.text, 16_384, true) } };
  return invalid();
}

export function parseDesktopBrowserCommand(value: unknown): DesktopBrowserCommand {
  const record = browserRecord(value, ["protocol", "id", "desktopInstanceId", "generation", "workspaceCwd", "scope", "runId", "deadlineAt", "method", "params"]);
  if (record.protocol !== DESKTOP_BROWSER_PROTOCOL) invalid();
  const deadlineAt = browserString(record.deadlineAt, 40);
  if (!Number.isFinite(Date.parse(deadlineAt))) invalid();
  return {
    ...parseDesktopBrowserOperation(record.method, record.params), protocol: DESKTOP_BROWSER_PROTOCOL,
    id: browserString(record.id, 128), desktopInstanceId: browserString(record.desktopInstanceId, 128),
    generation: browserInteger(record.generation, 1), workspaceCwd: browserString(record.workspaceCwd, 4096),
    scope: parseDesktopBrowserScope(record.scope), runId: browserString(record.runId, 256), deadlineAt,
  };
}

export function parseDesktopBrowserTab(value: unknown): DesktopBrowserTab {
  const record = browserRecord(value, ["id", "scope", "url", "title", "navigationRevision", "loading", "canGoBack", "canGoForward", "control", "error"]);
  if (record.control !== "human" && record.control !== "agent") invalid();
  for (const key of ["loading", "canGoBack", "canGoForward"]) if (typeof record[key] !== "boolean") invalid();
  return {
    id: browserString(record.id, 128), scope: parseDesktopBrowserScope(record.scope),
    url: parseDesktopBrowserUrl(record.url), title: browserString(record.title, 512, true),
    navigationRevision: browserInteger(record.navigationRevision), loading: record.loading as boolean,
    canGoBack: record.canGoBack as boolean, canGoForward: record.canGoForward as boolean, control: record.control,
    ...(record.error === undefined ? {} : { error: browserString(record.error, 256) }),
  };
}

export function parseDesktopBrowserState(value: unknown): DesktopBrowserState {
  const record = browserRecord(value, ["protocol", "desktopInstanceId", "generation", "revision", "workspaceCwd", "tabs"]);
  if (record.protocol !== DESKTOP_BROWSER_PROTOCOL || !Array.isArray(record.tabs) || record.tabs.length > DESKTOP_BROWSER_MAX_TABS) invalid();
  const tabs = record.tabs.map(parseDesktopBrowserTab);
  if (new Set(tabs.map(tab => tab.id)).size !== tabs.length) invalid();
  return { protocol: DESKTOP_BROWSER_PROTOCOL, desktopInstanceId: browserString(record.desktopInstanceId, 128),
    generation: browserInteger(record.generation, 1), revision: browserInteger(record.revision), workspaceCwd: browserString(record.workspaceCwd, 4096), tabs };
}

export function parseDesktopBrowserResult(value: unknown): DesktopBrowserResult {
  const record = browserRecord(value, ["protocol", "id", "ok", "effect", "result", "error"]);
  if (record.protocol !== DESKTOP_BROWSER_PROTOCOL || typeof record.ok !== "boolean"
    || !["none", "completed", "unknown"].includes(String(record.effect))) invalid();
  const error = record.error === undefined ? undefined : browserRecord(record.error, ["code", "message"]);
  if ((record.ok && (error || record.effect === "unknown")) || (!record.ok && (!error || record.result !== undefined))) invalid();
  if (JSON.stringify(value).length > DESKTOP_BROWSER_MAX_RESULT_BYTES) throw new Error("browser_result_too_large");
  return { protocol: DESKTOP_BROWSER_PROTOCOL, id: browserString(record.id, 128), ok: record.ok,
    effect: record.effect as DesktopBrowserResult["effect"], ...(record.result === undefined ? {} : { result: record.result }),
    ...(error ? { error: { code: browserString(error.code, 128), message: browserString(error.message, 512) } } : {}) };
}

export function browserRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) invalid();
  return record;
}

export function browserString(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0")) invalid();
  return value;
}

export function browserInteger(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid();
  return value;
}

function invalid(): never { throw new Error("browser_contract_invalid"); }
