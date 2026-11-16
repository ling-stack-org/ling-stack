import { BrowserManagementPanel } from "./BrowserManagementPanel.js";
import type { DesktopBrowserAnnotation } from "../../../../desktop/shared/browser-annotations.js";
import { BrowserAnnotationEditor } from "./BrowserAnnotationEditor.js";
import type { BrowserAnnotationHandler } from "./browser-annotation-submission.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, LockKeyhole, Maximize2, Minimize2, Plus, RotateCw, Settings2, Square, MousePointer2, Scan, X } from "lucide-react";
import type { DesktopBrowserScope } from "@ling-stack/contracts";
import type { DesktopBrowserUserAction, DesktopBrowserWorkspaceState } from "../../../../desktop/shared/browser-capabilities.js";
import { Button, EmptyState, IconButton, InlineFeedback, Input } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { useBrowserViewport } from "./use-browser-viewport.js";
import { BrowserPreferencesPanel } from "./BrowserPreferencesPanel.js";
import "./browser-workspace.css";

type BrowserAction = DesktopBrowserUserAction extends infer Action ? Action extends DesktopBrowserUserAction ? Omit<Action, "workspaceCwd" | "scope"> : never : never;

export function browserAddress(value: string): string {
  const text = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(text) || /^(?:javascript|file|data|about|chrome):/iu.test(text)) return text;
  return `${/^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::|\/|$)/iu.test(text) ? "http" : "https"}://${text}`;
}

interface BrowserWorkspaceProps {
  readonly onAnnotation?: BrowserAnnotationHandler;
  readonly workspaceCwd: string; readonly surface: DesktopBrowserScope["surface"]; readonly ownerId: string;
}

export function BrowserWorkspace({ evidence, ...workspace }: BrowserWorkspaceProps & { readonly evidence?: ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  const [showEvidence, setShowEvidence] = useState(false);
  return (
    <div className="browser-workspace-container">
      {evidence !== undefined ? (
        <div className="browser-workspace-mode" role="group" aria-label={t("Browser")}>
          <Button size="sm" variant={showEvidence ? "ghost" : "secondary"} aria-pressed={!showEvidence} onClick={() => setShowEvidence(false)}>{t("Browser")}</Button>
          <Button size="sm" variant={showEvidence ? "secondary" : "ghost"} aria-pressed={showEvidence} onClick={() => setShowEvidence(true)}>{t("Evidence")}</Button>
        </div>
      ) : null}
      {showEvidence ? evidence : <BrowserPage {...workspace} />}
    </div>
  );
}

function BrowserPage({ workspaceCwd, surface, ownerId, onAnnotation }: BrowserWorkspaceProps): React.JSX.Element {
  const { t } = useI18n();
  const capability = window.lingDesktop?.browser;
  const workspace = useMemo(() => ({ workspaceCwd, scope: { surface, ownerId } }), [workspaceCwd, surface, ownerId]);
  const [state, setState] = useState<DesktopBrowserWorkspaceState>();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [annotation, setAnnotation] = useState<DesktopBrowserAnnotation>();
  const [annotationStatus, setAnnotationStatus] = useState<"available" | "stale">();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null), addressRef = useRef<HTMLInputElement>(null);
  const lifetime = useRef(0);
  const tab = state?.tabs.find(item => item.id === state.activeTabId);
  const commitState = useCallback((next: DesktopBrowserWorkspaceState): void => {
    setState(previous => previous && (previous.generation > next.generation
      || previous.generation === next.generation && previous.revision > next.revision) ? previous : next);
  }, []);

  useEffect(() => {
    const epoch = ++lifetime.current;
    let reading = false, dirty = false;
    const read = (): void => {
      if (!capability || lifetime.current !== epoch) return;
      if (reading) { dirty = true; return; }
      reading = true;
      void capability.getState(workspace).then(value => { if (lifetime.current === epoch) commitState(value); })
        .catch(() => { if (lifetime.current === epoch) setError(t("Browser is unavailable in this workspace.")); })
        .finally(() => { reading = false; if (dirty) { dirty = false; read(); } });
    };
    let unsubscribe: (() => void) | undefined;
    void capability?.act({ ...workspace, action: "activate_workspace" }).then(value => {
      if (lifetime.current !== epoch) return;
      commitState(value); unsubscribe = capability.onStateChanged(read); read();
    }).catch(() => { if (lifetime.current === epoch) setError(t("Browser is unavailable in this workspace.")); });
    return () => { lifetime.current++; unsubscribe?.(); };
  }, [capability, workspace, t, commitState]);

  useEffect(() => { if (!newTab) setAddress(tab?.url ?? ""); }, [tab?.id, tab?.url, newTab]);
  useBrowserViewport(capability, hostRef, workspace, state);

  const act = useCallback((action: BrowserAction): void => {
    if (!capability) return;
    const epoch = lifetime.current;
    setBusy(true); setSelecting(action.action === "annotate"); setError("");
    void capability.act({ ...workspace, ...action } as DesktopBrowserUserAction)
      .then(value => { if (lifetime.current === epoch) {
        commitState(value); setNewTab(false);
        if (value.annotation) { setAnnotation(value.annotation); setAnnotationStatus(undefined); }
        if (value.annotationStatus) setAnnotationStatus(value.annotationStatus);
        if (action.action === "navigate" || action.action === "open") setAddress(value.tabs.find(item => item.id === value.activeTabId)?.url ?? "");
      } })
      .catch(() => { if (lifetime.current === epoch) setError(t("The browser action could not complete. Check the address and try again.")); })
      .finally(() => { if (lifetime.current === epoch) setBusy(false); setSelecting(false); });
  }, [capability, workspace, t, commitState]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!address.trim()) return;
    if (tab && !newTab) act({ action: "navigate", tabId: tab.id, url: browserAddress(address) });
    else act({ action: "open", url: browserAddress(address) });
  };
  useEffect(() => {
    const focusAddress = (): void => { addressRef.current?.focus(); addressRef.current?.select(); };
    const shortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") { event.preventDefault(); focusAddress(); }
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", shortcut);
    const unsubscribe = capability?.onAddressFocusRequested(focusAddress);
    return () => { document.removeEventListener("keydown", shortcut); unsubscribe?.(); };
  }, [capability]);

  return (
    <section className={`browser-workspace${expanded ? " is-expanded" : ""}`} aria-label={t("Ling Browser")}>
      <div className="browser-tab-strip" role="tablist" aria-label={t("Browser tabs")}>
        {state?.tabs.map(item => (
          <div className="browser-tab" key={item.id}>
            <Button role="tab" aria-selected={item.id === tab?.id} size="sm" variant={item.id === tab?.id ? "secondary" : "ghost"}
              onClick={() => act({ action: "activate", tabId: item.id })} title={item.url}>{item.title || new URL(item.url).host}</Button>
            <IconButton icon={X} label={t("Close browser tab")} onClick={() => act({ action: "close", tabId: item.id })} />
          </div>
        ))}
        <IconButton icon={Plus} label={t("Open a browser tab")} disabled={busy || (state?.tabs.length ?? 0) >= 12} onClick={() => { setNewTab(true); setAddress(""); addressRef.current?.focus(); addressRef.current?.select(); }} />
        <IconButton icon={expanded ? Minimize2 : Maximize2} label={expanded ? t("Show browser beside chat") : t("Expand browser")} pressed={expanded} onClick={() => setExpanded(value => !value)} />
        <IconButton icon={Settings2} label={t("Browser settings")} pressed={settingsOpen} onClick={() => setSettingsOpen(value => !value)} />
      </div>
      {onAnnotation && tab ? <div className="browser-panel-actions">
        <IconButton icon={MousePointer2} label={t("Annotate element")} disabled={busy} onClick={() => act({ action: "annotate", tabId: tab.id, kind: "element", screenshot: true })} />
        <IconButton icon={Scan} label={t("Annotate region")} disabled={busy} onClick={() => act({ action: "annotate", tabId: tab.id, kind: "region", screenshot: true })} />
        {selecting ? <span role="status">{t("Select the page. Press Escape to cancel.")}</span> : null}
      </div> : null}
      {annotation && onAnnotation ? <BrowserAnnotationEditor annotation={annotation} onSubmit={onAnnotation} onClose={() => setAnnotation(undefined)} status={annotationStatus}
        onLocate={() => { const { screenshot: _screenshot, ...metadata } = annotation; act({ action: "locate_annotation", annotation: metadata }); }} /> : null}
      {settingsOpen && state ? <div className="browser-settings-panel"><BrowserPreferencesPanel preferences={state.preferences} disabled={busy} onChange={preferences => act({ action: "preferences", preferences })} />
        {state.management ? <BrowserManagementPanel state={state.management} cwd={workspaceCwd} url={tab?.url} disabled={busy} act={act} /> : null}</div> : null}
      <form className="browser-navigation" onSubmit={submit}>
        <IconButton icon={ArrowLeft} label={t("Back")} disabled={!tab?.canGoBack || busy} onClick={() => tab && act({ action: "back", tabId: tab.id })} />
        <IconButton icon={ArrowRight} label={t("Forward")} disabled={!tab?.canGoForward || busy} onClick={() => tab && act({ action: "forward", tabId: tab.id })} />
        <IconButton icon={tab?.loading ? Square : RotateCw} label={tab?.loading ? t("Stop loading page") : t("Reload page")} disabled={!tab}
          onClick={() => tab && act({ action: tab.loading ? "stop" : "reload", tabId: tab.id })} />
        <Input ref={addressRef} value={address} aria-label={t("Browser address")} placeholder={t("Website or localhost address")} autoComplete="off" spellCheck={false}
          prefix={tab?.url.startsWith("https:") ? <LockKeyhole size={14} /> : <Globe2 size={14} />} onChange={event => setAddress(event.target.value)} />
        <Button type="submit" size="sm" disabled={busy || !address.trim()}>{t("Go")}</Button>
        <IconButton icon={ExternalLink} label={t("Open in system browser")} disabled={!tab} onClick={() => tab && act({ action: "open_external", tabId: tab.id })} />
      </form>
      {error || tab?.error ? <InlineFeedback tone="danger" role="alert">{error || t("The page could not load or a browser request was blocked.")}</InlineFeedback> : null}
      {state?.persistenceError ? <InlineFeedback tone="warning">{t("Browser preferences could not be saved or restored.")}</InlineFeedback> : null}
      <div className="browser-native-viewport" ref={hostRef} data-browser-viewport>
        {tab ? <p className="browser-viewport-placeholder">{tab.loading ? t("Loading page…") : t("The website appears here in Ling Desktop.")}</p>
          : <EmptyState title={t("Open a website or development preview")} description={t("Enter a website or localhost address above. Browser tabs belong to this conversation.")} />}
      </div>
      {tab ? (
        <div className="browser-control-status">
          <span role="status">{tab.control === "agent" ? t("Agent control available") : t("You are in control")}</span>
          <Button size="sm" onClick={() => act({ action: tab.control === "agent" ? "take_control" : "release_control", tabId: tab.id })}>
            {tab.control === "agent" ? t("Take control") : t("Allow agent control")}
          </Button>
        </div>
      ) : null}
      <p className="browser-workspace-hint">{t("Agent actions still require your tool permissions. Typing or clicking in the page pauses Agent control.")}</p>
    </section>
  );
}
