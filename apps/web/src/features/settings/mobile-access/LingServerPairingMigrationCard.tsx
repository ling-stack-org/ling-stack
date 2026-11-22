import {
  LING_SERVER_PAIRING_MIGRATION_MAX_RECEIPTS_V1,
  REMOTE_PROTOCOL_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type LingServerPairingMigrationPublicationRequestV1,
  type LingServerPairingMigrationRequestV1,
  type LingServerPairingMigrationV1,
} from "@ling-stack/contracts";
import { Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DesktopMobileAccessCapabilities } from "../../../../../desktop/shared/desktop-capabilities.js";
import { useI18n } from "../../../i18n.js";
import { Button, Field, InlineFeedback, Input, Textarea } from "../../../shared/ui/index.js";

type PendingMigration = Extract<LingServerPairingMigrationV1, { status: "pending" }>;

type MigrationStage =
  | { readonly kind: "draft" }
  | { readonly kind: "review"; readonly preview: PendingMigration }
  | { readonly kind: "export"; readonly publication: LingServerPairingMigrationPublicationRequestV1 };

interface MigrationDraft {
  readonly serverOrigin: string;
  readonly applicationKeyFingerprint: string;
  readonly bindingId: string;
  readonly installationId: string;
  readonly installationRevision: string;
  readonly retainedCommandIds: string;
}

export function LingServerPairingMigrationCard({ access, gatewayId, mobileDeviceId, workspaceBindingId, disabled }: {
  readonly access: Pick<DesktopMobileAccessCapabilities, "preparePairingMigration" | "confirmPairingMigration">;
  readonly gatewayId: string;
  readonly mobileDeviceId: string;
  readonly workspaceBindingId: string;
  readonly disabled: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<MigrationDraft>({
    serverOrigin: "", applicationKeyFingerprint: "", bindingId: "", installationId: "", installationRevision: "1", retainedCommandIds: "",
  });
  const [stage, setStage] = useState<MigrationStage>({ kind: "draft" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const request = readDraft(draft);

  useEffect(() => {
    if (stage.kind !== "draft") heading.current?.focus();
  }, [stage.kind]);

  function edit<K extends keyof MigrationDraft>(field: K, value: MigrationDraft[K]): void {
    setDraft(previous => ({ ...previous, [field]: value }));
    setError(undefined);
  }

  async function prepare(): Promise<void> {
    if (!request || busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const preview = await access.preparePairingMigration(request);
      if (preview.status !== "pending" || preview.oldPairing.gatewayId !== gatewayId
        || preview.oldPairing.mobileDeviceId !== mobileDeviceId || preview.oldPairing.workspaceBindingId !== workspaceBindingId) {
        throw new Error(t("The migration does not match the current pairing."));
      }
      setStage({ kind: "review", preview });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("The migration could not be prepared."));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(preview: PendingMigration): Promise<void> {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const { migrationId, confirmationDigest } = preview;
      const publication = await access.confirmPairingMigration({ migrationId, confirmationDigest });
      if (publication.confirmation.status !== "confirmed" || publication.confirmation.migrationId !== migrationId
        || publication.confirmation.confirmationDigest !== confirmationDigest) {
        throw new Error(t("The signed record does not match the migration preview."));
      }
      setStage({ kind: "export", publication });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("The migration could not be confirmed."));
    } finally {
      setBusy(false);
    }
  }

  async function copyMobileRecord(json: string): Promise<void> {
    setError(undefined);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
    } catch {
      setError(t("Copy failed. Select the signed record to copy it manually."));
    }
  }

  function editMigration(): void {
    setStage({ kind: "draft" });
    setError(undefined);
    setCopied(false);
  }

  const preview = stage.kind === "review" ? stage.preview : undefined;
  const publication = stage.kind === "export" ? stage.publication : undefined;
  const mobileRecord = publication ? JSON.stringify(publication.confirmation) : "";

  return <section className="mobile-access-card" aria-labelledby="ling-server-pairing-migration-title">
    <header className="mobile-access-section-header">
      <span aria-hidden="true"><Server /></span>
      <h2 id="ling-server-pairing-migration-title" ref={heading} tabIndex={-1}>{t("Ling Server pairing")}</h2>
    </header>
    {stage.kind === "draft" ? (
      <form className="mobile-access-migration-form" onSubmit={event => { event.preventDefault(); void prepare(); }}>
        <div className="mobile-access-migration-grid">
          <Field label={t("Ling Server HTTPS origin")} required>
            <Input maxLength={REMOTE_PROTOCOL_LIMITS.maxOriginBytes} placeholder="https://ling.example" value={draft.serverOrigin}
              disabled={disabled || busy} onChange={event => edit("serverOrigin", event.currentTarget.value)} />
          </Field>
          <Field label={t("Application key fingerprint")} description={t("Base64url SHA-256 fingerprint")} required>
            <Input maxLength={43} value={draft.applicationKeyFingerprint} disabled={disabled || busy}
              onChange={event => edit("applicationKeyFingerprint", event.currentTarget.value)} />
          </Field>
          <Field label={t("Installation ID")} required>
            <Input maxLength={REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes} value={draft.installationId} disabled={disabled || busy}
              onChange={event => edit("installationId", event.currentTarget.value)} />
          </Field>
          <Field label={t("Installation revision")} required>
            <Input inputMode="numeric" maxLength={16} value={draft.installationRevision} disabled={disabled || busy}
              onChange={event => edit("installationRevision", event.currentTarget.value)} />
          </Field>
          <Field label={t("Binding ID")} required>
            <Input maxLength={REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes} value={draft.bindingId} disabled={disabled || busy}
              onChange={event => edit("bindingId", event.currentTarget.value)} />
          </Field>
        </div>
        <Field label={t("Retained command IDs")} description={t("Optional. Enter one command ID per line.")}>
          <Textarea rows={2} value={draft.retainedCommandIds} disabled={disabled || busy}
            maxLength={LING_SERVER_PAIRING_MIGRATION_MAX_RECEIPTS_V1 * (REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes + 2)}
            onChange={event => edit("retainedCommandIds", event.currentTarget.value)} />
        </Field>
        <div className="mobile-access-actions">
          <Button type="submit" variant="primary" disabled={disabled || !request} loading={busy}>{t("Prepare migration")}</Button>
        </div>
      </form>
    ) : null}
    {preview ? <>
      <p>{t("Review the Ling Server identity and binding before signing.")}</p>
      <dl className="mobile-access-details">
        <Detail label={t("Ling Server HTTPS origin")} value={preview.routingProfile.serverOrigin} />
        <Detail label={t("Application key fingerprint")} value={preview.routingProfile.applicationKeyFingerprint} />
        <Detail label={t("Installation ID")} value={preview.routingProfile.installationId} />
        <Detail label={t("Installation revision")} value={String(preview.routingProfile.installationRevision)} />
        <Detail label={t("Binding ID")} value={preview.routingProfile.bindingId} />
        <Detail label={t("Expires at")} value={new Date(preview.expiresAt).toLocaleString()} />
        <Detail label={t("Retained command IDs")} value={preview.retainedReceipts.map(receipt => receipt.commandId).join(", ") || "—"} />
      </dl>
      <div className="mobile-access-actions">
        <Button variant="primary" disabled={disabled} loading={busy} onClick={() => void confirm(preview)}>{t("Confirm migration")}</Button>
        <Button variant="secondary" disabled={disabled || busy} onClick={editMigration}>{t("Edit migration")}</Button>
      </div>
    </> : null}
    {publication ? <>
      <p>{t("Publish the request on Ling Server, then paste the signed record into Ling Mobile.")}</p>
      <Field label={t("Signed record for Ling Mobile")}>
        <Textarea rows={4} readOnly value={mobileRecord} />
      </Field>
      <div className="mobile-access-actions">
        <Button variant="primary" onClick={() => void copyMobileRecord(mobileRecord)}>{t("Copy signed record")}</Button>
        <Button variant="secondary" onClick={() => downloadPublication(publication)}>{t("Download publication request")}</Button>
        <Button variant="secondary" disabled={disabled} onClick={editMigration}>{t("Edit migration")}</Button>
      </div>
      {copied ? <InlineFeedback tone="success">{t("Signed record copied.")}</InlineFeedback> : null}
    </> : null}
    {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
  </section>;
}

function Detail({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function readDraft(draft: MigrationDraft): LingServerPairingMigrationRequestV1 | undefined {
  const serverOrigin = draft.serverOrigin.trim().replace(/\/$/u, "");
  const applicationKeyFingerprint = draft.applicationKeyFingerprint.trim();
  const bindingId = draft.bindingId.trim();
  const installationId = draft.installationId.trim();
  const installationRevision = Number(draft.installationRevision);
  const retainedCommandIds = draft.retainedCommandIds.trim().split(/\s+/u).filter(Boolean);
  const url = URL.parse(serverOrigin);
  if (url?.protocol !== "https:" || url.origin !== serverOrigin || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(applicationKeyFingerprint)
    || !isIdentifier(bindingId) || !isIdentifier(installationId) || !/^[1-9][0-9]*$/u.test(draft.installationRevision)
    || !Number.isSafeInteger(installationRevision) || retainedCommandIds.length > LING_SERVER_PAIRING_MIGRATION_MAX_RECEIPTS_V1
    || new Set(retainedCommandIds).size !== retainedCommandIds.length || !retainedCommandIds.every(isIdentifier)) return undefined;

  return {
    routingProfile: {
      schemaVersion: 1, bindingId, installationId, installationRevision, serverOrigin,
      applicationKeyFingerprint, signalingProtocolMajor: 1, gatewayProtocolMajor: REMOTE_PROTOCOL_VERSION,
    },
    retainedCommandIds,
  };
}

function isIdentifier(value: string): boolean {
  return value.length <= REMOTE_PROTOCOL_LIMITS.maxIdentifierBytes && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function downloadPublication(publication: LingServerPairingMigrationPublicationRequestV1): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(publication, null, 2) + "\n"], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "ling-server-pairing-publication.json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
