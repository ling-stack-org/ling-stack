import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle2,
  Code2,
  FileText,
  Palette,
  PlugZap,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { useI18n } from "../../i18n.js";
import { canUseConversationProvider, providerModelRouteLabel, providerPreflightReady } from "../../lib/providers.js";
import { CreateDialogShell, DialogSection } from "../../shared/components/index.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { roleLabel } from "./helpers.js";
import { selectDefaultTeammateProvider, selectDefaultTeammateTemplate } from "./teammate-create-defaults.js";
import type { LocalTeammateCreateInput } from "./types.js";

export function TeammateCreateDrawer({
  open,
  initialTemplateId,
  templates,
  providers,
  channels,
  defaultProviderId = "",
  onCreate,
  onClose,
  onOpenProviders,
}: {
  readonly open: boolean;
  readonly initialTemplateId?: string;
  readonly templates: readonly AiTeammateTemplate[];
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly defaultProviderId?: string;
  readonly onCreate: (teammate: LocalTeammateCreateInput) => void;
  readonly onClose: () => void;
  readonly onOpenProviders: () => void;
}): JSX.Element | null {
  const { t } = useI18n();
  const providerOptions = useMemo(
    () => providers.filter((provider) => canUseConversationProvider(provider) && providerPreflightReady(provider)),
    [providers],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>([]);
  const selectedTemplate = selectedTemplateId ? templates.find((template) => template.id === selectedTemplateId) : undefined;
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const previewName = draftName.trim() || (selectedTemplate ? t(selectedTemplate.name) : t("Custom teammate"));
  const previewDescription = draftDescription.trim() || (selectedTemplate ? t(selectedTemplate.summary) : t("Describe this teammate with a short working brief."));
  const selectedProviderReady = selectedProvider ? providerPreflightReady(selectedProvider) : false;
  const canCreateTeammate = Boolean(previewName.trim()) && Boolean(selectedProvider) && selectedProviderReady;
  const visibleCreateTemplates = templates.slice(0, 5);

  useEffect(() => {
    if (!open) {
      return;
    }
    const template = templates.find((item) => item.id === initialTemplateId) ?? selectDefaultTeammateTemplate(templates);
    setSelectedTemplateId(template?.id ?? "");
    setDraftName(template ? t(template.name) : t("Custom teammate"));
    setDraftDescription(template ? t(template.summary) : t("Describe this teammate with a short working brief."));
    setSelectedProviderId(selectDefaultTeammateProvider(providerOptions, defaultProviderId)?.id ?? providerOptions[0]?.id ?? "");
    setSelectedChannelIds(channels[0] ? [channels[0].id] : []);
  }, [channels, defaultProviderId, initialTemplateId, open, providerOptions, templates, t]);

  useEffect(() => {
    if (!open || !selectedProviderId || providerOptions.some((provider) => provider.id === selectedProviderId)) {
      return;
    }
    setSelectedProviderId(selectDefaultTeammateProvider(providerOptions, defaultProviderId)?.id ?? providerOptions[0]?.id ?? "");
  }, [defaultProviderId, open, providerOptions, selectedProviderId]);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  function selectTemplate(template: AiTeammateTemplate): void {
    setSelectedTemplateId(template.id);
    setDraftName(t(template.name));
    setDraftDescription(t(template.summary));
  }

  function selectBlankTemplate(): void {
    setSelectedTemplateId("");
    setDraftName(t("Custom teammate"));
    setDraftDescription(t("Describe this teammate with a short working brief."));
  }

  function createTeammateDraft(): void {
    if (!canCreateTeammate) {
      return;
    }
    onCreate({
      templateId: selectedTemplate?.id,
      displayName: previewName,
      description: previewDescription,
      providerPresetId: selectedProvider?.id,
      modelLabel: selectedProvider ? `${selectedProvider.displayName} / ${selectedProvider.model}` : t("No model selected"),
      channelIds: selectedChannelIds,
    });
    onClose();
  }

  function openProvidersAndClose(): void {
    onClose();
    onOpenProviders();
  }

  return (
    <CreateDialogShell
      ariaLabel={t("Create AI teammate")}
      title={t("New AI teammate")}
      description={t("Recommended role and model are prefilled. Review them, then create.")}
      closeLabel={t("Cancel")}
      onClose={onClose}
      className="channel-create-dialog teammate-create-dialog"
      overlayClassName="channel-create-overlay teammate-create-overlay"
      bodyClassName="channel-options-grid channel-create-grid teammate-create-body"
      footer={(
        <>
          {!selectedProviderReady ? (
            <span className="teammate-create-blocked">{selectedProvider ? t("Selected model needs configuration.") : t("Choose a model before creating.")}</span>
          ) : null}
          <button className="secondary-button compact-button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={createTeammateDraft} disabled={!canCreateTeammate}>
            <Plus size={14} />
            {t("Create teammate")}
          </button>
        </>
      )}
    >
          <DialogSection className="teammate-create-section" title={t("Choose initial role")}>
            <div className="teammate-create-list role-grid" aria-label={t("Teammate template chooser")}>
              {visibleCreateTemplates.map((template) => (
                <button
                  key={template.id}
                  className={template.id === selectedTemplate?.id ? "teammate-template-row selected" : "teammate-template-row"}
                  type="button"
                  aria-pressed={template.id === selectedTemplate?.id}
                  onClick={() => selectTemplate(template)}
                >
                  <span className="teammate-role-icon">{templateRoleIcon(template)}</span>
                  <span className="teammate-template-copy">
                    <strong>{t(template.name)}</strong>
                    <small>{t(template.summary)}</small>
                  </span>
                  <small className="template-skill-count">{roleLabel(template.roleKey, t)}</small>
                </button>
              ))}
              <button
                className={!selectedTemplateId ? "teammate-template-row selected" : "teammate-template-row"}
                type="button"
                aria-pressed={!selectedTemplateId}
                onClick={selectBlankTemplate}
              >
                <span className="teammate-role-icon"><Plus size={14} /></span>
                <span className="teammate-template-copy">
                  <strong>{t("Start from blank")}</strong>
                  <small>{t("Use a short description now, then bind skills and memory later.")}</small>
                </span>
                <small className="template-skill-count">{t("Custom")}</small>
              </button>
            </div>
          </DialogSection>

          <DialogSection className="teammate-create-section" title={t("Basic information")}>
            <div className="teammate-create-fields">
              <label className="field">
                <span>{t("Teammate name")}</span>
                <input value={draftName} onChange={(event) => setDraftName(event.target.value)} />
              </label>
              <label className="field">
                <span>{t("Join channels")}</span>
                <select
                  value={selectedChannelIds[0] ?? ""}
                  onChange={(event) => setSelectedChannelIds(event.target.value ? [event.target.value] : [])}
                  disabled={channels.length === 0}
                >
                  <option value="">{channels.length === 0 ? t("No channels yet") : t("No channels available")}</option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("Base model")}</span>
                <select value={selectedProviderId} onChange={(event) => setSelectedProviderId(event.target.value)} disabled={providerOptions.length === 0}>
                  <option value="">{t("Select model")}</option>
                  {providerOptions.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {providerModelRouteLabel(provider)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {providerOptions.length === 0 ? (
              <div className="client-empty-state teammate-empty">
                <PlugZap size={20} />
                <span>{t("No ready chat model")}</span>
                <button className="secondary-button" type="button" onClick={openProvidersAndClose}>{t("Configure model")}</button>
              </div>
            ) : null}
          </DialogSection>

    </CreateDialogShell>
  );
}

function templateRoleIcon(template: AiTeammateTemplate): JSX.Element {
  if (template.roleKey === "product") {
    return <Brain size={15} />;
  }
  if (template.roleKey === "engineer") {
    return <Code2 size={15} />;
  }
  if (template.roleKey === "architect") {
    return <Workflow size={15} />;
  }
  if (template.roleKey === "designer") {
    return <Palette size={15} />;
  }
  if (template.roleKey === "qa") {
    return <CheckCircle2 size={15} />;
  }
  if (template.roleKey === "security") {
    return <ShieldCheck size={15} />;
  }
  if (template.roleKey === "release") {
    return <Rocket size={15} />;
  }
  if (template.roleKey === "docs") {
    return <FileText size={15} />;
  }
  return <Sparkles size={15} />;
}
