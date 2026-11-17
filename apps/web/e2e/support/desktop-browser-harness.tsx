import type { BrowserManagementState } from "../../../desktop/shared/browser-management.js";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyResolvedTheme, ThemeRegistry } from "@ling-stack/ui-react/theme";
import { parseDesktopBrowserUrl, type DesktopBrowserScope } from "@ling-stack/contracts";
import type { DesktopBrowserCapabilities, DesktopBrowserPreferences, DesktopBrowserUserAction, DesktopBrowserViewport, DesktopBrowserWorkspace, DesktopBrowserWorkspaceState } from "../../../desktop/shared/browser-capabilities.js";
import { I18nProvider } from "../../src/i18n.js";
import { ThemeProvider } from "../../src/theme.js";
import { LingUiProvider } from "../../src/shared/ui/index.js";
import { readInitialThemeSelection } from "../../src/shared/ui/theme/web-theme-storage.js";
import { WorkspaceRightDock } from "../../src/features/workspace/right-dock/WorkspaceRightDock.js";
import { useConversationBrowserLinks } from "../../src/features/browser/use-conversation-browser-links.js";
import { InlineFeedback } from "../../src/shared/ui/index.js";

declare global { interface Window { browserFixture: { calls: DesktopBrowserUserAction[]; viewports: DesktopBrowserViewport[]; submissions: { comment: string; fileNames: string[]; metadata: unknown }[]; subscriptions(): number; dispose(): void } } }

export function mountBrowserFixture(): void {
  const query = new URL(location.href).searchParams;
  if (query.has("native")) localStorage.setItem("ling-stack.locale", "en-US");
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyResolvedTheme(document.documentElement, new ThemeRegistry().resolve(readInitialThemeSelection().selection, scheme));
  const calls: DesktopBrowserUserAction[] = [], viewports: DesktopBrowserViewport[] = [], listeners = new Set<() => void>();
  const states = new Map<string, DesktopBrowserWorkspaceState>(); let revision = 0;
  let preferences: DesktopBrowserPreferences = { websiteLinks: "in_app", localhostLinks: "in_app", restoreTabs: true };
  let management: BrowserManagementState | undefined = query.has("management") ? { history: [{ id: "history-a", url: "https://example.com/saved", title: "Saved website", visitedAt: Date.now() }], downloads: [{ id: "download-a", url: "https://example.com/file", filename: "fixture.txt", path: "/downloads/fixture.txt", startedAt: Date.now(), status: "completed", received: 10, total: 10 }], devices: [], downloadDirectory: "/downloads", askBeforeDownload: true, extensions: [] } : undefined;
  const read = (workspace: DesktopBrowserWorkspace): DesktopBrowserWorkspaceState => ({ ...(states.get(JSON.stringify(workspace)) ?? { generation: 1, revision: 0, tabs: [] }), preferences, ...(management ? { management } : {}) });
  const capability: DesktopBrowserCapabilities = {
    getState: async workspace => read(workspace),
    async act(action) {
      calls.push(action);
      const workspace = { workspaceCwd: action.workspaceCwd, scope: action.scope }, state = read(workspace);
      let tabs = [...state.tabs], activeTabId = state.activeTabId;
      if (action.action === "preferences") preferences = action.preferences;
      let openedIn: "in_app" | "system" | undefined;
      if (action.action === "open_link") openedIn = new URL(action.url).hostname === "localhost" ? preferences.localhostLinks : preferences.websiteLinks;
      if (action.action === "open" || action.action === "open_link" && openedIn === "in_app") {
        const url = parseDesktopBrowserUrl(action.url), id = `tab-${++revision}`;
        tabs.push({ id, scope: action.scope, url, title: new URL(url).host, navigationRevision: 1, loading: false, canGoBack: false, canGoForward: false, control: "human" }); activeTabId = id;
      } else if (action.action === "close") { tabs = tabs.filter(tab => tab.id !== action.tabId); activeTabId = tabs[0]?.id; }
      else if (action.action === "activate") activeTabId = action.tabId;
      else if (action.action === "navigate") tabs = tabs.map(tab => tab.id !== action.tabId ? tab : { ...tab, url: parseDesktopBrowserUrl(action.url), canGoBack: true, navigationRevision: tab.navigationRevision + 1 });
      else if (action.action === "release_control" || action.action === "take_control") tabs = tabs.map(tab => tab.id !== action.tabId ? tab : { ...tab, control: action.action === "release_control" ? "agent" : "human" });
      if (action.action === "history_clear" && management) management = { ...management, history: management.history.filter(item => action.id ? item.id !== action.id : item.visitedAt < action.since) };
      if (action.action === "download_preferences" && management) management = { ...management, askBeforeDownload: action.askBeforeDownload };
      if (action.action === "clear_data" && management) { if (action.history) management = { ...management, history: [] }; tabs = []; activeTabId = undefined; }
      const selectedTab = tabs.find(tab => tab.id === activeTabId);
      const annotation = action.action === "annotate" && selectedTab ? { version: 1 as const, id: `annotation-${revision}`, workspaceCwd: action.workspaceCwd, scope: action.scope, generation: 1,
        tabId: selectedTab.id, navigationRevision: selectedTab.navigationRevision, url: selectedTab.url, origin: new URL(selectedTab.url).origin,
        anchor: { kind: action.kind, documentId: "fixture-document", documentRevision: 0, selector: "h1", signature: "fixture", excerpt: "Page title", rect: { x: 1, y: 1, width: 100, height: 20 }, viewport: { width: 640, height: 480, scrollX: 0, scrollY: 0, zoom: 1 } },
        screenshot: { mimeType: "image/jpeg" as const, data: "/9j/2Q==" } } : undefined;
      const next = { generation: 1, revision: ++revision, tabs, activeTabId, preferences, ...(management ? { management } : {}), ...(annotation ? { annotation } : {}), ...(action.action === "locate_annotation" ? { annotationStatus: "stale" as const } : {}), ...(openedIn ? { openedIn } : {}) };
      states.set(JSON.stringify(workspace), next); listeners.forEach(listener => listener()); return next;
    },
    reportViewport: viewport => { viewports.push(viewport); },
    onStateChanged(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onAddressFocusRequested: () => () => {},
  };
  if (!query.has("web") && !query.has("native")) Object.defineProperty(window, "lingDesktop", { configurable: true, value: { browser: capability } });
  const container = document.createElement("main"); document.body.append(container); const root = createRoot(container);
  window.browserFixture = { calls, viewports, submissions: [], subscriptions: () => listeners.size, dispose: () => { root.unmount(); container.remove(); } };
  root.render(<I18nProvider><ThemeProvider><LingUiProvider><Fixture cwd={query.get("workspace") ?? "/browser-fixture"} /></LingUiProvider></ThemeProvider></I18nProvider>);
}

function Fixture({ cwd: initialCwd }: { readonly cwd: string }): React.JSX.Element {
  const [cwd, setCwd] = useState(initialCwd);
  const [surface, setSurface] = useState<DesktopBrowserScope["surface"]>("normal_conversation");
  const [pageRequest, setPageRequest] = useState<{ page: "browser"; nonce: number } | undefined>({ page: "browser", nonce: 1 });
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [annotationFiles, setAnnotationFiles] = useState<string[]>([]);
  const [overlay, setOverlay] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const browserLinkError = useConversationBrowserLinks({ rootRef, workspaceCwd: cwd, surface, ownerId: `thread-${surface}`,
    onOpen: () => setPageRequest({ page: "browser", nonce: Date.now() }) });
  return <div ref={rootRef} style={{ display: "flex", position: "fixed", inset: 20, gap: 20, background: "var(--ling-bg-panel)", color: "var(--ling-text-primary)" }}>
    <style>{".browser-fixture-dock { width: 100%; }"}</style>
    <section style={{ flex: 1, padding: 20 }}><h1>Browser workspace</h1><p>Conversation preview fixture</p>
      {browserLinkError ? <InlineFeedback tone="danger" role="alert">{browserLinkError}</InlineFeedback> : null}
      <p><a href="http://localhost:3000/from-chat" target="_blank" rel="noreferrer">Local preview link</a></p>
      <p><a href="https://example.com/from-chat" target="_blank" rel="noreferrer">Website link</a></p>
      {(["normal_conversation", "channel", "teammate_direct"] as const).map(item => <button key={item} onClick={() => { setSurface(item); setPageRequest({ page: "browser", nonce: Date.now() }); }}>{item}</button>)}
      <button onClick={() => { setCwd(value => value === initialCwd ? `${initialCwd}-secondary` : initialCwd); setPageRequest({ page: "browser", nonce: Date.now() }); }}>Switch workspace</button>
      <p data-testid="annotation-draft">{annotationDraft}</p><p data-testid="annotation-files">{annotationFiles.join(", ")}</p>
      <button onClick={() => setOverlay(true)}>Open approval overlay</button>
    </section>
    <div style={{ width: "54%", display: "flex", minWidth: 0 }}>
      <WorkspaceRightDock key={`${cwd}:${surface}`} className="browser-fixture-dock" surface={surface} browserScopeId={`thread-${surface}`} cwd={cwd} open ariaLabel="Browser workspace dock"
        launcherTitle="Workspace" onBrowserAnnotation={async ({ comment, files }) => { setAnnotationDraft(comment); setAnnotationFiles(files.map(file => file.name)); window.browserFixture.submissions.push({ comment, fileNames: files.map(file => file.name), metadata: JSON.parse(await files[0]!.text()) }); }} reviewItems={[]} evidenceGroups={[{ id: "browser", label: "Web evidence", items: [{
          id: "browser-evidence", kind: "browser", title: "Recorded browser evidence", summary: "Saved page summary", href: "https://example.com/recorded",
        }] }]} fileItems={[]} pageRequest={pageRequest} onPageRequestConsumed={() => setPageRequest(undefined)} />
    </div>
    {overlay ? <div role="dialog" aria-label="Approval fixture" style={{ position: "fixed", inset: 100, zIndex: 100, background: "var(--ling-bg-panel)" }}>
      <button onClick={() => setOverlay(false)}>Dismiss approval overlay</button></div> : null}
  </div>;
}
