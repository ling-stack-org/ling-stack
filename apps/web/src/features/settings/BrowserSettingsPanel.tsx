import { useEffect, useState } from "react";
import type { DesktopBrowserSettingsAction } from "../../../../desktop/shared/browser-capabilities.js";
import { BROWSER_HISTORY_CLEAR_ALL_SINCE, type BrowserDevicePermission, type BrowserManagementState } from "../../../../desktop/shared/browser-management.js";
import { Button, Checkbox, Field, InlineFeedback, Input, Select, Skeleton } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { BrowserSitePolicyPanel } from "../browser/BrowserSitePolicyPanel.js";

type SettingsAction = DesktopBrowserSettingsAction extends infer A ? A extends DesktopBrowserSettingsAction ? Omit<A, "workspaceCwd"> : never : never;

export function BrowserSettingsPanel({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const capability = window.lingDesktop?.browser;
  const [state, setState] = useState<BrowserManagementState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [deviceOrigin, setDeviceOrigin] = useState("");
  const [devicePermission, setDevicePermission] = useState<BrowserDevicePermission>("camera");
  const [deviceDecision, setDeviceDecision] = useState<"allow" | "deny">("deny");
  const [clear, setClear] = useState({ cookies: false, cache: false, storage: false, history: false });

  const validDeviceOrigin = (() => {
    try {
      const url = new URL(deviceOrigin);
      return ["http:", "https:"].includes(url.protocol) && url.origin === deviceOrigin;
    } catch { return false; }
  })();

  useEffect(() => {
    if (!capability) return;
    let alive = true;
    const refresh = (): void => {
      void capability.getSettingsState(cwd).then(next => { if (alive) { setState(next); setError(false); setLoading(false); } })
        .catch(() => { if (alive) { setError(true); setLoading(false); } });
    };
    setState(undefined); setLoading(true); refresh();
    const unsubscribe = capability.onStateChanged(refresh);
    return () => { alive = false; unsubscribe(); };
  }, [capability, cwd, retry]);

  const act = (action: SettingsAction): void => {
    if (!capability || busy) return;
    setBusy(action.action); setError(false);
    void capability.actSettings({ ...action, workspaceCwd: cwd } as DesktopBrowserSettingsAction)
      .then(next => setState(next)).catch(() => setError(true)).finally(() => setBusy(""));
  };

  return <div className="settings-browser" data-browser-settings="true">
    <header><h1>{t("Browser")}</h1><p>{t("Manage the built-in browser for this workspace.")}</p></header>
    <BrowserSitePolicyPanel key={cwd} cwd={cwd} showDefaults />
    {loading && !state ? <Skeleton height={140} /> : null}
    {error || state?.error ? <InlineFeedback tone="danger" role="alert">{t("Browser data could not be saved or restored.")} <Button size="sm" onClick={() => setRetry(value => value + 1)}>{t("Retry")}</Button></InlineFeedback> : null}
    {state ? <>
      <section><h2>{t("Browser history")}</h2>
        <Input value={query} aria-label={t("Search browser history")} onChange={event => setQuery(event.currentTarget.value)} />
        <div className="settings-browser-history">{state.history.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase())).slice(0, 50).map(item =>
          <div key={item.id}><span title={item.url}>{item.title || item.url}</span><Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act({ action: "history_clear", since: 0, id: item.id })}>{t("Remove")}</Button></div>)}</div>
        {state.history.length ? <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act({ action: "history_clear", since: BROWSER_HISTORY_CLEAR_ALL_SINCE })}>{t("Clear history")}</Button> : null}
      </section>
      <section><h2>{t("Downloads")}</h2>
        <div className="settings-browser-inline"><span>{state.downloadDirectory}</span><Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => act({ action: "download_directory" })}>{t("Choose download folder")}</Button></div>
        <Checkbox label={t("Ask where to save each download")} checked={state.askBeforeDownload} disabled={Boolean(busy)} onChange={event => act({ action: "download_preferences", askBeforeDownload: event.currentTarget.checked })} />
      </section>
      <section><h2>{t("Device permissions")}</h2><p>{t("Website devices are available only during human control.")}</p>
        <div className="settings-browser-device-form">
          <Field label={t("Website origin")}><Input value={deviceOrigin} onChange={event => setDeviceOrigin(event.currentTarget.value)} placeholder="https://example.com" /></Field>
          <Field label={t("Device permission")}><Select value={devicePermission} onChange={event => setDevicePermission(event.currentTarget.value as BrowserDevicePermission)}>
            <option value="camera">{t("Camera")}</option><option value="microphone">{t("Microphone")}</option>
            <option value="geolocation">{t("Location")}</option><option value="notifications">{t("Notifications")}</option>
          </Select></Field>
          <Field label={t("Status")}><Select value={deviceDecision} onChange={event => setDeviceDecision(event.currentTarget.value as "allow" | "deny")}>
            <option value="deny">{t("Deny")}</option><option value="allow">{t("Allow")}</option>
          </Select></Field>
          <Button size="sm" disabled={Boolean(busy) || !validDeviceOrigin} onClick={() => act({ action: "device_permission", rule: { origin: deviceOrigin, permission: devicePermission, decision: deviceDecision } })}>{t("Save")}</Button>
        </div>
        {deviceOrigin && !validDeviceOrigin ? <InlineFeedback tone="warning">{t("Enter an exact website origin, including http or https.")}</InlineFeedback> : null}
        {state.devices.map(rule => <div className="settings-browser-device-row" key={`${rule.origin}:${rule.permission}`}>
          <span title={rule.origin}>{rule.origin}</span><span>{rule.permission === "camera" ? t("Camera") : rule.permission === "microphone" ? t("Microphone") : rule.permission === "geolocation" ? t("Location") : t("Notifications")}</span>
          <Select aria-label={`${rule.origin} ${rule.permission}`} disabled={Boolean(busy)} value={rule.decision === "allow" ? "allow" : "deny"} onChange={event => act({ action: "device_permission", rule: { ...rule, decision: event.currentTarget.value as "allow" | "deny" } })}>
            <option value="deny">{t("Deny")}</option><option value="allow">{t("Allow")}</option>
          </Select>
        </div>)}
      </section>
      <section><h2>{t("Browser data")}</h2><p>{t("Clearing cookies or site storage can sign you out of this browser profile.")}</p>
        <div className="settings-browser-options">{(["cookies", "cache", "storage", "history"] as const).map(key => <Checkbox key={key}
          label={key === "cookies" ? t("Cookies") : key === "cache" ? t("Cache") : key === "storage" ? t("Site storage") : t("Browser history")}
          checked={clear[key]} disabled={Boolean(busy)} onChange={event => setClear({ ...clear, [key]: event.currentTarget.checked })} />)}</div>
        <Button size="sm" variant="danger" disabled={Boolean(busy) || !Object.values(clear).some(Boolean)} onClick={() => act({ action: "clear_data", ...clear })}>{t("Review and clear browser data")}</Button>
      </section>
    </> : null}
  </div>;
}
