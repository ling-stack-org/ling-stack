import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { Check, Plus } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, Field, Input } from "../../shared/ui/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { TeammateChannelField, TeammateNoModelState, TeammateProviderField } from "./TeammateCreateFields.js";
import { teammateRoleIcon } from "./teammate-role-icons.js";

export function TeammateCreateRoleStep({
  channels,
  disabled,
  draftName,
  providers,
  selectedChannelId,
  selectedProviderId,
  selectedTemplateId,
  templates,
  onChangeChannel,
  onChangeName,
  onChangeProvider,
  onOpenCustom,
  onOpenProviders,
  onSelectTemplate,
}: {
  readonly channels: readonly Channel[];
  readonly disabled: boolean;
  readonly draftName: string;
  readonly providers: readonly ProviderPreset[];
  readonly selectedChannelId: string;
  readonly selectedProviderId: string;
  readonly selectedTemplateId: string;
  readonly templates: readonly AiTeammateTemplate[];
  readonly onChangeChannel: (value: string) => void;
  readonly onChangeName: (value: string) => void;
  readonly onChangeProvider: (value: string) => void;
  readonly onOpenCustom: () => void;
  readonly onOpenProviders: () => void;
  readonly onSelectTemplate: (template: AiTeammateTemplate) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <div className="teammate-create-role-step">
      <section className="teammate-create-section">
        <h2>{t("Choose initial role")}</h2>
        <div className="teammate-create-role-options" aria-label={t("Teammate template chooser")}>
          {templates.map((template) => {
            const selected = template.id === selectedTemplateId;
            return (
              <Button
                key={template.id}
                className="teammate-create-role-option"
                aria-pressed={selected}
                disabled={disabled}
                leadingIcon={teammateRoleIcon(template.roleKey)}
                trailingIcon={selected ? <Check /> : undefined}
                variant="ghost"
                onClick={() => onSelectTemplate(template)}
              >
                <span className="teammate-create-role-copy">
                  <strong>{t(template.name)}</strong>
                  <small>{t(template.summary)}</small>
                </span>
              </Button>
            );
          })}
          <Button
            className="teammate-create-role-option teammate-create-custom-entry"
            disabled={disabled}
            leadingIcon={<Plus />}
            variant="ghost"
            onClick={onOpenCustom}
          >
            <span className="teammate-create-role-copy">
              <strong>{t("Start from blank")}</strong>
            </span>
          </Button>
        </div>
      </section>

      <section className="teammate-create-section">
        <h2>{t("Basic information")}</h2>
        <div className="teammate-create-basic-fields">
          <Field label={t("Teammate name")}>
            <Input value={draftName} disabled={disabled} onChange={(event) => onChangeName(event.target.value)} />
          </Field>
          <TeammateChannelField
            channels={channels}
            disabled={disabled}
            value={selectedChannelId}
            onChange={onChangeChannel}
          />
          <TeammateProviderField
            disabled={disabled}
            providers={providers}
            value={selectedProviderId}
            onChange={onChangeProvider}
          />
        </div>
        {providers.length === 0 ? <TeammateNoModelState onOpenProviders={onOpenProviders} /> : null}
      </section>
    </div>
  );
}
