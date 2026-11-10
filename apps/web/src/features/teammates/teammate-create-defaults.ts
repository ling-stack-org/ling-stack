import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import type { Translate } from "../../i18n.js";
import { canUseConversationProvider, providerCompactModelLabel, providerPreflightReady } from "../../lib/providers.js";
import type { ProviderPreset } from "../../types.js";
import type { LocalTeammateCreateInput } from "./types.js";

export interface DefaultTeammateCreateSelection {
  readonly template: AiTeammateTemplate | undefined;
  readonly provider: ProviderPreset | undefined;
  readonly input: LocalTeammateCreateInput | undefined;
}

export function resolveDefaultTeammateCreateSelection(input: {
  readonly templates: readonly AiTeammateTemplate[];
  readonly providers: readonly ProviderPreset[];
  readonly defaultProviderId: string;
  readonly existingNames: readonly string[];
  readonly t: Translate;
}): DefaultTeammateCreateSelection {
  const template = selectDefaultTeammateTemplate(input.templates);
  const provider = selectDefaultTeammateProvider(input.providers, input.defaultProviderId);
  if (!template || !provider) {
    return { template, provider, input: undefined };
  }

  const displayName = nextUniqueTeammateName(input.t(template.name), input.existingNames);
  return {
    template,
    provider,
    input: {
      templateId: template.id,
      displayName,
      description: input.t(template.summary),
      providerPresetId: provider.id,
      modelLabel: providerCompactModelLabel(provider),
      channelIds: [],
    },
  };
}

export function selectDefaultTeammateTemplate(
  templates: readonly AiTeammateTemplate[],
): AiTeammateTemplate | undefined {
  return templates.find((template) => template.id === "engineer")
    ?? templates.find((template) => template.roleKey === "engineer")
    ?? templates[0];
}

export function selectDefaultTeammateProvider(
  providers: readonly ProviderPreset[],
  defaultProviderId: string,
): ProviderPreset | undefined {
  const readyProviders = providers.filter((provider) => canUseConversationProvider(provider) && providerPreflightReady(provider));
  return readyProviders.find((provider) => provider.id === defaultProviderId) ?? readyProviders[0];
}

function nextUniqueTeammateName(baseName: string, existingNames: readonly string[]): string {
  const trimmedBaseName = baseName.trim() || "Engineer";
  const normalizedExistingNames = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()));
  if (!normalizedExistingNames.has(trimmedBaseName.toLocaleLowerCase())) {
    return trimmedBaseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${trimmedBaseName} ${index}`;
    if (!normalizedExistingNames.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  return `${trimmedBaseName} ${Date.now()}`;
}
