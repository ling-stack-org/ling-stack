import { useEffect, useState } from "react";
import { desktopBrowserSiteRule, defaultDesktopBrowserPolicy, defaultDesktopBrowserRule, parseDesktopBrowserPolicy, type DesktopBrowserDefaultRule, type DesktopBrowserPolicy, type DesktopBrowserSiteRule } from "@ling-stack/contracts";
import { getWorkspaceSettings, updateWorkspaceSettings } from "../../api/workspace-settings.js";
import { Button, Checkbox, Field, InlineFeedback, Input, Select } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";

export function BrowserSitePolicyPanel({ cwd, url, showDefaults = false }: { readonly cwd: string; readonly url?: string; readonly showDefaults?: boolean }): React.JSX.Element {
  const { t } = useI18n(); const [policy, setPolicy] = useState<DesktopBrowserPolicy>(defaultDesktopBrowserPolicy);
  const [origin, setOrigin] = useState(url ? new URL(url).origin : ""); const [rule, setRule] = useState<DesktopBrowserSiteRule>();
  const [loaded, setLoaded] = useState(false); const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(true); const [error, setError] = useState(false);
  const [defaults, setDefaults] = useState<DesktopBrowserDefaultRule>(defaultDesktopBrowserRule);
  useEffect(() => { let alive = true; setBusy(true); setError(false); setLoaded(false); void getWorkspaceSettings(cwd).then(response => { if (alive) { const next = response.settings.desktopBrowserPolicy ?? defaultDesktopBrowserPolicy; setPolicy(next); setDefaults(next.defaults ?? defaultDesktopBrowserRule); setLoaded(true); setBusy(false); } }).catch(() => { if (alive) { setError(true); setBusy(false); } }); return () => { alive = false; }; }, [cwd, retry]);
  useEffect(() => { try { const parsed = new URL(origin); if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) throw new Error("origin"); setRule(desktopBrowserSiteRule(policy, origin)); } catch { setRule(undefined); } }, [origin, policy]);
  const save = (next: DesktopBrowserPolicy): void => {
    let parsed: DesktopBrowserPolicy;
    try { parsed = parseDesktopBrowserPolicy(next); } catch { setError(true); return; }
    setBusy(true); setError(false); void updateWorkspaceSettings(cwd, { desktopBrowserPolicy: parsed }).then(response => { const saved = response.settings.desktopBrowserPolicy ?? defaultDesktopBrowserPolicy; setPolicy(saved); setDefaults(saved.defaults ?? defaultDesktopBrowserRule); })
      .catch(() => setError(true)).finally(() => setBusy(false));
  };
  return <div className="browser-management-section">
    {showDefaults ? <>
      <h2>{t("Default website permissions")}</h2>
      {(["browse", "downloads", "history"] as const).map(key => <Field key={key} label={key === "browse" ? t("Agent browsing") : key === "downloads" ? t("Agent downloads") : t("Agent history access")}>
        <Select disabled={busy || !loaded} value={defaults[key]} onChange={event => setDefaults({ ...defaults, [key]: event.currentTarget.value as "ask" | "allow" | "deny" })}>
          <option value="ask">{t("Ask")}</option><option value="allow">{t("Allow with tool approval")}</option><option value="deny">{t("Deny")}</option>
        </Select>
      </Field>)}
      <Checkbox label={t("Allow website tools when available")} checked={defaults.webMcp} disabled={busy || !loaded} onChange={event => setDefaults({ ...defaults, webMcp: event.currentTarget.checked })} />
      <Button size="sm" disabled={busy || !loaded} onClick={() => save({ ...policy, defaults })}>{t("Save default permissions")}</Button>
      <h2>{t("Website permissions")}</h2>
    </> : null}
    <p>{t("Site rules add restrictions to MCP approvals. Page content cannot grant permission.")}</p>
    {error ? <InlineFeedback tone="danger" role="alert">{t("Site permissions could not be loaded or saved.")} <Button size="sm" disabled={busy} onClick={() => setRetry(value => value + 1)}>{t("Retry")}</Button></InlineFeedback> : null}
    <Input aria-label={t("Website origin")} value={origin} onChange={event => setOrigin(event.currentTarget.value)} placeholder="https://example.com" />
    {origin && !rule ? <InlineFeedback tone="warning">{t("Enter an exact website origin, including http or https.")}</InlineFeedback> : null}
    {rule ? <>
      {(["browse", "downloads", "history"] as const).map(key => <Field key={key} label={key === "browse" ? t("Agent browsing") : key === "downloads" ? t("Agent downloads") : t("Agent history access")}>
        <Select disabled={busy} value={rule[key]} onChange={event => setRule({ ...rule, [key]: event.currentTarget.value })}>
          <option value="ask">{t("Ask")}</option><option value="allow">{t("Allow with tool approval")}</option><option value="deny">{t("Deny")}</option>
        </Select>
      </Field>)}
      <Checkbox label={t("Allow tab CDP commands with separate confirmation")} checked={rule.fullCdp} disabled={busy} onChange={event => setRule({ ...rule, fullCdp: event.currentTarget.checked })} />
      <Checkbox label={t("Allow website tools when available")} checked={rule.webMcp} disabled={busy} onChange={event => setRule({ ...rule, webMcp: event.currentTarget.checked })} />
      <div className="browser-panel-actions">
        <Button size="sm" disabled={busy || !loaded} onClick={() => save({ ...policy, rules: [...policy.rules.filter(item => item.origin !== rule.origin), rule] })}>{t("Save site permissions")}</Button>
        <Button size="sm" variant="ghost" disabled={busy || !loaded} onClick={() => save({ ...policy, rules: policy.rules.filter(item => item.origin !== rule.origin) })}>{t("Reset site permissions")}</Button>
      </div>
    </> : null}
    {policy.rules.map(item => <Button key={item.origin} size="sm" variant="ghost" onClick={() => setOrigin(item.origin)}>{item.origin}</Button>)}
  </div>;
}
