import { KeyRound, Plus, Save, Server, SlidersHorizontal, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useI18n } from "../../i18n.js";
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
  InspectorSection,
  Select,
  Switch,
} from "../../shared/ui/index.js";
import type { McpServer, McpServerFormState } from "../../types.js";
import {
  changeMcpFormTransport,
  defaultMcpServerForm,
  hasMcpServerFormErrors,
  mcpFormHasAuthentication,
  mcpServerToForm,
  validateMcpServerForm,
  type McpServerFormErrors,
} from "./mcp-settings-view-models.js";

export function McpServerEditorDialog({
  busy,
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  server,
}: {
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (form: McpServerFormState) => Promise<string | undefined>;
  readonly open: boolean;
  readonly returnFocusRef: MutableRefObject<HTMLButtonElement | null>;
  readonly server?: McpServer;
}): React.JSX.Element {
  const { t } = useI18n();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<McpServerFormState>(defaultMcpServerForm);
  const [errors, setErrors] = useState<McpServerFormErrors>({});
  const [saveError, setSaveError] = useState("");
  const [authenticationOpen, setAuthenticationOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const editing = Boolean(server);

  const updateField = <Key extends keyof McpServerFormState>(
    key: Key,
    value: McpServerFormState[Key],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => clearMcpFormFieldError(current, key));
    setSaveError("");
  };

  useEffect(() => {
    if (!open) return;
    const next = server ? mcpServerToForm(server) : defaultMcpServerForm;
    setForm(next);
    setErrors({});
    setSaveError("");
    setAuthenticationOpen(mcpFormHasAuthentication(next));
    setAdvancedOpen(false);
  }, [open, server]);

  const save = async (): Promise<void> => {
    const nextErrors = validateMcpServerForm(form);
    setErrors(nextErrors);
    setSaveError("");
    if (nextErrors.envName || nextErrors.envSecretRef || nextErrors.headerName || nextErrors.headerSecretRef) {
      setAuthenticationOpen(true);
    }
    if (nextErrors.startupTimeoutSec || nextErrors.toolTimeoutSec) setAdvancedOpen(true);
    if (hasMcpServerFormErrors(nextErrors)) return;

    const error = await onSubmit(form);
    if (error) {
      setSaveError(error);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      busy={busy}
      dismissible
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="settings-mcp-editor"
        size="lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameInputRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t(editing ? "Edit MCP server" : "Add MCP server")}
          description={t("Configure one workspace-level tool server. Technical and credential details stay folded until needed.")}
        />
        <DialogBody className="settings-mcp-editor-body">
          {errors.form ? (
            <InlineFeedback tone="warning">{t(errors.form)}</InlineFeedback>
          ) : null}
          {saveError ? (
            <InlineFeedback tone="danger" title={t("Server could not be saved")}>
              {saveError}
            </InlineFeedback>
          ) : null}

          <section className="settings-mcp-form-section" aria-labelledby="settings-mcp-basic-title">
            <h3 id="settings-mcp-basic-title"><Server aria-hidden="true" />{t("Basic information")}</h3>
            <div className="settings-mcp-form-grid">
              <Field label={t("Server name")} error={errors.displayName ? t(errors.displayName) : undefined}>
                <Input
                  ref={nameInputRef}
                  value={form.displayName}
                  disabled={busy}
                  placeholder={t("GitHub MCP")}
                  onChange={(event) => updateField("displayName", event.target.value)}
                />
              </Field>
              {!editing ? (
                <Field
                  label={t("Server id")}
                  description={t("Optional. Ling generates an id when this is empty.")}
                >
                  <Input
                    value={form.serverId}
                    disabled={busy}
                    placeholder="github"
                    onChange={(event) => updateField("serverId", event.target.value)}
                  />
                </Field>
              ) : null}
              <Field label={t("Transport")}>
                <Select
                  value={form.transportType}
                  disabled={busy}
                  onChange={(event) => {
                    setForm(changeMcpFormTransport(form, event.target.value as McpServerFormState["transportType"]));
                    setErrors({});
                    setSaveError("");
                    setAuthenticationOpen(false);
                  }}
                >
                  <option value="streamable-http">HTTP</option>
                  <option value="stdio">stdio</option>
                </Select>
              </Field>
              <div className="settings-mcp-switch-row">
                <span>
                  <strong>{t("Enable server")}</strong>
                  <small>{t("Enabled servers are available for explicit teammate assignment.")}</small>
                </span>
                <Switch
                  aria-label={t("Enable server")}
                  checked={form.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => updateField("enabled", enabled)}
                />
              </div>
            </div>
          </section>

          <section className="settings-mcp-form-section" aria-labelledby="settings-mcp-connection-title">
            <h3 id="settings-mcp-connection-title"><Wrench aria-hidden="true" />{t("Connection")}</h3>
            <div className="settings-mcp-form-grid">
              {form.transportType === "stdio" ? (
                <>
                  <Field label={t("Command")} error={errors.command ? t(errors.command) : undefined}>
                    <Input
                      value={form.command}
                      disabled={busy}
                      placeholder="npx"
                      onChange={(event) => updateField("command", event.target.value)}
                    />
                  </Field>
                  <Field label={t("Arguments")} error={errors.argsText ? t(errors.argsText) : undefined}>
                    <Input
                      value={form.argsText}
                      disabled={busy}
                      placeholder="-y @modelcontextprotocol/server-filesystem ."
                      onChange={(event) => updateField("argsText", event.target.value)}
                    />
                  </Field>
                  <Field className="settings-mcp-field-wide" label={t("Working directory")}>
                    <Input
                      value={form.cwd}
                      disabled={busy}
                      placeholder={t("Optional")}
                      onChange={(event) => updateField("cwd", event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Field className="settings-mcp-field-wide" label={t("Server URL")} error={errors.url ? t(errors.url) : undefined}>
                  <Input
                    value={form.url}
                    disabled={busy}
                    inputMode="url"
                    placeholder="https://example.com/mcp"
                    onChange={(event) => updateField("url", event.target.value)}
                  />
                </Field>
              )}
            </div>
          </section>

          <InspectorSection
            className="settings-mcp-form-inspector"
            open={authenticationOpen}
            title={t("Authentication")}
            summary={t(mcpFormHasAuthentication(form) ? "Secret references configured" : "No authentication configured")}
            onToggle={(event) => setAuthenticationOpen(event.currentTarget.open)}
          >
            <div className="settings-mcp-form-grid">
              {form.transportType === "stdio" ? (
                <>
                  <Field label={t("Env secret name")} error={errors.envName ? t(errors.envName) : undefined}>
                    <Input
                      value={form.envName}
                      autoComplete="off"
                      disabled={busy}
                      placeholder="GITHUB_TOKEN"
                      spellCheck={false}
                      onChange={(event) => updateField("envName", event.target.value)}
                    />
                  </Field>
                  <Field label={t("Env secret ref")} error={errors.envSecretRef ? t(errors.envSecretRef) : undefined}>
                    <Input
                      value={form.envSecretRef}
                      autoComplete="off"
                      disabled={busy}
                      placeholder="env:GITHUB_TOKEN"
                      spellCheck={false}
                      onChange={(event) => updateField("envSecretRef", event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label={t("Header secret name")} error={errors.headerName ? t(errors.headerName) : undefined}>
                    <Input
                      value={form.headerName}
                      autoComplete="off"
                      disabled={busy}
                      placeholder="Authorization"
                      spellCheck={false}
                      onChange={(event) => updateField("headerName", event.target.value)}
                    />
                  </Field>
                  <Field label={t("Header secret ref")} error={errors.headerSecretRef ? t(errors.headerSecretRef) : undefined}>
                    <Input
                      value={form.headerSecretRef}
                      autoComplete="off"
                      disabled={busy}
                      placeholder="env:MCP_AUTHORIZATION"
                      spellCheck={false}
                      onChange={(event) => updateField("headerSecretRef", event.target.value)}
                    />
                  </Field>
                  <Field className="settings-mcp-field-wide" label={t("Bearer token ref")}>
                    <Input
                      value={form.bearerTokenRef}
                      autoComplete="off"
                      disabled={busy}
                      placeholder={t("Optional")}
                      spellCheck={false}
                      onChange={(event) => updateField("bearerTokenRef", event.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>
          </InspectorSection>

          <InspectorSection
            className="settings-mcp-form-inspector"
            open={advancedOpen}
            title={t("Advanced settings")}
            summary={t("Timeouts and execution policy")}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <div className="settings-mcp-form-grid">
              <Field label={t("Startup timeout")} error={errors.startupTimeoutSec ? t(errors.startupTimeoutSec) : undefined}>
                <Input
                  value={form.startupTimeoutSec}
                  disabled={busy}
                  inputMode="numeric"
                  suffix={t("seconds")}
                  onChange={(event) => updateField("startupTimeoutSec", event.target.value)}
                />
              </Field>
              <Field label={t("Tool timeout")} error={errors.toolTimeoutSec ? t(errors.toolTimeoutSec) : undefined}>
                <Input
                  value={form.toolTimeoutSec}
                  disabled={busy}
                  inputMode="numeric"
                  suffix={t("seconds")}
                  onChange={(event) => updateField("toolTimeoutSec", event.target.value)}
                />
              </Field>
              <div className="settings-mcp-switch-row settings-mcp-field-wide">
                <span>
                  <strong><SlidersHorizontal aria-hidden="true" />{t("Critical dependency")}</strong>
                  <small>{t("When enabled, assigned teammates stop running if this service is unavailable, so they do not continue without critical tools.")}</small>
                </span>
                <Switch
                  aria-label={t("Critical dependency")}
                  checked={form.required}
                  disabled={busy}
                  onCheckedChange={(required) => updateField("required", required)}
                />
              </div>
            </div>
          </InspectorSection>

          <InlineFeedback className="settings-mcp-secret-note" tone="neutral">
            <KeyRound aria-hidden="true" />
            <span>{t("MCP secrets are stored as refs and never read back into this form.")}</span>
          </InlineFeedback>
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={editing ? <Save /> : <Plus />}
            loading={busy}
            loadingLabel={t(editing ? "Saving changes" : "Adding server")}
            onClick={() => void save()}
          >
            {t(editing ? "Save changes" : "Add server")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function clearMcpFormFieldError(
  errors: McpServerFormErrors,
  field: keyof McpServerFormState,
): McpServerFormErrors {
  const next: Record<string, string | undefined> = { ...errors };
  delete next[field];
  if (!Object.entries(next).some(([key, value]) => key !== "form" && Boolean(value))) delete next.form;
  return next as McpServerFormErrors;
}
