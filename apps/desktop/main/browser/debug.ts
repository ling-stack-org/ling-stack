import type { WebContents } from "electron";

export function sanitizeBrowserDebug(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string") return value.replace(/(?:bearer\s+)[\w.+/=-]+/giu, "Bearer [redacted]").replace(/((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;&]+/giu, "$1[redacted]").slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeBrowserDebug(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key,
    /cookie|password|secret|token|authorization|headers|postdata|body|credential/iu.test(key) ? "[redacted]" : sanitizeBrowserDebug(item, depth + 1)]));
  return value;
}
export function debugUrl(value: string): string { try { const url = new URL(value); return `${url.origin}${url.pathname}`.slice(0, 2048); } catch { return ""; } }

export class BrowserDebugLog {
  private readonly events: unknown[] = [];
  constructor(private readonly contents: WebContents) {
    contents.on("console-message", (details) => this.add({ kind: "console", level: details.level, message: details.message, source: debugUrl(details.sourceId), line: details.lineNumber }));
    contents.on("did-fail-load", (_event, code, _description, url, mainFrame) => this.add({ kind: "load_error", code, url: debugUrl(url), mainFrame }));
  }
  add(value: object): void { this.events.push(sanitizeBrowserDebug({ at: Date.now(), ...value })); if (this.events.length > 100) this.events.shift(); }
  reset(): void { this.events.length = 0; this.detach(); }
  detach(): void { if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach(); }
  async read(): Promise<unknown> {
    const performance: unknown = await this.contents.executeJavaScriptInIsolatedWorld(1009, [{ code: 'JSON.stringify({timeOrigin:performance.timeOrigin,now:performance.now(),navigation:performance.getEntriesByType("navigation").map(e=>({duration:e.duration,domContentLoadedEventEnd:e.domContentLoadedEventEnd,loadEventEnd:e.loadEventEnd})).slice(0,1)})' }]);
    return { events: [...this.events], performance: typeof performance === "string" ? JSON.parse(performance) : null, coverage: "bounded console and request metadata; no headers, request bodies or response bodies" };
  }
  async cdp(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!/^[A-Za-z]+\.[A-Za-z]+$/u.test(method) || /^(?:Browser|Target|SystemInfo|IO|Fetch|Storage|Tethering|Tracing)\./u.test(method) || /cookie/iu.test(method)) throw new Error("browser_cdp_method_forbidden");
    try {
      this.contents.debugger.attach("1.3");
      const result: unknown = await this.contents.debugger.sendCommand(method, params);
      const cleaned = sanitizeBrowserDebug(result);
      if (JSON.stringify(cleaned).length > 100_000) throw new Error("browser_cdp_result_too_large");
      return cleaned;
    } finally { this.detach(); }
  }
}
