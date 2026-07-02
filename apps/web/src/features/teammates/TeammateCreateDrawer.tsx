import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle2,
  Code2,
  FileText,
  Hash,
  Palette,
  PlugZap,
  Plus,
  Rocket,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { useI18n } from "../../i18n.js";
import { isMediaProvider, providerModelRouteLabel, providerPreflightReady } from "../../lib/providers.js";
import type { Channel, ProviderPreset } from "../../types.js";
import { roleLabel } from "./helpers.js";
import { selectDefaultTeammateProvider } from "./teammate-create-defaults.js";
import type { LocalTeammateCreateInput } from "./types.js";

const defaultMemoryScopeLabels: readonly string[] = [
  "private-chat-summary",
  "private-notes",
  "channel-brief",
  "channel-decisions",
];

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
  const providerOptions = useMemo(() => providers.filter((provider) => !isMediaProvider(provider)), [providers]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedChannelIds, setSelectedChannelIds] = useState<readonly string[]>([]);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);
  const previewName = draftName.trim() || selectedTemplate?.name || t("Custom teammate");
  const previewDescription = draftDescription.trim() || selectedTemplate?.summary || t("Describe this teammate with a short working brief.");
  const selectedProviderReady = selectedProvider ? providerPreflightReady(selectedProvider) : false;
  const canCreateTeammate = Boolean(previewName.trim()) && Boolean(selectedProvider) && selectedProviderReady;
  const visibleCreateTemplates = templates.slice(0, 5);

  useEffect(() => {
    if (!open) {
      return;
    }
    const template = templates.find((item) => item.id === initialTemplateId) ?? templates[0];
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

  function toggleChannel(channelId: string): void {
    setSelectedChannelIds((currentIds) =>
      currentIds.includes(channelId) ? currentIds.filter((id) => id !== channelId) : [...currentIds, channelId],
    );
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
    <div
      className="teammate-create-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="teammate-create-dialog teammate-create-drawer" aria-label={t("Create AI teammate")} role="dialog">
        <div className="channel-create-head">
          <div className="teammate-create-title-block">
            <strong>{t("New teammate")}</strong>
            <p>{t("Choose a role first, then model. Extra configuration can be completed later.")}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("Cancel")} title={t("Cancel")}>
            <X size={14} />
          </button>
        </div>

        <div className="channel-options-grid channel-create-grid teammate-create-body">
          <section className="teammate-create-section">
            <div className="teammate-create-section-title">
              <span>{t("Choose initial role")}</span>
            </div>
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
          </section>

          <section className="teammate-create-section">
            <div className="teammate-create-section-title">
              <span>{t("Basic information")}</span>
            </div>
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
                <span>{t("No model presets")}</span>
                <button className="secondary-button" type="button" onClick={openProvidersAndClose}>{t("Open Model Workbench")}</button>
              </div>
            ) : null}
          </section>

          <details className="teammate-create-section teammate-create-advanced">
            <summary>
              <span>{t("Advanced settings")}</span>
              <small>{t("Memory, skills, MCP, permissions and prompt")}</small>
            </summary>
            <div className="teammate-create-advanced-body">
              <section>
                <h3>{t("Join channels")}</h3>
                <div className="teammate-chip-grid" aria-label={t("Channel choices")}>
                  {channels.length === 0 ? (
                    <span className="teammate-muted-note">{t("No channels yet")}</span>
                  ) : (
                    channels.map((channel) => (
                      <button
                        key={channel.id}
                        className={selectedChannelIds.includes(channel.id) ? "teammate-chip selected" : "teammate-chip"}
                        type="button"
                        aria-pressed={selectedChannelIds.includes(channel.id)}
                        onClick={() => toggleChannel(channel.id)}
                      >
                        <Hash size={13} />
                        {channel.name}
                      </button>
                    ))
                  )}
                </div>
              </section>
              <section>
                <h3>{t("Memory")}</h3>
                <div className="provider-run-notice neutral">
                  <ShieldCheck size={15} />
                  <span>{t("Memory is always on for each teammate.")}</span>
                </div>
                <div className="teammate-memory-list compact">
                  {defaultMemoryScopeLabels.map((scope) => (
                    <span key={scope} className="teammate-toggle static">
                      <FileText size={15} />
                      <span>
                        <strong>{t(scope)}</strong>
                      </span>
                    </span>
                  ))}
                </div>
              </section>
            </div>
          </details>

          <div className="channel-option-actions teammate-create-actions">
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
          </div>
        </div>
      </section>
    </div>
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
