import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, Server, Trash2 } from "lucide-react";
import { SelectControl } from "../../../shared/components/SelectControl.js";
import type { MediaWorkflowConnection } from "../../../types.js";
import type { MediaWorkflowControllerActions, MediaWorkflowControllerState } from "./media-workflow-types.js";

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

export function WorkflowConnectionWorkspace({
  state,
  actions,
}: {
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
}): JSX.Element {
  const [creating, setCreating] = useState(state.connections.length === 0);
  const selected = state.connections.find((item) => item.id === state.selectedConnectionId);
  const [form, setForm] = useState<ConnectionForm>(() => formFromConnection(selected));
  const referencedConnectionIds = useMemo(
    () => new Set(state.workflows.map((item) => item.definition.connectionId)),
    [state.workflows],
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
      const created = await actions.createConnection({
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        authMode: form.authMode,
        apiKey: form.apiKey.trim() || undefined,
        networkPolicy: form.networkPolicy,
        protocolVariant: form.protocolVariant,
      });
      if (created) setCreating(false);
      return;
    }
    if (!selected) return;
    await actions.updateConnection(selected.id, {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      authMode: form.authMode,
      apiKey: form.apiKey.trim() || undefined,
      networkPolicy: form.networkPolicy,
      protocolVariant: form.protocolVariant,
    });
    setForm((current) => ({ ...current, apiKey: "" }));
  }

  const busy = Boolean(state.busyAction);
  return (
    <div className="media-workflow-split-view connection-workspace">
      <div className="media-workflow-list-pane">
        <div className="media-workflow-list-head">
          <div><strong>ComfyUI 连接</strong><span>{state.connections.length} 个</span></div>
          <button className="icon-button" type="button" title="新建连接" aria-label="新建连接" onClick={() => { setCreating(true); setForm(emptyForm); }}>
            <Plus size={16} />
          </button>
        </div>
        <div className="media-workflow-list-scroll">
          {state.connections.map((connection) => (
            <button
              className={`media-workflow-list-row${!creating && connection.id === selected?.id ? " selected" : ""}`}
              type="button"
              key={connection.id}
              onClick={() => selectConnection(connection.id)}
            >
              <Server size={16} />
              <span><strong>{connection.name}</strong><small>{connectionStatus(connection)}</small></span>
              <i className={`media-workflow-status-dot ${connection.status}`} />
            </button>
          ))}
          {state.connections.length === 0 ? (
            <div className="media-workflow-list-empty compact">
              <Server size={18} aria-hidden="true" />
              <strong>还没有连接</strong>
              <span>点击右上角加号创建 ComfyUI 连接。</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="media-workflow-detail-pane">
        <div className="media-workflow-detail-head">
          <div>
            <span className="media-workflow-eyebrow">{creating ? "新连接" : "连接设置"}</span>
            <h3>{creating ? "连接 ComfyUI" : selected?.name}</h3>
            <p>Ling 只通过 HTTP 调用独立运行的 ComfyUI，不安装模型或自定义节点。</p>
          </div>
          {!creating && selected ? (
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => void actions.checkConnection(selected.id)}
              disabled={busy}
            >
              <CheckCircle2 size={15} /> {state.busyAction === `check-connection:${selected.id}` ? "检查中" : "检查连接"}
            </button>
          ) : null}
        </div>

        <div className="media-workflow-connection-form">
          <label className="field"><span>连接名称</span><input value={form.name} disabled={busy} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label className="field"><span>ComfyUI 地址</span><input value={form.baseUrl} disabled={busy} placeholder="http://127.0.0.1:8188" onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
          <div className="media-workflow-form-row two-columns">
            <label className="field">
              <span>鉴权方式</span>
              <SelectControl value={form.authMode} disabled={busy} onChange={(event) => setForm({ ...form, authMode: event.target.value as ConnectionForm["authMode"] })}>
                <option value="none">无需密钥</option>
                <option value="bearer">Bearer API Key</option>
              </SelectControl>
            </label>
            <label className="field">
              <span>接口兼容</span>
              <SelectControl value={form.protocolVariant} disabled={busy} onChange={(event) => setForm({ ...form, protocolVariant: event.target.value as ConnectionForm["protocolVariant"] })}>
                <option value="auto">自动识别</option>
                <option value="jobs_v1">Jobs API</option>
                <option value="prompt_legacy">Prompt / History</option>
              </SelectControl>
            </label>
          </div>
          {form.authMode === "bearer" ? (
            <label className="field">
              <span>API Key</span>
              <input type="password" value={form.apiKey} disabled={busy} placeholder={selected?.secretConfigured ? "已配置，留空保持不变" : "输入 API Key"} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
            </label>
          ) : null}
          <label className="media-workflow-trust-row">
            <input
              type="checkbox"
              checked={form.networkPolicy === "trusted_private_network"}
              disabled={busy}
              onChange={(event) => setForm({ ...form, networkPolicy: event.target.checked ? "trusted_private_network" : "public_only" })}
            />
            <span><strong>信任本机或局域网地址</strong><small>仅在你确认该 ComfyUI 服务由自己管理时开启。</small></span>
          </label>
          {selected?.health ? (
            <div className={`media-workflow-health ${selected.health.ok ? "success" : "danger"}`}>
              <strong>{selected.health.ok ? "连接可用" : "连接异常"}</strong>
              <span>{selected.health.message}</span>
            </div>
          ) : null}
        </div>

        <div className="media-workflow-detail-actions">
          {!creating && selected && !referencedConnectionIds.has(selected.id) ? (
            <button className="secondary-button danger-button" type="button" disabled={busy} onClick={() => void actions.deleteConnection(selected.id)}>
              <Trash2 size={15} /> 删除连接
            </button>
          ) : <span />}
          <button className="primary-button" type="button" disabled={busy || !form.name.trim() || !form.baseUrl.trim()} onClick={() => void save()}>
            {creating ? "保存连接" : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formFromConnection(connection: MediaWorkflowConnection | undefined): ConnectionForm {
  return connection ? {
    name: connection.name,
    baseUrl: connection.baseUrl,
    authMode: connection.authMode,
    apiKey: "",
    networkPolicy: connection.networkPolicy,
    protocolVariant: connection.protocolVariant,
  } : emptyForm;
}

function connectionStatus(connection: MediaWorkflowConnection): string {
  if (connection.status === "ready") return connection.health?.protocolVariant === "jobs_v1" ? "已连接 · Jobs API" : "已连接";
  if (connection.status === "error") return "需要检查";
  if (connection.status === "disabled") return "已停用";
  return "尚未检查";
}
