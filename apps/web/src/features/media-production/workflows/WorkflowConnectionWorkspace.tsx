import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Plus, RefreshCw, Server, Trash2, X } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DataRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  IconButton,
  InlineFeedback,
  Input,
  Select,
  StatusIndicator,
} from "../../../shared/ui/index.js";
import type { CreateMediaWorkflowConnectionRequest, MediaWorkflowConnection } from "../../../types.js";
import type { MediaWorkflowControllerActions, MediaWorkflowControllerState, MediaWorkflowFailure } from "./media-workflow-types.js";
import {
  connectionStatusView,
  isMediaWorkflowBusy,
  isMediaWorkflowSubjectBusy,
  referencedWorkflowCount,
  selectMediaWorkflowFailure,
} from "./media-workflow-view-models.js";

interface ConnectionForm {
  readonly name: string;
  readonly baseUrl: string;
  readonly authMode: "none" | "bearer";
  readonly apiKey: string;
  readonly networkPolicy: "public_only" | "trusted_private_network";
  readonly protocolVariant: "auto" | "jobs_v1" | "prompt_legacy";
}

const emptyForm: ConnectionForm = {
  name: "",
  baseUrl: "http://127.0.0.1:8188",
  authMode: "none",
  apiKey: "",
  networkPolicy: "trusted_private_network",
  protocolVariant: "auto",
};

export function WorkflowConnectionWorkspace({ state, actions }: {
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
}): React.JSX.Element {
  const { t } = useI18n();
  const [creating, setCreating] = useState(state.connections.length === 0);
  const [deleteTarget, setDeleteTarget] = useState<{ readonly id: string; readonly trigger: HTMLElement | null }>();
  const selected = state.connections.find((item) => item.id === state.selectedConnectionId);
  const [form, setForm] = useState<ConnectionForm>(() => formFromConnection(selected));
  const referencedCount = useMemo(
    () => selected ? referencedWorkflowCount(state.workflows, selected.id) : 0,
    [selected, state.workflows],
  );

  useEffect(() => {
    if (!creating) setForm(formFromConnection(selected));
  }, [creating, selected?.id, selected?.updatedAt]);

  function selectConnection(connectionId: string): void {
    setCreating(false);
    actions.selectConnection(connectionId);
  }

  async function save(): Promise<void> {
    if (!form.name.trim() || !form.baseUrl.trim()) return;
    if (creating) {
      const outcome = await actions.createConnection(connectionRequest(form));
      if (outcome.ok) setCreating(false);
      return;
    }
    if (!selected) return;
    const outcome = await actions.updateConnection(selected.id, connectionRequest(form));
    if (outcome.ok) setForm((current) => ({ ...current, apiKey: "" }));
  }

  const formSubject = creating ? "new" : selected?.id ?? "";
  const formBusy = creating
    ? isMediaWorkflowBusy(state, "connection-create", "new")
    : Boolean(selected && isMediaWorkflowSubjectBusy(state, "connection", selected.id));
  const formFailure = creating
    ? selectMediaWorkflowFailure(state.failures, "connection-create", "new")
    : selected ? selectMediaWorkflowFailure(state.failures, "connection-update", selected.id) : undefined;

  return (
    <div className="media-workflow-split-view connection-workspace">
      <ConnectionList
        state={state}
        creating={creating}
        selected={selected}
        onCreate={() => { setCreating(true); setForm(emptyForm); }}
        onSelect={selectConnection}
      />
      <div className="media-workflow-detail-pane">
        <ConnectionHeader connection={selected} creating={creating} state={state} actions={actions} />
        <div className="media-workflow-connection-form">
          <Field label={t("Connection name")} required><Input value={form.name} disabled={formBusy} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label={t("ComfyUI address")} required><Input value={form.baseUrl} disabled={formBusy} placeholder="http://127.0.0.1:8188" onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></Field>
          <div className="media-workflow-form-row two-columns">
            <Field label={t("Authentication")}>
              <Select value={form.authMode} disabled={formBusy} onChange={(event) => setForm({ ...form, authMode: event.target.value as ConnectionForm["authMode"] })}>
                <option value="none">{t("No key")}</option><option value="bearer">{t("Bearer API Key")}</option>
              </Select>
            </Field>
            <Field label={t("API compatibility")}>
              <Select value={form.protocolVariant} disabled={formBusy} onChange={(event) => setForm({ ...form, protocolVariant: event.target.value as ConnectionForm["protocolVariant"] })}>
                <option value="auto">{t("Auto detect")}</option><option value="jobs_v1">{t("Jobs API")}</option><option value="prompt_legacy">{t("Prompt / History")}</option>
              </Select>
            </Field>
          </div>
          {form.authMode === "bearer" ? (
            <Field label={t("API Key")}>
              <Input type="password" value={form.apiKey} disabled={formBusy} placeholder={selected?.secretConfigured ? t("Configured; leave empty to keep it") : t("Enter API Key")} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
            </Field>
          ) : null}
          <Checkbox checked={form.networkPolicy === "trusted_private_network"} disabled={formBusy} label={t("Trust local or private-network addresses")} onChange={(event) => setForm({ ...form, networkPolicy: event.target.checked ? "trusted_private_network" : "public_only" })} />
          {selected?.health ? <ConnectionHealth connection={selected} /> : null}
          {formFailure ? <ConnectionFailure failure={formFailure} onClear={() => actions.clearFailure(creating ? "connection-create" : "connection-update", formSubject)} /> : null}
        </div>
        <div className="media-workflow-detail-actions">
          {!creating && selected ? (
            <div className="media-workflow-danger-action">
              <Button
                disabled={referencedCount > 0 || formBusy}
                leadingIcon={<Trash2 size={15} />}
                size="sm"
                title={referencedCount > 0 ? t("Used by {count} production workflows", { count: referencedCount }) : t("Delete connection")}
                variant="danger"
                onClick={(event) => setDeleteTarget({ id: selected.id, trigger: event.currentTarget })}
              >{t("Delete")}</Button>
              {referencedCount > 0 ? <span>{t("Used by {count} workflows", { count: referencedCount })}</span> : null}
            </div>
          ) : <span />}
          <Button loading={formBusy} loadingLabel={t("Saving connection")} variant="primary" disabled={!form.name.trim() || !form.baseUrl.trim()} onClick={() => void save()}>
            {creating ? t("Save connection") : t("Save changes")}
          </Button>
        </div>
      </div>
      {deleteTarget ? (
        <ConnectionDeleteDialog
          connection={state.connections.find((item) => item.id === deleteTarget.id)}
          state={state}
          actions={actions}
          trigger={deleteTarget.trigger}
          onClose={() => setDeleteTarget(undefined)}
        />
      ) : null}
    </div>
  );
}

function ConnectionList({ state, creating, selected, onCreate, onSelect }: {
  readonly state: MediaWorkflowControllerState;
  readonly creating: boolean;
  readonly selected?: MediaWorkflowConnection;
  readonly onCreate: () => void;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="media-workflow-list-pane">
      <div className="media-workflow-list-head"><div><strong>{t("ComfyUI connections")}</strong><span>{state.connections.length}</span></div><IconButton icon={Plus} label={t("New connection")} onClick={onCreate} /></div>
      <div className="media-workflow-list-scroll" role="listbox" aria-label={t("ComfyUI connections")}>
        {state.connections.map((connection) => {
          const status = connectionStatusView(connection);
          return <DataRow compact key={connection.id} selected={!creating && connection.id === selected?.id} identity={<><Server size={16} /><strong>{connection.name}</strong></>} summary={connection.baseUrl} status={<StatusIndicator compact label={t(status.label.key, status.label.values)} tone={status.tone} />} onClick={() => onSelect(connection.id)} />;
        })}
        {state.connections.length === 0 ? <EmptyState compact icon={<Server size={18} />} title={t("No connections")} description={t("Create a ComfyUI connection to import workflows.")} /> : null}
      </div>
    </div>
  );
}

function ConnectionHeader({ connection, creating, state, actions }: { readonly connection?: MediaWorkflowConnection; readonly creating: boolean; readonly state: MediaWorkflowControllerState; readonly actions: MediaWorkflowControllerActions }): React.JSX.Element {
  const { t } = useI18n();
  const checking = Boolean(connection && isMediaWorkflowBusy(state, "connection-check", connection.id));
  const subjectBusy = Boolean(connection && isMediaWorkflowSubjectBusy(state, "connection", connection.id));
  const failure = connection ? selectMediaWorkflowFailure(state.failures, "connection-check", connection.id) : undefined;
  return (
    <div className="media-workflow-detail-head"><div><span className="media-workflow-eyebrow">{creating ? t("New connection") : t("Connection settings")}</span><h3>{creating ? t("Connect ComfyUI") : connection?.name}</h3></div>
      {!creating && connection ? <Button disabled={subjectBusy} leadingIcon={<CheckCircle2 size={15} />} loading={checking} loadingLabel={t("Checking connection")} size="sm" variant="secondary" onClick={() => void actions.checkConnection(connection.id)}>{t("Check connection")}</Button> : null}
      {failure ? <ConnectionFailure failure={failure} onClear={() => actions.clearFailure("connection-check", connection?.id)} /> : null}
    </div>
  );
}

function ConnectionHealth({ connection }: { readonly connection: MediaWorkflowConnection }): React.JSX.Element {
  const { t } = useI18n();
  const status = connectionStatusView(connection);
  return <InlineFeedback title={t(connection.health?.ok ? "Connection is ready" : "Connection needs attention")} tone={connection.health?.ok ? "success" : "danger"}><StatusIndicator label={t(status.label.key, status.label.values)} tone={status.tone} /><Collapsible><CollapsibleTrigger asChild><Button size="sm" variant="ghost">{t("Technical details")}</Button></CollapsibleTrigger><CollapsibleContent><code>{connection.health?.message}</code></CollapsibleContent></Collapsible></InlineFeedback>;
}

function ConnectionFailure({ failure, onClear }: { readonly failure: MediaWorkflowFailure; readonly onClear: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return <InlineFeedback role="alert" title={t(failure.productMessageKey, failure.productMessageValues)} tone="danger"><Button leadingIcon={<X size={14} />} size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button>{failure.technicalMessage ? <Collapsible><CollapsibleTrigger asChild><Button size="sm" variant="ghost">{t("Technical details")}</Button></CollapsibleTrigger><CollapsibleContent><code>{failure.technicalMessage}</code></CollapsibleContent></Collapsible> : null}</InlineFeedback>;
}

function ConnectionDeleteDialog({ connection, state, actions, trigger, onClose }: { readonly connection?: MediaWorkflowConnection; readonly state: MediaWorkflowControllerState; readonly actions: MediaWorkflowControllerActions; readonly trigger: HTMLElement | null; readonly onClose: () => void }): React.JSX.Element | null {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!connection) return null;
  const connectionId = connection.id;
  const busy = isMediaWorkflowBusy(state, "connection-delete", connectionId);
  const failure = selectMediaWorkflowFailure(state.failures, "connection-delete", connectionId);
  async function confirm(): Promise<void> { const outcome = await actions.deleteConnection(connectionId); if (outcome.ok) onClose(); }
  return <Dialog busy={busy} open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent size="sm" data-media-production-dialog="workflow-connection-delete" onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }} onCloseAutoFocus={(event) => { event.preventDefault(); trigger?.focus(); }}><DialogHeader closeLabel={t("Close")} title={t("Delete {name}?", { name: connection.name })} description={t("Workflows keep their history, but this connection cannot be recovered.")} /><DialogBody>{failure ? <InlineFeedback role="alert" title={t(failure.productMessageKey, failure.productMessageValues)} tone="danger"><Button leadingIcon={<RefreshCw size={14} />} size="sm" onClick={() => void confirm()}>{t("Retry")}</Button>{failure.technicalMessage ? <Collapsible><CollapsibleTrigger asChild><Button size="sm" variant="ghost">{t("Technical details")}</Button></CollapsibleTrigger><CollapsibleContent><code>{failure.technicalMessage}</code></CollapsibleContent></Collapsible> : null}</InlineFeedback> : null}</DialogBody><DialogFooter><Button ref={cancelRef} disabled={busy} onClick={onClose}>{t("Cancel")}</Button><Button loading={busy} leadingIcon={<Trash2 size={15} />} variant="danger" onClick={() => void confirm()}>{t("Delete")}</Button></DialogFooter></DialogContent></Dialog>;
}

function connectionRequest(form: ConnectionForm): CreateMediaWorkflowConnectionRequest {
  return { ...form, apiKey: form.apiKey.trim() || undefined };
}

function formFromConnection(connection: MediaWorkflowConnection | undefined): ConnectionForm {
  return connection ? { name: connection.name, baseUrl: connection.baseUrl, authMode: connection.authMode, apiKey: "", networkPolicy: connection.networkPolicy, protocolVariant: connection.protocolVariant } : emptyForm;
}
