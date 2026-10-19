import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getRuntimeSettings, listRunners, updateRuntimeSettings } from "../../../api/runtime.js";
import { useI18n } from "../../../i18n.js";
import { Button, Checkbox, Field, InlineFeedback, Input, Select, Skeleton } from "../../../shared/ui/index.js";
import { WorkspaceEnginePolicyController } from "./workspace-engine-policy.js";

const emptyProfiles: readonly ExecutionEngineProfile[] = [];

const engineNames: Readonly<Record<string, string>> = {
  pi: "Ling", "codex-app-server": "Codex", "claude-agent-sdk": "Claude Code", "kimi-acp": "Kimi Code CLI", "openclaw-acp": "OpenClaw",
};

export function WorkspaceEnginePolicySection({ cwd, profiles = emptyProfiles }: { readonly cwd: string; readonly profiles?: readonly ExecutionEngineProfile[] }): React.JSX.Element {
  const { t } = useI18n();
  const [controller] = useState(() => new WorkspaceEnginePolicyController(cwd, { getRuntimeSettings, listRunners, updateRuntimeSettings }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => { void controller.load(); return () => controller.detach(); }, [controller]);
  useEffect(() => controller.setProfiles(profiles), [controller, profiles]);
  const draft = state.draft;
  const binding = draft?.defaultExecutionBinding;
  const nativeProfile = binding?.kind === "native_profile" ? profiles.find(profile => profile.id === binding.profileId) : undefined;
  const busy = state.saving || state.phase !== "ready";
  const defaultCandidates = state.runners.filter((runner) => runner.id === draft?.defaultRunnerId
    || ((runner.status === "enabled" || runner.profileSelection === "supported") && draft?.allowedRunnerIds.includes(runner.id)));
  const error = state.error === "conflict" ? t("The configuration changed elsewhere. Reload before saving.")
    : state.error === "save" ? t("Could not save workspace engines.")
      : state.error === "load" ? t("Could not load workspace engines.") : undefined;

  return (
    <section className="engine-workspace-policy" aria-label={t("Workspace engines")} aria-busy={busy}>
      <h2>{t("Workspace engines")}</h2>
      {state.phase === "loading" ? <Skeleton width="100%" height={120} /> : null}
      {state.saved?.migration ? <InlineFeedback tone="warning">{t("Legacy endpoint execution is retired. Select and confirm a native configuration.")}</InlineFeedback> : null}
      {draft && state.phase !== "loading" ? <form className="engine-workspace-form" onSubmit={(event) => { event.preventDefault(); void controller.save(); }}>
        <fieldset className="engine-workspace-choices" disabled={busy}>
          <legend>{t("Allowed engines")}</legend>
          {state.runners.map((runner) => <Checkbox key={runner.id} checked={draft.allowedRunnerIds.includes(runner.id)}
            disabled={!controller.canAllow(runner.id)}
            onChange={(event) => controller.setAllowed(runner.id, event.target.checked)}
            label={<span className="engine-workspace-choice-label"><span>{engineNames[runner.id] ?? runner.displayName}</span>
              {runner.profileSelection === "supported" ? <small>{t("Execution requires verification.")}</small>
                : runner.status === "disabled" ? <small>{t("Unavailable")}</small> : null}</span>} />)}
        </fieldset>
        <Field label={t("Default engine")} error={!controller.valid ? t("Select an allowed engine as the default.") : undefined}>
          <Select value={draft.defaultRunnerId} disabled={busy || draft.allowedRunnerIds.length === 0}
            onChange={(event) => controller.setDefault(event.target.value)}>
            {defaultCandidates.map((runner) => <option key={runner.id} value={runner.id}
              disabled={(runner.status !== "enabled" && (runner.profileSelection !== "supported"
                || !profiles.some(profile => profile.configuration.engineId === runner.id && profile.status === "configured"))) || !draft.allowedRunnerIds.includes(runner.id)}>
              {engineNames[runner.id] ?? runner.displayName}
            </option>)}
          </Select>
        </Field>
        {binding?.kind === "native_profile" ? <>
          {binding.engineId === "codex-app-server" || binding.engineId === "kimi-acp" && !nativeProfile?.configuration.secretRef ?
            <Field label={t("Native model")}><Input value={binding.nativeModelId ?? ""} disabled={busy}
              onChange={(event) => controller.setNativeModel(event.target.value)} /></Field> : null}
          {nativeProfile && nativeProfile.revision !== binding.profileRevision ? <Button disabled={busy}
            onClick={() => controller.setDefault(draft.defaultRunnerId)}>{t("Use current configuration")}</Button> : null}
          <InlineFeedback tone="neutral">{t("Execution requires verification.")}</InlineFeedback>
        </> : null}
        {controller.confirmationRequired ? <Checkbox checked={controller.confirmed} disabled={busy}
          onChange={(event) => controller.confirmMigration(event.target.checked)}
          label={t("Authorize these native engines and retire the legacy endpoint configuration.")} /> : null}
        {draft.allowedRunnerIds.length === 0 ? <InlineFeedback tone="neutral">{t("No engines are allowed in this workspace.")}</InlineFeedback> : null}
        {controller.dirty ? <div className="engine-workspace-actions">
          <Button disabled={busy} onClick={() => controller.cancel()}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" leadingIcon={<Save />} loading={state.saving} loadingLabel={t("Loading")}
            disabled={busy || !controller.valid || state.error === "conflict" || controller.confirmationRequired && !controller.confirmed}>{t("Save changes")}</Button>
        </div> : null}
      </form> : null}
      {error ? <InlineFeedback tone="warning" role="alert">{error}</InlineFeedback> : null}
      {state.error === "conflict" || state.error === "load" ? <Button leadingIcon={<RotateCcw />} disabled={state.saving}
        onClick={() => void controller.load()}>{state.error === "conflict" ? t("Reload latest version") : t("Retry")}</Button> : null}
    </section>
  );
}
