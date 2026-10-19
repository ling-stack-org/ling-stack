import type { ExecutionEngineConnectionProbe, ExternalExecutionEngineId } from "@ling-stack/contracts";
import { ArrowRight, Cable, CircleHelp, KeyRound, LogIn, Pencil, PlugZap, Unplug } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { daemonBaseUrl } from "../../../api/client.js";
import { useDesktopTitlebarPlacement } from "../../../app/DesktopTitlebarSurface.js";
import { useI18n } from "../../../i18n.js";
import { Button, Field, InlineFeedback, Input, Skeleton } from "../../../shared/ui/index.js";
import { createEngineManagementTransport } from "./engine-management-transport.js";
import { ExecutionEngineLoginController, ExecutionEngineManager, engineProbeOutcome, engineLoginMethod, needsAuthority } from "./execution-engine-manager.js";
import { EngineManagementError } from "./EngineManagementError.js";
import { EngineProfileDialog } from "./EngineProfileDialog.js";
import { EngineLoginDialog } from "./EngineLoginDialog.js";
import { WorkspaceEnginePolicySection } from "./WorkspaceEnginePolicySection.js";
import { engineProbeMessage } from "./engine-guidance.js";
import { EngineSetupGuide } from "./EngineSetupGuide.js";

const engines: readonly { readonly id: ExternalExecutionEngineId; readonly name: string }[] = [
  { id: "codex-app-server", name: "Codex" },
  { id: "claude-agent-sdk", name: "Claude Code" },
  { id: "kimi-acp", name: "Kimi Code CLI" },
  { id: "openclaw-acp", name: "OpenClaw" },
];

// A browser enrollment survives navigation, but never a reload or an explicit revocation.
const managementTransport = createEngineManagementTransport({ baseUrl: daemonBaseUrl, desktop: window.lingDesktop });
const loginController = new ExecutionEngineLoginController(managementTransport);

export function ExecutionEnginesSettingsPage({ cwd }: { readonly cwd: string }): React.JSX.Element {
  const { t } = useI18n();
  const placement = useDesktopTitlebarPlacement();
  const [manager] = useState(() => new ExecutionEngineManager(managementTransport));
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const login = useSyncExternalStore(loginController.subscribe, loginController.getSnapshot);
  const [code, setCode] = useState("");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { void manager.load(); return () => { manager.detach(); void loginController.cancel(); }; }, [manager]);
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "visible" && !loginController.getSnapshot()) void manager.revalidate();
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [manager]);
  useEffect(() => { if (login?.operation?.status === "completed") void manager.load(); }, [manager, login?.operation?.id, login?.operation?.status]);
  useEffect(() => {
    if (login?.error && needsAuthority(login.error)) { loginController.close(); void manager.load(); }
  }, [manager, login?.error]);
  const ready = state.phase === "ready";
  const loading = state.phase === "loading";
  const editorName = engines.find((engine) => engine.id === state.editor?.draft.engineId)?.name ?? "";

  return (
    <div className="execution-engines-settings" data-engine-management-state={state.phase}>
      {placement === "inline" ? <h1>{t("Execution engines")}</h1> : null}
      {state.phase === "authorization_required" && manager.transport.kind === "web" ? (
        <form className="engine-authorization" onSubmit={(event) => {
          event.preventDefault();
          const submittedCode = code;
          setCode("");
          void manager.enroll(submittedCode);
        }}>
          <InlineFeedback tone="neutral">{t("Authorize this browser on the execution host.")}</InlineFeedback>
          <div className="engine-authorization-controls">
            <Field label={t("Authorization code")} required>
              <Input type="password" autoComplete="off" spellCheck={false} value={code} maxLength={32}
                disabled={state.authorizing} onChange={(event) => setCode(event.target.value)} />
            </Field>
            <Button type="submit" variant="primary" leadingIcon={<ArrowRight />} loading={state.authorizing}
              loadingLabel={t("Loading")} disabled={!code.trim()}>{t("Confirm")}</Button>
          </div>
        </form>
      ) : null}
      {state.error && !(state.phase === "authorization_required" && state.error === "engine_authority_required") ? <EngineManagementError code={state.error} /> : null}
      {state.phase === "error" ? <Button leadingIcon={<PlugZap />} onClick={() => void manager.load()}>{t("Retry")}</Button> : null}
      <ul className="engine-settings-list" aria-label={t("Execution engines")} aria-busy={loading}>
        <li className="engine-settings-row" data-engine-id="pi">
          <div className="engine-settings-name"><strong>Ling</strong><span>{t("Built-in")}</span></div>
        </li>
        {engines.map((engine) => {
          const profile = state.profiles.find((item) => item.configuration.engineId === engine.id);
          const busy = state.busy[engine.id];
          const probe = state.probes[engine.id];
          const error = state.errors[engine.id];
          const loginMethod = profile ? engineLoginMethod(profile) : undefined;
          return (
            <li key={engine.id} className="engine-settings-row" data-engine-id={engine.id} aria-busy={Boolean(busy)}>
              <div className="engine-settings-row-main">
                <div className="engine-settings-name">
                  <strong>{engine.name}</strong>
                  {loading ? <Skeleton width={80} height={14} /> : ready && !profile ? <span>{t("Not configured")}</span>
                    : profile?.status === "disconnected" ? <span>{t("Not connected")}</span> : null}
                </div>
                <div className="engine-settings-actions">
                  {ready && !profile ? <EngineSetupGuide engineId={engine.id} /> : null}
                  {profile && loginMethod ? <Button size="sm" leadingIcon={loginMethod === "apiKey" ? <KeyRound /> : <LogIn />}
                    disabled={!ready || Boolean(busy) || Boolean(login)} onClick={(event) => {
                      returnFocusRef.current = event.currentTarget;
                      void loginController.start(profile);
                    }}>{loginMethod === "apiKey" ? t("Apply API key") : t("Sign in")}</Button> : null}
                  {profile?.status === "configured" ? <Button size="sm" leadingIcon={<Cable />} disabled={!ready || Boolean(busy)}
                    loading={busy === "probe"} loadingLabel={t("Checking connection")}
                    onClick={() => void manager.checkConnection(engine.id)}>{t("Check connection")}</Button> : null}
                  <Button size="sm" leadingIcon={<Pencil />} disabled={!ready || Boolean(busy)} onClick={(event) => {
                    returnFocusRef.current = event.currentTarget;
                    manager.edit(engine.id);
                  }}>{t("Configuration")}</Button>
                </div>
              </div>
              {engine.id === "claude-agent-sdk" ? <p>{t("Execution is not supported for this engine.")}</p> : null}
              {error ? <EngineManagementError code={error} /> : null}
              {probe ? <ProbeResult probe={probe} engineId={engine.id} /> : null}
              {profile && (profile.status === "configured" || probe?.runtimeVersion) ? <details className="engine-settings-details">
                <summary><CircleHelp size={14} aria-hidden="true" />{t("Details")}</summary>
                <div>
                  {probe?.runtimeVersion ? <dl><dt>{t("Version")}</dt><dd>{probe.runtimeVersion}</dd></dl> : null}
                  {profile.status === "configured" ? <Button size="sm" leadingIcon={<Unplug />} disabled={!ready || Boolean(busy)}
                    loading={busy === "disconnect"} loadingLabel={t("Loading")}
                    onClick={() => void manager.disconnect(engine.id)}>{t("Disconnect")}</Button> : null}
                </div>
              </details> : null}
            </li>
          );
        })}
      </ul>
      {cwd.trim() ? <WorkspaceEnginePolicySection key={cwd} cwd={cwd} profiles={state.profiles} /> : null}
      {ready && manager.transport.kind === "web" ? <div className="engine-settings-session">
        <Button size="sm" variant="ghost" leadingIcon={<Unplug />} onClick={() => void manager.revoke()}>{t("Clear authorization")}</Button>
      </div> : null}
      {state.editor && ready ? <EngineProfileDialog key={`${state.editor.draft.engineId}:${state.editor.expectedRevision}`} editor={state.editor} name={editorName}
        returnFocusRef={returnFocusRef}
        busy={Boolean(state.busy[state.editor.draft.engineId])}
        onChange={(patch) => manager.updateDraft(patch)} onSave={(secret) => manager.save(secret)}
        onAuthenticationMode={(mode) => manager.setAuthenticationMode(mode)}
        onReload={() => { void manager.reloadEditor(); }} onCancel={() => manager.cancelEdit()} /> : null}
      {login && ready ? <EngineLoginDialog controller={loginController} state={login}
        name={engines.find((engine) => engine.id === login.profile.configuration.engineId)?.name ?? ""} returnFocusRef={returnFocusRef} /> : null}
    </div>
  );
}

function ProbeResult({ probe, engineId }: { readonly probe: ExecutionEngineConnectionProbe; readonly engineId: ExternalExecutionEngineId }): React.JSX.Element {
  const { t } = useI18n();
  const outcome = engineProbeOutcome(probe);
  const needsGuide = ["not_found", "not_executable", "unexpected_runtime", "unsupported_platform", "unsupported_auth", "protocol_error"].includes(outcome);
  return <div className="engine-probe-feedback">
    <span className="engine-probe-result" role="status">{engineProbeMessage(outcome, t)}</span>
    {needsGuide ? <EngineSetupGuide engineId={engineId} /> : null}
  </div>;
}
