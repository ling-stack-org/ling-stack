import { PackagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
  Select,
  Textarea,
} from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginCreateRequest, ManagedPluginView } from "../../types.js";

type TransportChoice = "stdio" | "streamable-http";
type FieldId = "displayName" | "description" | "command" | "url";

export function PluginCreateDialog({
  open,
  busy,
  onCreate,
  onClose,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly onCreate: (input: ManagedPluginCreateRequest) => Promise<ManagedPluginView | undefined>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [transportType, setTransportType] = useState<TransportChoice>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldId, string>>>({});
  const [submitError, setSubmitError] = useState("");
  const refs = {
    displayName: useRef<HTMLInputElement>(null),
    description: useRef<HTMLTextAreaElement>(null),
    command: useRef<HTMLInputElement>(null),
    url: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    if (!open) return;
    setDisplayName("");
    setDescription("");
    setTransportType("stdio");
    setCommand("");
    setArgsText("");
    setUrl("");
    setErrors({});
    setSubmitError("");
  }, [open]);

  async function submit(): Promise<void> {
    const nextErrors: Partial<Record<FieldId, string>> = {};
    if (!displayName.trim()) nextErrors.displayName = t("Plugin name is required.");
    else if (!description.trim()) nextErrors.description = t("Plugin description is required.");
    else if (transportType === "stdio" && !command.trim()) nextErrors.command = t("Plugin command is required.");
    else if (transportType === "streamable-http" && !url.trim()) nextErrors.url = t("Plugin endpoint URL is required.");
    setErrors(nextErrors);
    setSubmitError("");
    const firstInvalid = (["displayName", "description", "command", "url"] as const).find((field) => nextErrors[field]);
    if (firstInvalid) {
      refs[firstInvalid].current?.focus();
      return;
    }
    const transport: ManagedPluginCreateRequest["transport"] = transportType === "stdio"
      ? {
          type: "stdio",
          command: command.trim(),
          args: argsText.split("\n").map((value) => value.trim()).filter(Boolean),
          env: {},
          secretEnvRefs: {},
        }
      : {
          type: "streamable-http",
          url: url.trim(),
          headers: {},
          secretHeaderRefs: {},
        };
    const plugin = await onCreate({
      displayName: displayName.trim(),
      description: description.trim(),
      transport,
    });
    if (plugin) onClose();
    else setSubmitError(t("Unknown error"));
  }

  return (
    <Dialog busy={busy} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} open={open}>
      <DialogContent asChild className="plugin-create-dialog plugin-create-panel" size="md">
        <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader closeLabel={t("Close")} title={t("Add plugin")} />
          <DialogBody className="plugin-create-body">
            <Field error={fieldError(errors.displayName)} label={t("Plugin name")} required>
              <Input
                ref={refs.displayName}
                autoFocus
                maxLength={80}
                onChange={(event) => setDisplayName(event.target.value)}
                value={displayName}
              />
            </Field>
            <Field error={fieldError(errors.description)} label={t("Plugin description")} required>
              <Textarea
                ref={refs.description}
                maxLength={180}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                value={description}
              />
            </Field>
            <Field label={t("Connection type")}>
              <Select onChange={(event) => setTransportType(event.target.value as TransportChoice)} value={transportType}>
                <option value="stdio">{t("Local command")}</option>
                <option value="streamable-http">{t("HTTP endpoint")}</option>
              </Select>
            </Field>
            {transportType === "stdio" ? (
              <>
                <Field error={fieldError(errors.command)} label={t("Command")} required>
                  <Input ref={refs.command} onChange={(event) => setCommand(event.target.value)} value={command} />
                </Field>
                <Field label={t("Arguments (one per line)")}>
                  <Textarea onChange={(event) => setArgsText(event.target.value)} rows={4} value={argsText} />
                </Field>
              </>
            ) : (
              <Field error={fieldError(errors.url)} label={t("Endpoint URL")} required>
                <Input ref={refs.url} onChange={(event) => setUrl(event.target.value)} value={url} />
              </Field>
            )}
            {submitError ? <InlineFeedback tone="danger">{submitError}</InlineFeedback> : null}
          </DialogBody>
          <DialogFooter>
            <Button disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
            <Button
              leadingIcon={<PackagePlus aria-hidden="true" />}
              loading={busy}
              loadingLabel={t("Loading")}
              type="submit"
              variant="primary"
            >
              {t("Add plugin")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function fieldError(message: string | undefined): JSX.Element | undefined {
  return message ? <span role="alert">{message}</span> : undefined;
}
