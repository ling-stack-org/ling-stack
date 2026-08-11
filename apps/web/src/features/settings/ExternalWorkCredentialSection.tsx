import { KeyRound, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  DataRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
  Field,
  InlineFeedback,
  Input,
  InspectorSection,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { ExternalWorkStatusResponse } from "../../types.js";
import { ExternalWorkDetailList } from "./ExternalWorkDetailList.js";
import {
  canConfigureExternalWorkCredential,
  canRemoveExternalWorkCredential,
  externalWorkCredentialState,
  externalWorkSourceLabel,
} from "./external-work-settings-view-models.js";

export function ExternalWorkCredentialSection({
  action,
  errorMessage,
  onConfigure,
  onDelete,
  status,
}: {
  readonly action: "configure" | "delete" | undefined;
  readonly errorMessage?: string;
  readonly onConfigure: (token: string) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
  readonly status: ExternalWorkStatusResponse;
}): React.JSX.Element {
  const { t } = useI18n();
  const presentation = externalWorkCredentialState(status);
  const canConfigure = canConfigureExternalWorkCredential(status);
  const canRemove = canRemoveExternalWorkCredential(status);
  const source = externalWorkSourceLabel(status);
  const secretRef = status.secret.ref ?? status.workflow.secretRef;
  const needsCredential = status.secret.status === "missing"
    || status.secret.status === "invalid"
    || status.secret.status === "unavailable";
  const [editing, setEditing] = useState(needsCredential && canConfigure);
  const [token, setToken] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const deleting = action === "delete";
  const configuring = action === "configure";

  useEffect(() => {
    if (needsCredential && canConfigure) setEditing(true);
  }, [canConfigure, needsCredential]);

  const saveCredential = async (): Promise<void> => {
    const submitted = token;
    setToken("");
    const saved = await onConfigure(submitted);
    if (saved) setEditing(false);
  };

  const removeCredential = async (): Promise<void> => {
    const removed = await onDelete();
    if (removed) setDeleteOpen(false);
  };

  return (
    <Dialog
      busy={deleting}
      dismissible
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
    >
      <section className="settings-external-work-section" aria-labelledby="settings-external-work-credential-title">
        <h2 id="settings-external-work-credential-title">{t("Credential")}</h2>
        <DataRow
          className="settings-external-work-row"
          identity={(
            <span className="settings-external-work-identity">
              <KeyRound aria-hidden="true" />
              <span>
                <strong>{t("External token")}</strong>
                <small>{credentialSummary(status.secret.status, t)}</small>
              </span>
            </span>
          )}
          status={<StatusIndicator compact label={t(presentation.label)} tone={presentation.tone} />}
          actions={canConfigure || canRemove ? (
            <span className="settings-external-work-row-actions">
              {canConfigure && !editing ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  {t("Update token")}
                </Button>
              ) : null}
              {canRemove ? (
                <DialogTrigger asChild>
                  <Button size="sm" variant="danger" leadingIcon={<Trash2 />}>
                    {t("Remove token")}
                  </Button>
                </DialogTrigger>
              ) : null}
            </span>
          ) : undefined}
        />

        {needsCredential ? (
          <InlineFeedback tone={status.secret.status === "missing" ? "warning" : "danger"}>
            {credentialRepairMessage(status.secret.status, t)}
          </InlineFeedback>
        ) : null}
        {errorMessage && !deleteOpen ? (
          <InlineFeedback tone="danger">
            {t("The external token could not be saved. Review details and try again.")}
          </InlineFeedback>
        ) : null}

        {editing && canConfigure ? (
          <div className="settings-external-work-form settings-external-work-credential-form">
            <Field label={t("Token")}>
              <Input
                type="password"
                autoComplete="off"
                value={token}
                disabled={configuring}
                placeholder={t(`Paste ${source} token`)}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
            <Button
              className="settings-external-work-form-action"
              disabled={!token.trim()}
              leadingIcon={<KeyRound />}
              loading={configuring}
              loadingLabel={t("Saving token")}
              onClick={() => void saveCredential()}
            >
              {t(`Save ${source} token`)}
            </Button>
            {status.secret.status === "configured" ? (
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setToken(""); }}>
                {t("Cancel")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <InspectorSection
          className="settings-external-work-details"
          title={t("Credential details")}
          summary={t(presentation.label)}
        >
          <ExternalWorkDetailList
            items={[
              { label: t("Provider"), value: t(source) },
              { label: t("Storage reference"), value: secretRef ?? t("Not configured") },
              { label: t("Status"), value: t(presentation.label) },
              ...(status.secret.message ? [{ label: t("Provider detail"), value: status.secret.message }] : []),
              ...(errorMessage ? [{ label: t("Last operation error"), value: errorMessage }] : []),
            ]}
          />
        </InspectorSection>

        <DialogContent
          size="sm"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelDeleteRef.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader
            closeLabel={t("Close")}
            title={t("Remove external token?")}
            description={t("Polling and background work may stop until a new token is saved. The stored token cannot be recovered.")}
          />
          <DialogBody>
            {errorMessage ? (
              <>
                <InlineFeedback tone="danger">
                  {t("The external token could not be removed. Review details and try again.")}
                </InlineFeedback>
                <InspectorSection title={t("Error details")} summary={t("Needs attention")}>
                  <ExternalWorkDetailList
                    items={[{ label: t("Last operation error"), value: errorMessage }]}
                  />
                </InspectorSection>
              </>
            ) : (
              <InlineFeedback tone="warning">
                {t("This permanently removes the Keychain token used by the selected channel.")}
              </InlineFeedback>
            )}
          </DialogBody>
          <DialogFooter>
            <Button ref={cancelDeleteRef} disabled={deleting} variant="ghost" onClick={() => setDeleteOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              leadingIcon={<Trash2 />}
              loading={deleting}
              loadingLabel={t("Removing token")}
              onClick={() => void removeCredential()}
            >
              {t("Remove token")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </section>
    </Dialog>
  );
}

function credentialSummary(
  status: ExternalWorkStatusResponse["secret"]["status"],
  t: (key: string) => string,
): string {
  if (status === "configured") return t("Stored securely. Ling never displays the token value.");
  if (status === "not_required") return t("No credential is required for the current workflow.");
  if (status === "unavailable") return t("Secure credential storage is unavailable.");
  return t("Add a token before polling external work.");
}

function credentialRepairMessage(
  status: ExternalWorkStatusResponse["secret"]["status"],
  t: (key: string) => string,
): string {
  if (status === "unavailable") return t("Secure credential storage is unavailable. Review details before retrying.");
  if (status === "invalid") return t("The saved credential needs attention. Save a new token to continue.");
  return t("Save a token to enable polling and background work.");
}
