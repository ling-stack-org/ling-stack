import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyResolvedTheme, ThemeRegistry } from "@ling-stack/ui-react/theme";
import { parseDesktopBrowserUrl, type DesktopBrowserScope } from "@ling-stack/contracts";
import type { DesktopBrowserCapabilities, DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace, DesktopBrowserWorkspaceState } from "../../../desktop/shared/browser-capabilities.js";
import { I18nProvider } from "../../src/i18n.js";
import { ThemeProvider } from "../../src/theme.js";
import { LingUiProvider } from "../../src/shared/ui/index.js";
import { readInitialThemeSelection } from "../../src/shared/ui/theme/web-theme-storage.js";
import { WorkspaceRightDock } from "../../src/features/workspace/right-dock/WorkspaceRightDock.js";

declare global { interface Window { browserFixture: { calls: DesktopBrowserUserAction[]; viewports: DesktopBrowserViewport[]; subscriptions(): number; dispose(): void } } }

export function mountBrowserFixture(): void {
  const query = new URL(location.href).searchParams;
  if (query.has("native")) localStorage.setItem("ling-stack.locale", "en-US");
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyResolvedTheme(document.documentElement, new ThemeRegistry().resolve(readInitialThemeSelection().selection, scheme));
  const calls: DesktopBrowserUserAction[] = [], viewports: DesktopBrowserViewport[] = [], listeners = new Set<() => void>();
  const states = new Map<string, DesktopBrowserWorkspaceState>(); let revision = 0;
  const read = (workspace: DesktopBrowserWorkspace): DesktopBrowserWorkspaceState => states.get(JSON.stringify(workspace)) ?? { generation: 1, revision: 0, tabs: [] };
  const capability: DesktopBrowserCapabilities = {
    getState: async workspace => read(workspace),
    async act(action) {
      calls.push(action);
      const workspace = { workspaceCwd: action.workspaceCwd, scope: action.scope }, state = read(workspace);
      let tabs = [...state.tabs], activeTabId = state.activeTabId;
      if (action.action === "open") {
        const url = parseDesktopBrowserUrl(action.url), id = `tab-${++revision}`;
        tabs.push({ id, scope: action.scope, url, title: new URL(url).host, navigationRevision: 1, loading: false, canGoBack: false, canGoForward: false, control: "human" }); activeTabId = id;
      } else if (action.action === "close") { tabs = tabs.filter(tab => tab.id !== action.tabId); activeTabId = tabs[0]?.id; }
      else if (action.action === "activate") activeTabId = action.tabId;
      else if (action.action === "navigate") tabs = tabs.map(tab => tab.id !== action.tabId ? tab : { ...tab, url: parseDesktopBrowserUrl(action.url), canGoBack: true, navigationRevision: tab.navigationRevision + 1 });
      else if (action.action === "release_control" || action.action === "take_control") tabs = tabs.map(tab => tab.id !== action.tabId ? tab : { ...tab, control: action.action === "release_control" ? "agent" : "human" });
      const next = { generation: 1, revision: ++revision, tabs, activeTabId };
      states.set(JSON.stringify(workspace), next); listeners.forEach(listener => listener()); return next;
    },
    reportViewport: viewport => { viewports.push(viewport); },
    onStateChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onAddressFocusRequested: () => () => {},
  };
  if (!query.has("web") && !query.has("native")) Object.defineProperty(window, "lingDesktop", { configurable: true, value: { browser: capability } });
  const container = document.createElement("main"); document.body.append(container); const root = createRoot(container);
  window.browserFixture = { calls, viewports, subscriptions: () => listeners.size, dispose: () => { root.unmount(); container.remove(); } };
  root.render(<I18nProvider><ThemeProvider><LingUiProvider><Fixture cwd={query.get("workspace") ?? "/browser-fixture"} /></LingUiProvider></ThemeProvider></I18nProvider>);
}

function Fixture({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const [surface, setSurface] = useState<DesktopBrowserScope["surface"]>("normal_conversation");
  const [pageRequest, setPageRequest] = useState<{ page: "browser"; nonce: number } | undefined>({ page: "browser", nonce: 1 });
  const [overlay, setOverlay] = useState(false);
  return <div style={{ display: "flex", position: "fixed", inset: 20, gap: 20, background: "var(--ling-bg-panel)", color: "var(--ling-text-primary)" }}>
    <style>{".browser-fixture-dock { width: 100%; }"}</style>
    <section style={{ flex: 1, padding: 20 }}><h1>Browser workspace</h1><p>Conversation preview fixture</p>
      {(["normal_conversation", "channel", "teammate_direct"] as const).map(item => <button key={item} onClick={() => { setSurface(item); setPageRequest({ page: "browser", nonce: Date.now() }); }}>{item}</button>)}
      <button onClick={() => setOverlay(true)}>Open approval overlay</button>
    </section>
    <div style={{ width: "54%", display: "flex", minWidth: 0 }}>
      <WorkspaceRightDock key={surface} className="browser-fixture-dock" surface={surface} browserScopeId={`thread-${surface}`} cwd={cwd} open ariaLabel="Browser workspace dock"
        launcherTitle="Workspace" reviewItems={[]} evidenceGroups={[{ id: "browser", label: "Web evidence", items: [{
          id: "browser-evidence", kind: "browser", title: "Recorded browser evidence", summary: "Saved page summary", href: "https://example.com/recorded",
        }] }]} fileItems={[]} pageRequest={pageRequest} onPageRequestConsumed={() => setPageRequest(undefined)} />
    </div>
    {overlay ? <div role="dialog" aria-label="Approval fixture" style={{ position: "fixed", inset: 100, zIndex: 100, background: "var(--ling-bg-panel)" }}>
      <button onClick={() => setOverlay(false)}>Dismiss approval overlay</button></div> : null}
  </div>;
}
