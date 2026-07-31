import { Cpu, MonitorCog, RefreshCw, ShieldCheck } from "lucide-react";
import type { ComputerControlController } from "../../../domains/computer-control/use-computer-control-controller.js";
import type { ComputerControlPrimaryAction } from "../../../domains/computer-control/computer-control-view-model.js";
import { useI18n } from "../../../i18n.js";
import { Badge, Button, InlineFeedback, Skeleton, Switch } from "../../../shared/ui/index.js";
import { DesktopComputerUsePreference } from "../DesktopComputerUsePreference.js";
import { ComputerControlStatusDetails } from "./ComputerControlStatusDetails.js";
import { LockedComputerControlSection } from "./LockedComputerControlSection.js";

export function ComputerControlSettingsPage({
  controller,
}: {
  readonly controller: ComputerControlController;
}): JSX.Element | null {
  const { t } = useI18n();
  const view = controller.view;
  if (view.kind === "hidden") return null;
  if (view.kind === "loading") return <ComputerControlLoading />;
  if (view.kind === "error") {
    return (
      <div className="computer-control-settings" data-computer-control-state="error">
        <PageHeader />
        <InlineFeedback tone="danger" title={t("Computer Control could not be loaded")}>{t(errorCopy(view.error))}</InlineFeedback>
        <Button variant="secondary" leadingIcon={<RefreshCw />} onClick={() => void controller.refresh()}>{t("Retry")}</Button>
      </div>
    );
  }

  const phase = phasePresentation(view.phase);
  return (
    <div className="computer-control-settings" data-computer-control-state={view.phase}>
      <PageHeader />
      <section className="computer-control-section computer-control-status-card" aria-labelledby="computer-control-status-title">
        <div className="computer-control-status-copy">
          <span className="computer-control-section-icon"><MonitorCog aria-hidden="true" /></span>
          <span>
            <span className="computer-control-eyebrow">{t("System capability")}</span>
            <h2 id="computer-control-status-title">{t(phase.title)}</h2>
            <p>{t(phase.description)}</p>
          </span>
        </div>
        <div className="computer-control-status-actions">
          <Switch
            aria-label={t("Enable Computer Control")}
            checked={view.checked}
            disabled={view.switchDisabled}
            loading={view.busyAction === "enable" || view.busyAction === "disable"}
            onCheckedChange={(checked) => void controller.setRequestedEnabled(checked)}
          />
          <Badge tone={phase.tone}>{t(phase.badge)}</Badge>
        </div>
        {view.primaryAction.kind !== "none" ? (
          <PrimaryAction action={view.primaryAction} controller={controller} busy={Boolean(view.busyAction)} />
        ) : null}
        {view.errorMessage ? <InlineFeedback tone="danger">{view.errorMessage}</InlineFeedback> : null}
      </section>

      <section className="computer-control-section" aria-labelledby="computer-control-readiness-title">
        <SectionHeader icon={<ShieldCheck />} title={t("System readiness")} id="computer-control-readiness-title" />
        <ComputerControlStatusDetails rows={view.statusRows} />
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw />}
          loading={view.busyAction === "check"}
          disabled={view.switchDisabled}
          onClick={() => void controller.recheck()}
        >
          {t("Recheck")}
        </Button>
      </section>

      <DesktopComputerUsePreference sectionTitle="Control preview" />

      <LockedComputerControlSection controller={controller} />

      <section className="computer-control-section" aria-labelledby="computer-control-advanced-title">
        <SectionHeader icon={<Cpu />} title={t("Advanced details")} id="computer-control-advanced-title" />
        <dl className="computer-control-advanced-grid">
          <Detail label={t("Version")} value={view.displayVersion ?? t("Unknown")} />
          <Detail label={t("Platform")} value={view.platform ? t(platformLabel(view.platform)) : t("Unknown")} />
          <Detail label={t("Integrity")} value={t(integrityLabel(view.integrity))} />
          <Detail label={t("Last checked")} value={view.lastCheckedAt ? formatCheckedAt(view.lastCheckedAt) : t("Unknown")} />
          {view.distributionRevision ? <Detail label={t("Ling distribution")} value={view.distributionRevision} /> : null}
        </dl>
        {view.limitations.length > 0 ? (
          <div className="computer-control-limitations">
            <strong>{t("Current limitations")}</strong>
            <div>{view.limitations.map((limitation) => <Badge key={limitation} tone="warning" variant="outline">{t(limitationLabel(limitation))}</Badge>)}</div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PageHeader(): JSX.Element {
  const { t } = useI18n();
  return (
    <header className="computer-control-page-header">
      <span className="computer-control-page-icon"><MonitorCog aria-hidden="true" /></span>
      <span><h1>{t("Computer Control")}</h1><p>{t("Let Ling operate your computer only when you ask it to.")}</p></span>
    </header>
  );
}

function SectionHeader({ icon, id, title }: { readonly icon: JSX.Element; readonly id: string; readonly title: string }): JSX.Element {
  return <header className="computer-control-section-header"><span aria-hidden="true">{icon}</span><h2 id={id}>{title}</h2></header>;
}

function PrimaryAction({ action, busy, controller }: { readonly action: ComputerControlPrimaryAction; readonly busy: boolean; readonly controller: ComputerControlController }): JSX.Element | null {
  const { t } = useI18n();
  if (action.kind === "none") return null;
  const run = (): void => {
    if (action.kind === "retry") void controller.recheck();
    else if (action.kind === "request_permissions") void controller.requestPermissions();
    else if (action.kind === "open_permission_settings") void controller.openPermissionSettings(action.permission);
  };
  const disabled = action.kind === "update_ling" || action.kind === "reinstall_ling";
  return (
    <Button variant="primary" leadingIcon={action.kind === "request_permissions" ? <ShieldCheck /> : <RefreshCw />} loading={busy} disabled={disabled} onClick={run}>
      {t(primaryActionLabel(action))}
    </Button>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ComputerControlLoading(): JSX.Element {
  return <div className="computer-control-settings" aria-busy="true"><PageHeader /><section className="computer-control-section computer-control-loading"><Skeleton width="12rem" /><Skeleton width="100%" height={80} /><Skeleton width="70%" /></section></div>;
}

function phasePresentation(phase: Extract<ReturnType<typeof import("../../../domains/computer-control/computer-control-view-model.js").buildComputerControlViewModel>, { kind: "bundled" }>["phase"]) {
  const values = {
    off: ["Off", "Computer Control is included but currently off.", "Off", "neutral"],
    starting: ["Starting", "Ling is preparing the bundled computer-control runtime.", "Starting", "info"],
    waiting_desktop: ["Waiting for Desktop", "Keep Ling Desktop open, then recheck.", "Waiting", "warning"],
    waiting_permission: ["Permission required", "Grant Accessibility and Screen Recording explicitly.", "Needs access", "warning"],
    waiting_session: ["Interactive session required", "Unlock the computer and return to the desktop.", "Locked", "warning"],
    repair: ["Needs attention", "A platform readiness check did not pass.", "Needs attention", "warning"],
    ready: ["Ready", "Ling can use approved computer-control tools.", "Ready", "success"],
    incompatible: ["Update required", "This bundled Driver is incompatible with the current Ling build.", "Incompatible", "danger"],
    corrupt: ["Repair required", "The bundled Driver failed package integrity verification.", "Corrupt", "danger"],
  } as const;
  const [title, description, badge, tone] = values[phase];
  return { title, description, badge, tone };
}

function primaryActionLabel(action: Exclude<ComputerControlPrimaryAction, { kind: "none" }>): string {
  if (action.kind === "retry") return "Retry";
  if (action.kind === "request_permissions") return "Grant access";
  if (action.kind === "open_permission_settings") return "Open System Settings";
  if (action.kind === "update_ling") return "Update Ling";
  return "Reinstall Ling";
}

function errorCopy(error: "load_failed" | "plugin_missing" | "projection_invalid"): string {
  if (error === "load_failed") return "The latest Computer Control state could not be refreshed.";
  if (error === "plugin_missing") return "The bundled Computer Control capability is missing from the daemon catalog.";
  return "The Computer Control state is incomplete or invalid. Ling will keep control unavailable.";
}

function platformLabel(platform: "darwin" | "win32" | "unsupported"): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Unsupported";
}

function integrityLabel(integrity: "verified" | "failed" | "unknown"): string {
  return integrity === "verified" ? "Verified" : integrity === "failed" ? "Failed" : "Unknown";
}

function limitationLabel(limitation: "elevated_pixel_input" | "uwp_send_input"): string {
  return limitation === "elevated_pixel_input" ? "Elevated app pixel input" : "UWP SendInput";
}

function formatCheckedAt(value: string): string {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toLocaleString() : value;
}
