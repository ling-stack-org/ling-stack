import type { ExecutionEngineProfileConfiguration } from "@ling-stack/contracts";
import { RotateCcw, Save } from "lucide-react";
import { useId, useState, type RefObject } from "react";
import { useI18n } from "../../../i18n.js";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, Field, Input, SegmentedControl, SegmentedControlItem } from "../../../shared/ui/index.js";
import { EngineManagementError } from "./EngineManagementError.js";
import type { EngineProfileEditor } from "./execution-engine-manager.js";
import { EngineAuthenticationFields } from "./EngineAuthenticationFields.js";
import { EngineSetupGuide } from "./EngineSetupGuide.js";

export function EngineProfileDialog({ editor, name, busy, returnFocusRef, onChange, onAuthenticationMode, onSave, onCancel, onReload }: {
  readonly editor: EngineProfileEditor;
  readonly name: string;
  readonly busy: boolean;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly onChange: (patch: Partial<Omit<ExecutionEngineProfileConfiguration, "engineId">>) => void;
  readonly onAuthenticationMode: (mode: "account" | "apiKey") => void;
  readonly onSave: (secret?: string) => Promise<boolean>;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const formId = useId();
  const [secretRetry, setSecretRetry] = useState(false);
  const draft = editor.draft;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }} busy={busy}>
      <DialogContent size="md" aria-describedby={undefined} onCloseAutoFocus={(event) => {
        event.preventDefault();
        returnFocusRef.current?.focus({ preventScroll: true });
      }}>
        <DialogHeader title={name} closeLabel={t("Close")} />
        <DialogBody>
          <form id={formId} className="engine-profile-form" onSubmit={(event) => {
            event.preventDefault();
            const field = event.currentTarget.elements.namedItem("engine-secret");
            const secret = field instanceof HTMLInputElement && field.value ? field.value : undefined;
            if (field instanceof HTMLInputElement) field.value = "";
            setSecretRetry(Boolean(secret));
            void onSave(secret).then((saved) => { if (saved) setSecretRetry(false); });
          }}>
            <fieldset className="engine-profile-fields" disabled={busy}>
              <Field label={t("Executable path")} required>
                <Input required autoComplete="off" spellCheck={false} value={draft.executablePath} maxLength={4096}
                  onChange={(event) => onChange({ executablePath: event.target.value })} />
              </Field>
              <div><EngineSetupGuide engineId={draft.engineId} /></div>
              <EngineAuthenticationFields draft={draft} busy={busy} retry={secretRetry} onChange={onChange}
                onMode={(mode) => { setSecretRetry(false); onAuthenticationMode(mode); }} />
              {draft.engineId === "kimi-acp" && draft.secretRef === undefined ? <Field label={t("Account region")}>
                <SegmentedControl className="engine-profile-region" aria-label={t("Account region")} value={draft.kimiLoginRegion ?? ""} onValueChange={(value) => {
                  if (value === "mainland-cn" || value === "global") onChange({ kimiLoginRegion: value });
                }}>
                  <SegmentedControlItem value="mainland-cn" disabled={busy}>{t("Mainland China")}</SegmentedControlItem>
                  <SegmentedControlItem value="global" disabled={busy}>{t("International")}</SegmentedControlItem>
                </SegmentedControl>
              </Field> : null}
              {draft.engineId === "openclaw-acp" ? <>
                <Field label={t("Gateway")} required>
                  <Input required type="url" autoComplete="off" spellCheck={false} value={draft.openclaw?.gatewayUrl ?? ""}
                    onChange={(event) => onChange({ openclaw: { agentId: "", ...draft.openclaw, gatewayUrl: event.target.value } })} />
                </Field>
                <Field label={t("Agent")} required>
                  <Input required autoComplete="off" spellCheck={false} value={draft.openclaw?.agentId ?? ""}
                    onChange={(event) => onChange({ openclaw: { gatewayUrl: "", ...draft.openclaw, agentId: event.target.value } })} />
                </Field>
              </> : null}
            </fieldset>
            {editor.error ? <div className="engine-profile-error"><EngineManagementError code={editor.error} /></div> : null}
          </form>
        </DialogBody>
        <DialogFooter className="engine-profile-footer">
            {editor.error === "profile_revision_conflict" ? <Button disabled={busy} leadingIcon={<RotateCcw />} onClick={onReload}>{t("Reload latest version")}</Button> : null}
            <div className="engine-profile-footer-actions">
              <Button disabled={busy} onClick={onCancel}>{t("Cancel")}</Button>
              <Button type="submit" form={formId} variant="primary" leadingIcon={<Save />} loading={busy} loadingLabel={t("Loading")}>{t("Save")}</Button>
            </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
