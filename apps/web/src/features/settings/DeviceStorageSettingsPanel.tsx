import { useEffect, useState } from "react";
import type { DeviceStorageCategory, DeviceStorageCategorySize, DeviceStorageScope, DeviceStorageSnapshot } from "@ling-stack/contracts";
import { daemonClient } from "../../api/client.js";
import { useI18n } from "../../i18n.js";
import { Button, InlineFeedback, Select, Skeleton } from "../../shared/ui/index.js";

const categoryOrder: readonly DeviceStorageCategory[] = ["conversations", "worktrees", "plugins", "browser", "other"];

export function DeviceStorageSettingsPanel({ cwd, onOpenConversations, onOpenPlugins, onOpenWorktrees, onOpenBrowser }: {
  readonly cwd: string;
  readonly onOpenConversations: () => void;
  readonly onOpenPlugins: () => void;
  readonly onOpenWorktrees: () => void;
  readonly onOpenBrowser?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useState<DeviceStorageScope>("all");
  const [generation, setGeneration] = useState(0);
  const [snapshot, setSnapshot] = useState<DeviceStorageSnapshot>();
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true, jobId = "";
    setScanning(true); setError(false);
    const run = async (): Promise<void> => {
      try {
        const started = await daemonClient.startDeviceStorageScan(cwd, scope);
        jobId = started.id;
        let job = started;
        while (alive && job.status === "scanning") {
          await new Promise(resolve => setTimeout(resolve, 350));
          if (!alive) break;
          job = await daemonClient.getDeviceStorageScan(cwd, jobId);
        }
        if (!alive) return;
        if (!job.snapshot) throw new Error("storage_scan_unavailable");
        const browser = await window.lingDesktop?.browser?.getProfileSize(cwd, scope).catch((): DeviceStorageCategorySize =>
          ({ category: "browser", knownBytes: 0, status: "unavailable", reason: "browser_profile_unavailable" }));
        if (!alive) return;
        const categories = job.snapshot.categories.map(row => row.category === "browser" && browser ? browser : row);
        setSnapshot({ ...job.snapshot, categories, knownBytes: categories.reduce((sum, row) => sum + row.knownBytes, 0),
          complete: categories.every(row => row.status === "complete") });
      } catch { if (alive) setError(true); }
      finally { if (alive) setScanning(false); }
    };
    void run();
    return () => { alive = false; if (jobId) void daemonClient.cancelDeviceStorageScan(cwd, jobId).catch(() => undefined); };
  }, [cwd, scope, generation]);

  const labels: Record<DeviceStorageCategory, string> = {
    conversations: t("Conversations and attachments"), worktrees: t("Worktrees"), plugins: t("Plugins and cache"), browser: t("Browser data"), other: t("Other"),
  };
  const actions: Partial<Record<DeviceStorageCategory, { label: string; run: () => void }>> = {
    conversations: { label: t("View conversations"), run: onOpenConversations },
    worktrees: { label: t("Manage worktrees"), run: onOpenWorktrees },
    plugins: { label: t("View plugins"), run: onOpenPlugins },
    ...(onOpenBrowser ? { browser: { label: t("Manage browser data"), run: onOpenBrowser } } : {}),
  };
  const format = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  const rows = categoryOrder.map(category => snapshot?.categories.find(row => row.category === category)).filter((row): row is DeviceStorageCategorySize => Boolean(row));

  return <div className="settings-device-storage" data-device-storage="true" aria-busy={scanning}>
    <header><div><h1>{t("Device storage")}</h1><p>{t("Ling file sizes on this computer")}</p></div>
      <Select aria-label={t("Storage scope")} value={scope} onChange={event => { setSnapshot(undefined); setScope(event.currentTarget.value as DeviceStorageScope); }}>
        <option value="all">{t("All workspaces")}</option><option value="current">{t("Current workspace")}</option>
      </Select></header>
    {error ? <InlineFeedback tone="danger" role="alert">{t("Storage scan failed. Try again.")}</InlineFeedback> : null}
    {!snapshot && scanning ? <Skeleton height={170} /> : null}
    {snapshot ? <>
      <div className="settings-device-storage-summary"><div><small>{snapshot.complete ? t("Ling file sizes") : t("Measured so far")}</small>
        <strong>{format(snapshot.knownBytes)}</strong><small>{new Date(snapshot.scannedAt).toLocaleString()}</small></div>
        <Button size="sm" variant="ghost" disabled={scanning} onClick={() => setGeneration(value => value + 1)}>{scanning ? t("Scanning...") : t("Re-scan")}</Button></div>
      <div className="settings-device-storage-bar" role="img" aria-label={t("Measured storage by category")}>{rows.filter(row => row.knownBytes > 0).map(row =>
        <span key={row.category} className={`settings-device-storage-bar--${row.category}`} style={{ flexGrow: row.knownBytes / snapshot.knownBytes }} />)}</div>
      <div className="settings-device-storage-legend">{rows.map(row => <div key={row.category}>
        <span className={`settings-device-storage-dot settings-device-storage-dot--${row.category}`} /><span>{labels[row.category]}</span>
        <strong>{row.status === "unavailable" ? t("Unavailable") : format(row.knownBytes)}</strong></div>)}</div>
      <section><h2>{t("Storage details")}</h2><div className="settings-device-storage-rows">{rows.map(row => <div key={row.category}>
        <div><strong>{labels[row.category]}</strong>{row.category === "worktrees" ? <small>{t("Recovery snapshots still use space")}</small> : null}
          {row.status === "partial" ? <small>{t("Partial measurement")}</small> : null}</div>
        <span>{row.status === "unavailable" ? t("Unavailable") : format(row.knownBytes)}</span>
        {actions[row.category] ? <Button size="sm" variant="secondary" onClick={actions[row.category]!.run}>{actions[row.category]!.label}</Button> : <span />}
      </div>)}</div></section>
    </> : null}
    {!scanning && !snapshot ? <Button size="sm" onClick={() => setGeneration(value => value + 1)}>{t("Retry")}</Button> : null}
  </div>;
}
