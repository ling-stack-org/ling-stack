import { useEffect, useState } from "react";
import { PackageOpen } from "lucide-react";
import type { OptionalSkillPackAction, OptionalSkillPackView } from "@ling-stack/contracts";
import { daemonClient } from "../../api/client.js";
import { selectWorkspaceDirectory } from "../../api/workspace-directory.js";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, Switch } from "../../shared/ui/index.js";

export function OptionalSkillPacks({ cwd, onSkillPacksChanged }: {
  readonly cwd: string;
  readonly onSkillPacksChanged: () => void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [packs, setPacks] = useState<readonly OptionalSkillPackView[]>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!cwd) return;
    let current = true;
    setError("");
    void daemonClient.listOptionalSkillPacks(cwd).then(result => {
      if (current) setPacks(result.packs);
    }, error => {
      if (current) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [cwd, retry]);

  if (!cwd) return <p role="status">{t("Select a workspace to manage skill packs.")}</p>;
  if (error) return (
    <InlineFeedback role="alert" tone="danger" title={t("Skill packs could not be loaded.")}>
      {error} <Button size="sm" onClick={() => setRetry(value => value + 1)}>{t("Retry")}</Button>
    </InlineFeedback>
  );
  if (!packs) return <p role="status">{t("Loading")}</p>;
  return (
    <div aria-label={t("Skill packs")} className="plugin-marketplace-list">
      {packs.map(pack => <SkillPackRow key={pack.id} pack={pack} cwd={cwd} onChanged={changed => {
        setPacks(current => current?.map(row => row.id === changed.id ? changed : row));
        onSkillPacksChanged();
      }}
        locale={locale} />)}
    </div>
  );
}

function SkillPackRow({ pack, cwd, onChanged, locale }: {
  readonly pack: OptionalSkillPackView;
  readonly cwd: string;
  readonly onChanged: (pack: OptionalSkillPackView) => void;
  readonly locale: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [busy, setBusy] = useState<OptionalSkillPackAction["action"]>();
  const [error, setError] = useState("");
  const installed = pack.version !== undefined;
  const canInstall = pack.id === "superpowers" || Boolean(pack.retainedVersion);
  const status = pack.state === "enabled" ? t("Enabled in this workspace")
    : pack.state === "disabled" ? t("Disabled in this workspace")
      : pack.issue === "missing_dependencies" ? t("Runtime dependencies missing")
        : pack.issue === "incompatible_platform" ? t("Incompatible platform")
          : pack.state === "unavailable" ? t("Unavailable") : t("Not installed");
  const size = pack.downloadBytes && new Intl.NumberFormat(locale, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 })
    .format(pack.downloadBytes / 1000);
  const guide = pack.id === "gstack"
    ? "https://github.com/ling-stack-org/ling-stack/blob/main/docs/design/gstack-optional-plugin.md#从源码准备-gstack-运行时"
    : pack.upstreamUrl;

  async function change(action: OptionalSkillPackAction["action"]): Promise<void> {
    setError("");
    setBusy(action);
    try {
      let request: OptionalSkillPackAction;
      if (action === "connect") {
        const selected = await selectWorkspaceDirectory(cwd);
        if (selected.cancelled) return;
        request = { action, path: selected.path };
      } else {
        request = { action };
      }
      const result = await daemonClient.changeOptionalSkillPack(cwd, pack.id, request);
      const changed = result.packs.find(item => item.id === pack.id);
      if (changed) onChanged(changed);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <article className="plugin-marketplace-row plugin-skill-pack-row" aria-label={pack.name}>
      <span className="plugin-marketplace-icon" aria-hidden="true"><PackageOpen /></span>
      <div className="plugin-marketplace-copy">
        <div className="plugin-marketplace-name"><strong>{pack.name}</strong></div>
        <span>{status}{pack.version && ` · ${pack.version}`}{!installed && size ? ` · ${size}` : null}</span>
        <a href={guide} target="_blank" rel="noreferrer">{t("Installation guide")}</a>
        {error ? <InlineFeedback role="alert" tone="danger">{error}</InlineFeedback> : null}
      </div>
      <div className="plugin-marketplace-toggle">
        {canInstall && (!installed || pack.state === "unavailable") ? (
          <Button size="sm" variant="primary" disabled={Boolean(busy)} loading={busy === "install"}
            onClick={() => void change("install")}>{pack.id === "gstack" ? t("Use previous installation") : t("Install")}</Button>
        ) : null}
        <Button size="sm" variant="secondary" disabled={Boolean(busy)} loading={busy === "connect"}
          onClick={() => void change("connect")}>{t("Connect folder")}</Button>
        {pack.previousVersion ? (
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} loading={busy === "rollback"}
            onClick={() => void change("rollback")}>{t("Roll back")} {pack.previousVersion}</Button>
        ) : null}
        {installed && pack.state !== "unavailable" ? (
          <Switch aria-label={t("Enable {name} in this workspace", { name: pack.name })} checked={pack.state === "enabled"}
            disabled={Boolean(busy)} loading={busy === "enable" || busy === "disable"}
            onCheckedChange={enabled => void change(enabled ? "enable" : "disable")} />
        ) : null}
        {installed && pack.state !== "enabled" ? (
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} loading={busy === "uninstall"}
            onClick={() => void change("uninstall")}>{t("Disconnect")}</Button>
        ) : null}
      </div>
    </article>
  );
}
