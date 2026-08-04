import type {
  DesktopMobileAccessPairingStartResult,
  DesktopMobileAccessStatus,
} from "../../../../../desktop/shared/desktop-capabilities.js";
import { QrCode, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import { useI18n } from "../../../i18n.js";
import { Badge, Button, Field, InlineFeedback, Input, Skeleton } from "../../../shared/ui/index.js";

type BusyAction = "enable" | "disable" | "pair" | "confirm" | "reject" | "revoke" | "refresh";

export function MobileAccessSettingsPage(): JSX.Element {
  const { t } = useI18n();
  const capability = window.lingDesktop?.mobileAccess;
  const [status, setStatus] = useState<DesktopMobileAccessStatus>();
  const [pairing, setPairing] = useState<DesktopMobileAccessPairingStartResult>();
  const [qrDataUrl, setQrDataUrl] = useState<string>();
  const [gatewayOrigin, setGatewayOrigin] = useState("");
  const [busy, setBusy] = useState<BusyAction>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (!capability) {
      setError(t("Mobile Access is available in Ling Desktop only."));
      return;
    }
    if (!quiet) setBusy("refresh");
    try {
      const next = await capability.status();
      setStatus(next);
      if (next.gatewayOrigin) setGatewayOrigin(next.gatewayOrigin);
      setError(undefined);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : t("Mobile Access could not be loaded."));
    } finally {
      if (!quiet) setBusy(undefined);
    }
  }, [capability, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.enabled || status.pairing.state === "idle" || status.pairedDevice) return;
    const timer = setInterval(() => void refresh(true), 1_000);
    return () => clearInterval(timer);
  }, [status?.enabled, status?.pairing.state, status?.pairedDevice, refresh]);

  useEffect(() => {
    if (!pairing?.encodedQr) {
      setQrDataUrl(undefined);
      return;
    }
    void QRCode.toDataURL(pairing.encodedQr, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: { dark: "#121417", light: "#ffffff" },
    }).then(setQrDataUrl).catch(() => setError(t("The pairing QR code could not be rendered.")));
  }, [pairing?.encodedQr, t]);

  const run = async (action: BusyAction, operation: () => Promise<DesktopMobileAccessStatus | DesktopMobileAccessPairingStartResult>): Promise<void> => {
    setBusy(action);
    setError(undefined);
    try {
      const result = await operation();
      if ("encodedQr" in result) {
        setPairing(result);
        setStatus(result.status);
      } else {
        setStatus(result);
        if (result.pairing.state === "idle" || result.pairedDevice) setPairing(undefined);
      }
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : t("Mobile Access action failed."));
    } finally {
      setBusy(undefined);
    }
  };

  if (!status && !error) {
    return <div className="mobile-access-settings" aria-busy="true"><PageHeader /><section className="mobile-access-card"><Skeleton width="12rem" /><Skeleton width="100%" height={96} /></section></div>;
  }

  return (
    <div className="mobile-access-settings" data-mobile-access-state={statusState(status)}>
      <PageHeader />
      {error ? <InlineFeedback tone="danger" title={t("Mobile Access needs attention")}>{error}</InlineFeedback> : null}
      {!capability ? null : !status?.enabled ? (
        <section className="mobile-access-card" aria-labelledby="mobile-access-enable-title">
          <SectionHeader icon={<ShieldCheck />} id="mobile-access-enable-title" title={t("Enable secure remote conversations")} />
          <p>{t("Ling keeps the Gateway on this PC and exposes only the paired conversation channel through your HTTPS address.")}</p>
          <Field label={t("Remote HTTPS address")} description={t("Use the HTTPS address routed to this PC, for example Tailscale Serve.")}>
            <Input placeholder="https://my-mac.example.ts.net" value={gatewayOrigin} onChange={(event) => setGatewayOrigin(event.target.value)} />
          </Field>
          <Button variant="primary" loading={busy === "enable"} disabled={!isHttpsOrigin(gatewayOrigin)} onClick={() => void run("enable", () => capability.enable(gatewayOrigin.trim()))}>{t("Enable Mobile Access")}</Button>
        </section>
      ) : status.pairedDevice ? (
        <section className="mobile-access-card" aria-labelledby="mobile-access-paired-title">
          <div className="mobile-access-paired-heading">
            <SectionHeader icon={<Smartphone />} id="mobile-access-paired-title" title={status.pairedDevice.displayName} />
            <Badge tone="success">{t("Paired")}</Badge>
          </div>
          <dl className="mobile-access-details">
            <Detail label={t("Platform")} value={status.pairedDevice.platform === "ios" ? "iPhone" : "Android"} />
            <Detail label={t("Paired at")} value={formatDate(status.pairedDevice.pairedAt)} />
            <Detail label={t("Gateway")} value={status.gatewayOrigin ?? "—"} />
            <Detail label={t("Text replies")} value={status.sendEnabled ? t("Enabled") : t("Unavailable")} />
          </dl>
          <InlineFeedback tone="info">{t("Mobile can read and send plain conversation text only. Tools, workflows, approvals, and files remain on the PC.")}</InlineFeedback>
          <div className="mobile-access-actions">
            <Button variant="danger" loading={busy === "revoke"} onClick={() => void run("revoke", () => capability.revoke())}>{t("Revoke phone")}</Button>
            <Button variant="secondary" loading={busy === "disable"} onClick={() => void run("disable", () => capability.disable())}>{t("Disable Mobile Access")}</Button>
          </div>
        </section>
      ) : status.pairing.state === "awaiting_pc_confirmation" && status.pairing.pendingDevice ? (
        <section className="mobile-access-card" aria-labelledby="mobile-access-confirm-title">
          <SectionHeader icon={<Smartphone />} id="mobile-access-confirm-title" title={t("Confirm this phone")} />
          <p>{t("Confirm only if this is the phone currently showing the same Gateway fingerprint.")}</p>
          <div className="mobile-access-device-candidate">
            <strong>{status.pairing.pendingDevice.displayName}</strong>
            <span>{status.pairing.pendingDevice.platform === "ios" ? "iPhone" : "Android"}</span>
            <code>{shortFingerprint(status.pairing.pendingDevice.publicKeyFingerprint)}</code>
          </div>
          <div className="mobile-access-actions">
            <Button variant="primary" loading={busy === "confirm"} onClick={() => void run("confirm", () => capability.confirmPairing())}>{t("Confirm pairing")}</Button>
            <Button variant="danger" loading={busy === "reject"} onClick={() => void run("reject", () => capability.rejectPairing())}>{t("Reject")}</Button>
          </div>
        </section>
      ) : status.pairing.state === "waiting_for_phone" && pairing ? (
        <section className="mobile-access-card mobile-access-pairing-card" aria-labelledby="mobile-access-scan-title">
          <SectionHeader icon={<QrCode />} id="mobile-access-scan-title" title={t("Scan with Ling Mobile")} />
          <p>{t("On iPhone, open Ling Mobile and scan this one-time code. Final confirmation stays on this PC.")}</p>
          {qrDataUrl ? <img alt={t("Ling Mobile pairing QR code")} className="mobile-access-qr" src={qrDataUrl} /> : <Skeleton width={320} height={320} />}
          <code className="mobile-access-fingerprint">{shortFingerprint(status.gatewayIdentityFingerprint)}</code>
          <span className="mobile-access-expiry">{t("Expires at")} {formatDate(pairing.qr.expiresAt)}</span>
        </section>
      ) : (
        <section className="mobile-access-card" aria-labelledby="mobile-access-ready-title">
          <SectionHeader icon={<Smartphone />} id="mobile-access-ready-title" title={t("Pair an iPhone")} />
          <p>{t("Generate a fresh five-minute QR code, then confirm the phone on this PC.")}</p>
          <dl className="mobile-access-details"><Detail label={t("Gateway")} value={status.gatewayOrigin ?? "—"} /><Detail label={t("Listener")} value={status.listener.listening ? t("Running") : t("Stopped")} /></dl>
          <div className="mobile-access-actions">
            <Button variant="primary" loading={busy === "pair"} leadingIcon={<QrCode />} onClick={() => void run("pair", () => capability.startPairing())}>{t("Generate pairing code")}</Button>
            <Button variant="secondary" loading={busy === "refresh"} leadingIcon={<RefreshCw />} onClick={() => void refresh()}>{t("Check status")}</Button>
            <Button variant="secondary" loading={busy === "disable"} onClick={() => void run("disable", () => capability.disable())}>{t("Disable")}</Button>
          </div>
        </section>
      )}
    </div>
  );

  function PageHeader(): JSX.Element {
    return <header className="mobile-access-page-header"><span className="mobile-access-page-icon"><Smartphone aria-hidden="true" /></span><h1>{t("Mobile Access")}</h1></header>;
  }

  function SectionHeader({ icon, id, title }: { readonly icon: JSX.Element; readonly id: string; readonly title: string }): JSX.Element {
    return <header className="mobile-access-section-header"><span aria-hidden="true">{icon}</span><h2 id={id}>{title}</h2></header>;
  }
}

function Detail({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function statusState(status?: DesktopMobileAccessStatus): string {
  if (!status) return "error";
  if (!status.enabled) return "disabled";
  if (status.pairedDevice) return "paired";
  return status.pairing.state;
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.origin === value.trim();
  } catch {
    return false;
  }
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 8).toUpperCase()} · ${value.slice(-8).toUpperCase()}`;
}

function formatDate(value: string): string {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toLocaleString() : value;
}
