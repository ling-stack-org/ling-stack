import { useState } from "react";
import {
  createAiTeammate,
  disableAiTeammate,
  hardDeleteAiTeammate,
  listAiTeammates,
  listTeammateChannels,
  replaceTeammateChannels,
  replaceTeammateSkills,
  updateAiTeammate,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type {
  AiTeammate,
  CreateAiTeammateRequest,
  TeammateChannelMembership,
  UpdateAiTeammateRequest,
} from "../../types.js";

export interface TeammateCreateInput {
  readonly templateId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId?: string;
  readonly modelLabel: string;
  readonly channelIds: readonly string[];
}

export interface BuiltinTeammateTemplate {
  readonly id: string;
  readonly roleKey: string;
  readonly name: string;
  readonly summary: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly approvalProfile: {
    readonly mode: CreateAiTeammateRequest["approvalProfile"]["mode"];
    readonly risk?: CreateAiTeammateRequest["approvalProfile"]["risk"];
    readonly requiredForTools?: readonly string[];
    readonly requiredForActions?: readonly string[];
  };
  readonly defaultSkillIds: readonly string[];
}

export interface TeammatesState {
  readonly aiTeammates: readonly AiTeammate[];
  readonly aiTeammatesLoading: boolean;
  readonly teammateChannelMembershipsByTeammate: Readonly<Record<string, readonly TeammateChannelMembership[]>>;
  readonly teammateChannelMembershipsLoading: boolean;
  readonly channelTeammateSavingId: string;
}

export interface TeammatesActions {
  readonly refreshAiTeammates: (cwd?: string) => Promise<void>;
  readonly refreshTeammateChannelMemberships: (cwd?: string, teammates?: readonly AiTeammate[]) => Promise<void>;
  readonly addAiTeammate: (input: TeammateCreateInput) => Promise<void>;
  readonly removeAiTeammate: (teammateId: string) => Promise<void>;
  readonly hardDeleteAiTeammateAndRefresh: (teammateId: string, reason?: string) => Promise<void>;
  readonly updateAiTeammateSettings: (teammateId: string, input: UpdateAiTeammateRequest) => Promise<AiTeammate>;
  readonly upsertAiTeammate: (teammate: AiTeammate) => void;
  readonly toggleAiTeammatePinned: (teammateId: string) => Promise<void>;
  readonly toggleAiTeammateHidden: (teammateId: string) => Promise<void>;
  readonly addChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly removeChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly setDefaultChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type TeammatesController = DomainController<TeammatesState, TeammatesActions>;

export function useTeammatesDomain(input: {
  readonly cwd: string;
  readonly builtinTeammateTemplates: readonly BuiltinTeammateTemplate[];
  readonly setErrorMessage: (message: string) => void;
  readonly openTeammate: (teammateId: string) => void;
  readonly closeTeammateIfActive: (teammateId: string) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
}): TeammatesController {
  const [aiTeammates, setAiTeammates] = useState<readonly AiTeammate[]>([]);
  const [aiTeammatesLoading, setAiTeammatesLoading] = useState(false);
  const [teammateChannelMembershipsByTeammate, setTeammateChannelMembershipsByTeammate] = useState<Readonly<Record<string, readonly TeammateChannelMembership[]>>>({});
  const [teammateChannelMembershipsLoading, setTeammateChannelMembershipsLoading] = useState(false);
  const [channelTeammateSavingId, setChannelTeammateSavingId] = useState("");
  const [error, setError] = useState<DomainError | undefined>();

  async function addAiTeammate(createInput: TeammateCreateInput): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      return;
    }

    const template = createInput.templateId ? input.builtinTeammateTemplates.find((item) => item.id === createInput.templateId) : undefined;
    const payload: CreateAiTeammateRequest = template
      ? {
        templateId: template.id,
        roleKey: toContractRoleKey(template.roleKey),
        displayName: createInput.displayName.trim() || template.name,
        description: createInput.description.trim() || template.summary,
        providerPresetId: createInput.providerPresetId,
        systemPrompt: template.systemPrompt,
        allowedTools: template.allowedTools.filter(isContractToolName),
        approvalProfile: toContractApprovalProfile(template.approvalProfile),
        status: "active",
      }
      : {
        roleKey: "custom",
        displayName: createInput.displayName.trim() || "Custom teammate",
        description: createInput.description.trim(),
        providerPresetId: createInput.providerPresetId,
        systemPrompt: `You are ${createInput.displayName.trim() || "a custom AI teammate"}. ${createInput.description.trim()}`,
        allowedTools: ["read", "grep", "find", "ls"],
        approvalProfile: { mode: "none" },
        status: "active",
      };

    setAiTeammatesLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await createAiTeammate(cwd, payload);
      const teammateId = response.teammate.id;
      const setupCalls: Promise<unknown>[] = [];
      if (createInput.channelIds.length > 0) {
        setupCalls.push(
          replaceTeammateChannels(
            cwd,
            teammateId,
            createInput.channelIds.map((channelId, index) => ({ channelId, isDefault: index === 0 })),
          ),
        );
      }
      if (template && template.defaultSkillIds.length > 0) {
        setupCalls.push(
          replaceTeammateSkills(
            cwd,
            teammateId,
            template.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
          ),
        );
      }
      await Promise.all(setupCalls);
      await refreshAiTeammates(cwd);
      input.openTeammate(teammateId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setAiTeammatesLoading(false);
    }
  }

  async function removeAiTeammate(teammateId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      return;
    }
    try {
      input.setErrorMessage("");
      setError(undefined);
      await disableAiTeammate(cwd, teammateId);
      await refreshAiTeammates(cwd);
      input.closeTeammateIfActive(teammateId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    }
  }

  async function hardDeleteAiTeammateAndRefresh(teammateId: string, reason?: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      return;
    }
    try {
      input.setErrorMessage("");
      setError(undefined);
      await hardDeleteAiTeammate(cwd, teammateId, reason);
      await refreshAiTeammates(cwd);
      input.closeTeammateIfActive(teammateId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    }
  }

  async function updateAiTeammateSettings(teammateId: string, updateInput: UpdateAiTeammateRequest): Promise<AiTeammate> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("本地工作区未就绪");
      throw new Error("本地工作区未就绪");
    }
    setAiTeammatesLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await updateAiTeammate(cwd, teammateId, updateInput);
      setAiTeammates((current) => upsertAiTeammate(current, response.teammate));
      void refreshAiTeammates(cwd);
      return response.teammate;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      throw caught;
    } finally {
      setAiTeammatesLoading(false);
    }
  }

  async function toggleAiTeammatePinned(teammateId: string): Promise<void> {
    const teammate = aiTeammates.find((item) => item.id === teammateId);
    if (teammate) {
      await updateAiTeammateSettings(teammateId, { pinned: !teammate.pinned });
    }
  }

  async function toggleAiTeammateHidden(teammateId: string): Promise<void> {
    const teammate = aiTeammates.find((item) => item.id === teammateId);
    if (teammate) {
      await updateAiTeammateSettings(teammateId, { hidden: !teammate.hidden });
    }
  }

  function upsertAiTeammateAction(teammate: AiTeammate): void {
    setAiTeammates((current) => upsertAiTeammate(current, teammate));
  }

  async function refreshAiTeammates(cwd = input.cwd.trim()): Promise<void> {
    if (!cwd) {
      setAiTeammates([]);
      setTeammateChannelMembershipsByTeammate({});
      return;
    }

    setAiTeammatesLoading(true);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await listAiTeammates(cwd);
      setAiTeammates(response.teammates);
      await refreshTeammateChannelMemberships(cwd, response.teammates);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setAiTeammatesLoading(false);
    }
  }

  async function refreshTeammateChannelMemberships(
    cwd = input.cwd.trim(),
    teammates = aiTeammates,
  ): Promise<void> {
    if (!cwd || teammates.length === 0) {
      setTeammateChannelMembershipsByTeammate({});
      return;
    }

    setTeammateChannelMembershipsLoading(true);
    try {
      const responses = await Promise.all(
        teammates.map((teammate) => listTeammateChannels(cwd, teammate.id)),
      );
      setTeammateChannelMembershipsByTeammate(Object.fromEntries(
        responses.map((response) => [response.teammateId, response.memberships]),
      ));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setTeammateChannelMembershipsLoading(false);
    }
  }

  async function addChannelTeammate(channelId: string, teammateId: string): Promise<void> {
    if (!channelId) {
      return;
    }
    const current = readTeammateChannelMembershipPayload(teammateId)
      .filter((membership) => membership.channelId !== channelId);
    await saveTeammateChannelMemberships(teammateId, [
      ...current,
      { channelId, isDefault: false },
    ]);
  }

  async function removeChannelTeammate(channelId: string, teammateId: string): Promise<void> {
    if (!channelId) {
      return;
    }
    const next = readTeammateChannelMembershipPayload(teammateId)
      .filter((membership) => membership.channelId !== channelId);
    await saveTeammateChannelMemberships(teammateId, next);
  }

  async function setDefaultChannelTeammate(channelId: string, teammateId: string): Promise<void> {
    if (!channelId) {
      return;
    }
    const current = readTeammateChannelMembershipPayload(teammateId);
    const hasMembership = current.some((membership) => membership.channelId === channelId);
    const next = current.map((membership) => ({
      ...membership,
      isDefault: membership.channelId === channelId,
    }));
    if (!hasMembership) {
      next.push({ channelId, isDefault: true });
    }
    await saveTeammateChannelMemberships(teammateId, next);
  }

  function readTeammateChannelMembershipPayload(teammateId: string): { readonly channelId: string; readonly isDefault?: boolean }[] {
    return (teammateChannelMembershipsByTeammate[teammateId] ?? []).map((membership) => ({
      channelId: membership.channelId,
      isDefault: membership.isDefault,
    }));
  }

  async function saveTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly { readonly channelId: string; readonly isDefault?: boolean }[],
  ): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      input.setErrorMessage("请输入 workspace path");
      return;
    }

    setChannelTeammateSavingId(teammateId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = await replaceTeammateChannels(cwd, teammateId, memberships);
      setTeammateChannelMembershipsByTeammate((current) => ({
        ...current,
        [teammateId]: response.memberships,
      }));
      await input.refreshChannels(cwd);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      throw caught;
    } finally {
      setChannelTeammateSavingId("");
    }
  }

  function resetForCwd(): void {
    setAiTeammates([]);
    setAiTeammatesLoading(false);
    setTeammateChannelMembershipsByTeammate({});
    setTeammateChannelMembershipsLoading(false);
    setChannelTeammateSavingId("");
    setError(undefined);
  }

  return {
    state: {
      aiTeammates,
      aiTeammatesLoading,
      teammateChannelMembershipsByTeammate,
      teammateChannelMembershipsLoading,
      channelTeammateSavingId,
    },
    actions: {
      refreshAiTeammates,
      refreshTeammateChannelMemberships,
      addAiTeammate,
      removeAiTeammate,
      hardDeleteAiTeammateAndRefresh,
      updateAiTeammateSettings,
      upsertAiTeammate: upsertAiTeammateAction,
      toggleAiTeammatePinned,
      toggleAiTeammateHidden,
      addChannelTeammate,
      removeChannelTeammate,
      setDefaultChannelTeammate,
      resetForCwd,
    },
    refresh: refreshAiTeammates,
    isLoading: aiTeammatesLoading || teammateChannelMembershipsLoading,
    error,
    clearError: () => setError(undefined),
  };
}

function upsertAiTeammate(current: readonly AiTeammate[], teammate: AiTeammate): readonly AiTeammate[] {
  const existingIndex = current.findIndex((item) => item.id === teammate.id);
  if (existingIndex < 0) {
    return [...current, teammate];
  }
  return current.map((item, index) => index === existingIndex ? teammate : item);
}

function toContractApprovalProfile(
  profile: BuiltinTeammateTemplate["approvalProfile"],
): CreateAiTeammateRequest["approvalProfile"] {
  return {
    mode: profile.mode,
    risk: profile.risk,
    requiredForTools: profile.requiredForTools?.filter(isContractToolName),
    requiredForActions: profile.requiredForActions?.filter(isContractApprovalAction),
  };
}

function toContractRoleKey(value: string): CreateAiTeammateRequest["roleKey"] {
  return (
    value === "product" ||
    value === "architect" ||
    value === "engineer" ||
    value === "designer" ||
    value === "qa" ||
    value === "security" ||
    value === "release" ||
    value === "docs" ||
    value === "custom"
  ) ? value : "custom";
}

function isContractToolName(value: string): value is NonNullable<CreateAiTeammateRequest["allowedTools"]>[number] {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

function isContractApprovalAction(
  value: string,
): value is NonNullable<CreateAiTeammateRequest["approvalProfile"]["requiredForActions"]>[number] {
  return (
    value === "write" ||
    value === "edit" ||
    value === "bash" ||
    value === "git_commit" ||
    value === "git_push" ||
    value === "external_send" ||
    value === "deploy" ||
    value === "media_cost" ||
    value === "credential_change" ||
    value === "provider_change"
  );
}
