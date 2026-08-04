import { ArrowLeft, Upload, X } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { AvatarInitial, type AvatarTone } from "../../shared/components/index.js";
import { Button, Field, IconButton, Input, Textarea } from "../../shared/ui/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { TeammateChannelField, TeammateNoModelState, TeammateProviderField } from "./TeammateCreateFields.js";

const avatarTones: readonly AvatarTone[] = ["violet", "blue", "teal", "orange", "rose", "gray"];

export function TeammateCustomSetupStep({
  avatarFile,
  avatarPreviewUrl,
  avatarTone,
  channels,
  disabled,
  draftDescription,
  draftName,
  previewName,
  providers,
  selectedChannelId,
  selectedProviderId,
  onBack,
  onChangeAvatarFile,
  onChangeAvatarTone,
  onChangeChannel,
  onChangeDescription,
  onChangeName,
  onChangeProvider,
  onOpenProviders,
}: {
  readonly avatarFile?: File;
  readonly avatarPreviewUrl: string;
  readonly avatarTone: AvatarTone;
  readonly channels: readonly Channel[];
  readonly disabled: boolean;
  readonly draftDescription: string;
  readonly draftName: string;
  readonly previewName: string;
  readonly providers: readonly ProviderPreset[];
  readonly selectedChannelId: string;
  readonly selectedProviderId: string;
  readonly onBack: () => void;
  readonly onChangeAvatarFile: (file: File | undefined) => void;
  readonly onChangeAvatarTone: (tone: AvatarTone) => void;
  readonly onChangeChannel: (value: string) => void;
  readonly onChangeDescription: (value: string) => void;
  readonly onChangeName: (value: string) => void;
  readonly onChangeProvider: (value: string) => void;
  readonly onOpenProviders: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section className="teammate-custom-setup" aria-label={t("Custom teammate setup")}>
      <Button
        className="teammate-custom-back"
        disabled={disabled}
        leadingIcon={<ArrowLeft />}
        size="sm"
        variant="ghost"
        onClick={onBack}
      >
        {t("Back")}
      </Button>

      <div className="teammate-custom-profile">
        <div className="teammate-custom-avatar">
          <label className="teammate-custom-avatar-picker">
            {avatarPreviewUrl ? (
              <img src={avatarPreviewUrl} alt="" />
            ) : (
              <AvatarInitial label={teammateInitial(previewName)} tone={avatarTone} />
            )}
            <span className="teammate-custom-avatar-upload" aria-hidden="true"><Upload /></span>
            <input
              data-ling-control-native="true"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label={t("Upload avatar")}
              disabled={disabled}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                onChangeAvatarFile(file);
              }}
            />
          </label>
          <span className="teammate-custom-avatar-copy">
            <strong title={avatarFile?.name}>{avatarFile ? avatarFile.name : t("Custom")}</strong>
          </span>
        </div>

        {avatarFile ? (
          <IconButton
            className="teammate-avatar-remove"
            disabled={disabled}
            icon={X}
            label={t("Remove avatar")}
            onClick={() => onChangeAvatarFile(undefined)}
          />
        ) : (
          <div className="teammate-avatar-tone-list" aria-label={t("Avatar color")}>
            {avatarTones.map((tone) => (
              <button
                key={tone}
                className="teammate-avatar-tone-option"
                type="button"
                aria-label={t("Avatar color {tone}", { tone })}
                aria-pressed={avatarTone === tone}
                disabled={disabled}
                onClick={() => onChangeAvatarTone(tone)}
              >
                <AvatarInitial label="" tone={tone} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="teammate-custom-fields">
        <Field label={t("Teammate name")}>
          <Input value={draftName} disabled={disabled} onChange={(event) => onChangeName(event.target.value)} />
        </Field>
        <TeammateProviderField
          disabled={disabled}
          providers={providers}
          value={selectedProviderId}
          onChange={onChangeProvider}
        />
        <Field className="teammate-custom-brief" label={t("Brief description")}>
          <Textarea
            rows={5}
            value={draftDescription}
            disabled={disabled}
            placeholder={t("Describe what this teammate should help with.")}
            onChange={(event) => onChangeDescription(event.target.value)}
          />
        </Field>
        <TeammateChannelField
          channels={channels}
          disabled={disabled}
          value={selectedChannelId}
          onChange={onChangeChannel}
        />
      </div>
      {providers.length === 0 ? <TeammateNoModelState onOpenProviders={onOpenProviders} /> : null}
    </section>
  );
}

function teammateInitial(value: string): string {
  const trimmed = value.trim();
  return (trimmed[0] ?? "T").toLocaleUpperCase();
}
