import { useI18n } from "../../i18n.js";
import { providerRunBlockerLabel } from "../../lib/providers.js";
import type { ChannelFormState, ProviderPreset } from "../../types.js";

export function ProviderPresetOptions({
  runnableProviders,
  blockedProviders,
}: {
  readonly runnableProviders: readonly ProviderPreset[];
  readonly blockedProviders: readonly ProviderPreset[];
}): JSX.Element {
  const { t } = useI18n();

  return (
    <>
      {runnableProviders.length > 0 ? (
        <optgroup label={t("Ready coding task presets")}>
          {runnableProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName} / {provider.model}
            </option>
          ))}
        </optgroup>
      ) : null}
      {blockedProviders.length > 0 ? (
        <optgroup label={t("Needs setup before task runs")}>
          {blockedProviders.map((provider) => (
            <option key={provider.id} value={provider.id} disabled>
              {provider.displayName} / {provider.model} - {providerRunBlockerLabel(provider)}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

export function ChannelRuntimePolicyFields({
  form,
  onChange,
}: {
  readonly form: ChannelFormState;
  readonly onChange: (form: ChannelFormState) => void;
}): JSX.Element {
  const { t } = useI18n();
  const updatePolicy = (runtimePolicy: Partial<ChannelFormState["runtimePolicy"]>): void => {
    onChange({
      ...form,
      runtimePolicy: {
        ...form.runtimePolicy,
        ...runtimePolicy,
      },
    });
  };

  return (
    <div className="runtime-policy-grid" aria-label={t("Channel runtime policy")}>
      <label className="field wide">
        <span>{t("Status")}</span>
        <select value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value as ChannelFormState["status"] })}>
          <option value="active">{t("active")}</option>
          <option value="paused">{t("paused")}</option>
          <option value="archived">{t("archived")}</option>
        </select>
      </label>
      <label className="field wide">
        <span>{t("Execution mode")}</span>
        <select
          value={form.runtimePolicy.executionMode}
          onChange={(event) => updatePolicy({ executionMode: event.target.value as ChannelFormState["runtimePolicy"]["executionMode"] })}
        >
          <option value="serial">{t("serial")}</option>
          <option value="parallel">{t("parallel")}</option>
        </select>
      </label>
      <label className="field wide">
        <span>{t("Write lock")}</span>
        <select
          value={form.runtimePolicy.writeLockScope}
          onChange={(event) => updatePolicy({ writeLockScope: event.target.value as ChannelFormState["runtimePolicy"]["writeLockScope"] })}
        >
          <option value="boundPath">{t("boundPath")}</option>
          <option value="channel">{t("channel")}</option>
          <option value="workspace">{t("workspace")}</option>
        </select>
      </label>
      <label className="field wide">
        <span>{t("Max runs")}</span>
        <input
          type="number"
          min={1}
          max={20}
          value={form.runtimePolicy.maxConcurrentRuns}
          onChange={(event) => updatePolicy({ maxConcurrentRuns: Number(event.target.value) || 1 })}
        />
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={form.runtimePolicy.allowReadOnlyParallel}
          onChange={(event) => updatePolicy({ allowReadOnlyParallel: event.target.checked })}
        />
        <span>{t("Allow read-only parallel")}</span>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={form.runtimePolicy.queueOnConflict}
          onChange={(event) => updatePolicy({ queueOnConflict: event.target.checked })}
        />
        <span>{t("Queue on conflict")}</span>
      </label>
    </div>
  );
}
