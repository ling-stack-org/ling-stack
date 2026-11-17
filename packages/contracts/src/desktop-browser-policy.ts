import { browserRecord, parseDesktopBrowserUrl } from "./desktop-browser.js";
export type BrowserSiteDecision = "ask" | "allow" | "deny";
export interface DesktopBrowserSiteRule {
  readonly origin: string;
  readonly browse: BrowserSiteDecision;
  readonly downloads: BrowserSiteDecision;
  readonly history: BrowserSiteDecision;
  readonly fullCdp: boolean;
  readonly webMcp: boolean;
}
export interface DesktopBrowserPolicy { readonly rules: readonly DesktopBrowserSiteRule[] }
export const defaultDesktopBrowserPolicy: DesktopBrowserPolicy = { rules: [] };
export function parseDesktopBrowserPolicy(value: unknown): DesktopBrowserPolicy {
  const r = browserRecord(value, ["rules"]);
  if (!Array.isArray(r.rules) || r.rules.length > 100) throw new Error("browser_policy_invalid");
  const origins = new Set<string>();
  return { rules: r.rules.map(value => {
    const rule = browserRecord(value, ["origin", "browse", "downloads", "history", "fullCdp", "webMcp"]);
    const origin = new URL(parseDesktopBrowserUrl(rule.origin)).origin;
    if (rule.origin !== origin || origins.has(origin) || ![rule.browse, rule.downloads, rule.history].every(value => value === "ask" || value === "allow" || value === "deny")
      || typeof rule.fullCdp !== "boolean" || typeof rule.webMcp !== "boolean") throw new Error("browser_policy_invalid");
    origins.add(origin);
    return { origin, browse: rule.browse as BrowserSiteDecision, downloads: rule.downloads as BrowserSiteDecision, history: rule.history as BrowserSiteDecision, fullCdp: rule.fullCdp, webMcp: rule.webMcp };
  }) };
}
export function desktopBrowserSiteRule(policy: DesktopBrowserPolicy, url: string): DesktopBrowserSiteRule {
  const origin = new URL(parseDesktopBrowserUrl(url)).origin;
  return policy.rules.find(rule => rule.origin === origin) ?? { origin, browse: "ask", downloads: "ask", history: "ask", fullCdp: false, webMcp: false };
}
