import { useI18n } from "../../i18n.js";
import { providerModelRouteLabel, providerRunBlockerLabel } from "../../lib/providers.js";
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
              {providerModelRouteLabel(provider)}
            </option>
          ))}
        </optgroup>
      ) : null}
      {blockedProviders.length > 0 ? (
        <optgroup label={t("Needs setup before task runs")}>
          {blockedProviders.map((provider) => (
            <option key={provider.id} value={provider.id} disabled>
              {providerModelRouteLabel(provider)} - {providerRunBlockerLabel(provider, t)}
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
  return (
    <div className="runtime-policy-grid" aria-label={t("Channel runtime policy")}>
      <ChannelExecutionModeSummary />
      <ChannelWriteLockField form={form} onChange={onChange} />
    </div>
  );
}

export function ChannelExecutionModeSummary(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="field wide runtime-policy-summary">
      <span>{t("Execution mode")}</span>
      <strong>{t("Smart scheduling")}</strong>
      <small>{t("Ling Agent decides when safe steps can run together. Writes, unknown tools, approvals, and resource locks stay protected.")}</small>
    </div>
  );
}

export function ChannelWriteLockField({
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
  );
}
