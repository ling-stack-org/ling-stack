import { useEffect, useState } from "react";
import type { DesktopBrowserUserAction } from "../../../../desktop/shared/browser-capabilities.js";
import type { BrowserDevicePermission, BrowserManagementState } from "../../../../desktop/shared/browser-management.js";
import { Button, Checkbox, Field, InlineFeedback, Input, Select } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { BrowserSitePolicyPanel } from "./BrowserSitePolicyPanel.js";

type Action = DesktopBrowserUserAction extends infer A ? A extends DesktopBrowserUserAction ? Omit<A, "workspaceCwd" | "scope"> : never : never;
type Panel = "history" | "downloads" | "sites" | "data" | "extensions";
export function BrowserManagementPanel({ state, cwd, url, disabled, act }: { readonly state: BrowserManagementState; readonly cwd: string; readonly url?: string; readonly disabled: boolean; readonly act: (action: Action) => void }): React.JSX.Element {
  const { t } = useI18n(); const [panel, setPanel] = useState<Panel>("history"); const [query, setQuery] = useState(""); const [since, setSince] = useState("all");
  const [clear, setClear] = useState({ cookies: false, cache: false, storage: false, history: false }); const [imports, setImports] = useState<readonly string[]>([]);
  useEffect(() => { setImports(state.importPreview?.map(item => item.url) ?? []); }, [state.importPreview]);
  const origin = url ? new URL(url).origin : undefined;
  const labels = { history: t("Browser history"), downloads: t("Downloads"), sites: t("Site permissions"), data: t("Browser data"), extensions: t("Extensions") };
  return <div className="browser-management">
    <div className="browser-panel-actions" role="group" aria-label={t("Browser management")}>
      {(["history", "downloads", "sites", "data", "extensions"] as const).map(item => <Button key={item} size="sm" variant={panel === item ? "secondary" : "ghost"} aria-pressed={panel === item} onClick={() => setPanel(item)}>{labels[item]}</Button>)}
    </div>
    {state.error ? <InlineFeedback tone="warning">{t("Browser data could not be saved or restored.")}</InlineFeedback> : null}
    {panel === "history" ? <div className="browser-management-section">
      <Input value={query} aria-label={t("Search browser history")} onChange={event => setQuery(event.currentTarget.value)} />
      <div className="browser-panel-actions"><Field label={t("History time range")}><Select value={since} onChange={event => setSince(event.currentTarget.value)}><option value="hour">{t("Last hour")}</option><option value="day">{t("Last day")}</option><option value="all">{t("All time")}</option></Select></Field>
        <Button size="sm" disabled={disabled} onClick={() => act({ action: "history_clear", since: since === "all" ? 0 : Date.now() - (since === "hour" ? 3600000 : 86400000) })}>{t("Clear history")}</Button>
      </div>
      {state.history.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase())).map(item => <div className="browser-management-row" key={item.id}>
        <Button size="sm" variant="ghost" disabled={disabled} title={item.url} onClick={() => act({ action: "open", url: item.url })}>{item.title || item.url}</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => act({ action: "history_clear", since: 0, id: item.id })}>{t("Remove")}</Button>
      </div>)}
    </div> : null}
    {panel === "downloads" ? <div className="browser-management-section">
      <p>{state.downloadDirectory}</p><Button size="sm" disabled={disabled} onClick={() => act({ action: "download_directory" })}>{t("Choose download folder")}</Button>
      <Checkbox label={t("Ask where to save each download")} checked={state.askBeforeDownload} disabled={disabled} onChange={event => act({ action: "download_preferences", askBeforeDownload: event.currentTarget.checked })} />
      {state.downloads.map(item => <div className="browser-management-row" key={item.id}>
        <span>{item.filename} · {item.status === "completed" ? t("Completed") : item.status === "cancelled" ? t("Cancelled") : item.status === "interrupted" ? t("Interrupted") : t("Downloading")} · {item.received}/{item.total} B</span>
        {item.status === "progressing" ? <Button size="sm" disabled={disabled} onClick={() => act({ action: "download_cancel", id: item.id })}>{t("Cancel")}</Button> : item.status === "completed" ? <Button size="sm" disabled={disabled} onClick={() => act({ action: "download_show", id: item.id })}>{t("Show in folder")}</Button> : null}
      </div>)}
    </div> : null}
    {panel === "sites" ? <>
      <BrowserSitePolicyPanel cwd={cwd} url={url} />
      {origin ? <div className="browser-management-section"><p>{t("Website devices are available only during human control.")}</p>
        {(["camera", "microphone", "geolocation", "notifications"] as const).map((permission: BrowserDevicePermission) => <Field key={permission} label={permission === "camera" ? t("Camera") : permission === "microphone" ? t("Microphone") : permission === "geolocation" ? t("Location") : t("Notifications")}>
          <Select disabled={disabled} value={state.devices.find(rule => rule.origin === origin && rule.permission === permission)?.decision ?? "deny"} onChange={event => act({ action: "device_permission", rule: { origin, permission, decision: event.currentTarget.value as "allow" | "deny" } })}>
            <option value="deny">{t("Deny")}</option><option value="allow">{t("Allow")}</option>
          </Select>
        </Field>)}
      </div> : null}
    </> : null}
    {panel === "data" ? <div className="browser-management-section">
      <p>{cwd}</p><p>{t("Clearing cookies or site storage can sign you out of this browser profile.")}</p>
      {(["cookies", "cache", "storage", "history"] as const).map(key => <Checkbox key={key} label={key === "cookies" ? t("Cookies") : key === "cache" ? t("Cache") : key === "storage" ? t("Site storage") : t("Browser history")} checked={clear[key]} disabled={disabled} onChange={event => setClear({ ...clear, [key]: event.currentTarget.checked })} />)}
      <Button size="sm" disabled={disabled || !Object.values(clear).some(Boolean)} onClick={() => act({ action: "clear_data", ...clear })}>{t("Review and clear browser data")}</Button>
      <Button size="sm" disabled={disabled} onClick={() => act({ action: "import_preview" })}>{t("Import Chromium bookmarks JSON")}</Button>
      {state.importPreview ? <><p>{t("Selected links are added to browser history. Credentials are not imported.")}</p>
        {state.importPreview.map((item, index) => <Checkbox key={`${item.url}:${index}`} label={item.title || item.url} checked={imports.includes(item.url)} onChange={event => setImports(event.currentTarget.checked ? [...imports, item.url] : imports.filter(url => url !== item.url))} />)}
        <Button size="sm" disabled={disabled || !imports.length} onClick={() => act({ action: "import_apply", urls: imports })}>{t("Import selected links")}</Button>
      </> : null}
    </div> : null}
    {panel === "extensions" ? <div className="browser-management-section">
      <p>{t("Unpacked MV3 extensions run in this browser profile for the current session. Electron supports a subset of Chrome extension APIs.")}</p>
      <Button size="sm" disabled={disabled} onClick={() => act({ action: "extension_install" })}>{t("Load unpacked extension")}</Button>
      {state.extensions.map(item => <div key={item.id} className="browser-management-row"><span>{item.name} {item.version}</span><Button size="sm" disabled={disabled} onClick={() => act({ action: "extension_remove", id: item.id })}>{t("Remove")}</Button></div>)}
    </div> : null}
  </div>;
}
