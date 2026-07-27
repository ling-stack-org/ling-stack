import { PlugZap } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, EmptyState, Field, Select } from "../../shared/ui/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { providerModelRouteLabel } from "../../lib/providers.js";

export function TeammateProviderField({
  disabled,
  providers,
  value,
  onChange,
}: {
  readonly disabled: boolean;
  readonly providers: readonly ProviderPreset[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <Field label={t("Base model")}>
      <Select value={value} disabled={disabled || providers.length === 0} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("Select model")}</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>{providerModelRouteLabel(provider)}</option>
        ))}
      </Select>
    </Field>
  );
}

export function TeammateChannelField({
  channels,
  disabled,
  value,
  onChange,
}: {
  readonly channels: readonly Channel[];
  readonly disabled: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <Field label={t("Join channels")}>
      <Select value={value} disabled={disabled || channels.length === 0} onChange={(event) => onChange(event.target.value)}>
        <option value="">{channels.length === 0 ? t("No channels yet") : t("No channel")}</option>
        {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
      </Select>
    </Field>
  );
}

export function TeammateNoModelState({ onOpenProviders }: { readonly onOpenProviders: () => void }): JSX.Element {
  const { t } = useI18n();
  return (
    <EmptyState
      className="teammate-create-model-empty"
      compact
      icon={<PlugZap />}
      title={t("No ready chat model")}
      action={<Button size="sm" onClick={onOpenProviders}>{t("Open Model Workbench")}</Button>}
    />
  );
}
