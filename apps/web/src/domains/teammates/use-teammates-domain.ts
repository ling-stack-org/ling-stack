import { useRef, useState } from "react";
import {
  checkProvider,
  createAiTeammate,
  disableAiTeammate,
  hardDeleteAiTeammate,
  listAiTeammates,
  listTeammateChannels,
  listTeammateMemoryScopes,
  replaceTeammateChannels,
  replaceTeammateSkills,
  updateAiTeammate,
  uploadTeammateAvatar,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import { useLatestKeyedRequestGuard, useLatestRequestGuard } from "../../lib/use-latest-request.js";
import type {
  AiTeammate,
  CreateAiTeammateRequest,
  TeammateChannelMembership,
  UpdateAiTeammateRequest,
} from "../../types.js";
import type { TeammateCreateProgressEvent, TeammateCreateResult, TeammateCreateSetupStep } from "../../features/teammates/types.js";
import {
  latestTeammateListError,
  teammateActionErrorMessages,
  latestTeammateChannelRelationErrorByChannelId,
  teammateChannelRelationIdentity,
  useTeammateErrorController,
  type TeammateChannelRelationError,
  type TeammateChannelRelationAction,
  type TeammateMutationAction,
  type TeammateScopedError,
} from "./use-teammate-error-controller.js";

export interface TeammateCreateInput {
  readonly draftId?: string;
  readonly templateId?: string;
  readonly displayName: string;
  readonly description: string;
  readonly avatarTone?: string;
  readonly avatarFile?: File;
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
  readonly errors: readonly TeammateScopedError[];
  readonly listErrorMessage: string;
  readonly actionErrorMessagesByTeammateId: Readonly<Record<string, string>>;
  readonly channelRelationErrorByChannelId: Readonly<Record<string, TeammateChannelRelationError>>;
}

export interface TeammatesActions {
  readonly refreshAiTeammates: (cwd?: string) => Promise<void>;
  readonly refreshTeammateChannelMemberships: (cwd?: string, teammates?: readonly AiTeammate[]) => Promise<void>;
  readonly addAiTeammate: (input: TeammateCreateInput, onProgress?: (event: TeammateCreateProgressEvent) => void) => Promise<TeammateCreateResult>;
  readonly removeAiTeammate: (teammateId: string) => Promise<void>;
  readonly hardDeleteAiTeammateAndRefresh: (teammateId: string, reason?: string) => Promise<void>;
  readonly updateAiTeammateSettings: (
    teammateId: string,
    input: UpdateAiTeammateRequest,
    action?: TeammateMutationAction,
  ) => Promise<AiTeammate>;
  readonly upsertAiTeammate: (teammate: AiTeammate) => void;
  readonly toggleAiTeammatePinned: (teammateId: string) => Promise<void>;
  readonly toggleAiTeammateHidden: (teammateId: string) => Promise<void>;
  readonly archiveAiTeammate: (teammateId: string) => Promise<void>;
  readonly addChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly removeChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly setDefaultChannelTeammate: (channelId: string, teammateId: string) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type TeammatesController = DomainController<TeammatesState, TeammatesActions>;

export function useTeammatesDomain(input: {
  readonly cwd: string;
  readonly builtinTeammateTemplates: readonly BuiltinTeammateTemplate[];
  readonly t: (value: string, values?: Record<string, string | number>) => string;
  readonly closeTeammateIfActive: (teammateId: string) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
}): TeammatesController {
  const [aiTeammates, setAiTeammates] = useState<readonly AiTeammate[]>([]);
  const [aiTeammatesLoading, setAiTeammatesLoading] = useState(false);
  const [teammateChannelMembershipsByTeammate, setTeammateChannelMembershipsByTeammate] = useState<Readonly<Record<string, readonly TeammateChannelMembership[]>>>({});
  const [teammateChannelMembershipsLoading, setTeammateChannelMembershipsLoading] = useState(false);
  const [channelTeammateSavingId, setChannelTeammateSavingId] = useState("");
  const errorController = useTeammateErrorController();
  const listRequestGuard = useLatestRequestGuard();
  const membershipRequestGuard = useLatestRequestGuard();
  const mutationRequestGuard = useLatestKeyedRequestGuard();
  const channelRelationRequestGuard = useLatestKeyedRequestGuard();
  const createRequestGuard = useLatestKeyedRequestGuard();
  const workspaceEpochRef = useRef(0);
  const cwdRef = useRef(input.cwd.trim());
  const aiTeammatesRef = useRef(aiTeammates);
  const teammateChannelMembershipsRef = useRef(teammateChannelMembershipsByTeammate);
  const activeCreateIdentityRef = useRef("");
  cwdRef.current = input.cwd.trim();
  aiTeammatesRef.current = aiTeammates;
  teammateChannelMembershipsRef.current = teammateChannelMembershipsByTeammate;

  function isCurrentMutationRequest(
    cwd: string,
    workspaceEpoch: number,
    requestIdentity: string,
    requestToken: number,
  ): boolean {
    return cwdRef.current === cwd && workspaceEpochRef.current === workspaceEpoch &&
      mutationRequestGuard.isCurrent(requestIdentity, requestToken);
  }

  async function addAiTeammate(
    createInput: TeammateCreateInput,
    onProgress: (event: TeammateCreateProgressEvent) => void = () => undefined,
  ): Promise<TeammateCreateResult> {
    const cwd = input.cwd.trim();
    const draftIdentity = createInput.draftId?.trim() || "legacy-draft";
    const requestIdentity = JSON.stringify([cwd, draftIdentity]);
    const requestToken = createRequestGuard.next(requestIdentity);
    const workspaceEpoch = workspaceEpochRef.current;
    activeCreateIdentityRef.current = draftIdentity;
    const isCurrent = (): boolean => (
      activeCreateIdentityRef.current === draftIdentity &&
      cwdRef.current === cwd &&
      workspaceEpochRef.current === workspaceEpoch &&
      createRequestGuard.isCurrent(requestIdentity, requestToken)
    );
    const emit = (event: TeammateCreateProgressEvent): void => {
      if (isCurrent()) onProgress(event);
    };
    if (!cwd) {
      emit({ step: "workspace", state: "failed", message: input.t("Workspace is not ready.") });
      return { ok: false, message: input.t("Workspace is not ready.") };
    }

    emit({ step: "workspace", state: "running" });
    emit({ step: "workspace", state: "success", message: input.t("Workspace ready") });

    if (!createInput.providerPresetId) {
      const message = input.t("Choose a model before creating.");
      emit({ step: "model", state: "failed", message });
      return { ok: false, message };
    }

    const template = createInput.templateId ? input.builtinTeammateTemplates.find((item) => item.id === createInput.templateId) : undefined;
    const payload: CreateAiTeammateRequest = template
      ? {
        templateId: template.id,
        roleKey: toContractRoleKey(template.roleKey),
        displayName: createInput.displayName.trim() || template.name,
        description: createInput.description.trim() || template.summary,
        avatarTone: createInput.avatarTone,
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
        avatarTone: createInput.avatarTone,
        providerPresetId: createInput.providerPresetId,
        systemPrompt: `You are ${createInput.displayName.trim() || "a custom AI teammate"}. ${createInput.description.trim()}`,
        allowedTools: ["read", "grep", "find", "ls"],
        approvalProfile: { mode: "none" },
        status: "active",
      };

    setAiTeammatesLoading(true);
    try {
      emit({ step: "model", state: "running", message: input.t("Checking model") });
      const providerCheck = await checkProvider(cwd, createInput.providerPresetId);
      if (!isCurrent()) return staleCreateResult();
      if (!providerCheck.ok) {
        const message = input.t("Model check failed. Repair this model in Model Workbench.");
        emit({ step: "model", state: "failed", message: providerCheck.message || message });
        return { ok: false, message: providerCheck.message || message };
      }
      emit({ step: "model", state: "success", message: input.t("Model ready") });

      emit({ step: "record", state: "running", message: input.t("Creating teammate") });
      const response = await createAiTeammate(cwd, payload);
      if (!isCurrent()) return staleCreateResult();
      const teammateId = response.teammate.id;
      if (template && template.defaultSkillIds.length > 0) {
        await replaceTeammateSkills(
          cwd,
          teammateId,
          template.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
        );
        if (!isCurrent()) return staleCreateResult();
      }
      emit({ step: "record", state: "success", teammateId, message: input.t("Teammate created") });

      let partial = false;
      let partialMessage = "";
      if (createInput.avatarFile) {
        emit({ step: "avatar", state: "running", teammateId, message: input.t("Uploading avatar") });
        try {
          await uploadTeammateAvatar(cwd, teammateId, createInput.avatarFile);
          if (!isCurrent()) return staleCreateResult();
          emit({ step: "avatar", state: "success", teammateId, message: input.t("Avatar uploaded") });
        } catch (caught) {
          if (!isCurrent()) return staleCreateResult();
          partial = true;
          partialMessage = caught instanceof Error ? caught.message : String(caught);
          emit({ step: "avatar", state: "failed", teammateId, partial: true, message: partialMessage || input.t("Avatar setup needs attention") });
        }
      } else {
        emit({ step: "avatar", state: "skipped", teammateId, message: input.t("No avatar selected") });
      }

      if (createInput.channelIds.length > 0) {
        emit({ step: "channels", state: "running", teammateId, message: input.t("Joining channel") });
        try {
          await replaceTeammateChannels(
            cwd,
            teammateId,
            createInput.channelIds.map((channelId, index) => ({ channelId, isDefault: index === 0 })),
          );
          if (!isCurrent()) return staleCreateResult();
          emit({ step: "channels", state: "success", teammateId, message: input.t("Channel joined") });
        } catch (caught) {
          if (!isCurrent()) return staleCreateResult();
          partial = true;
          partialMessage = caught instanceof Error ? caught.message : String(caught);
          emit({ step: "channels", state: "failed", teammateId, partial: true, message: partialMessage || input.t("Channel setup needs attention") });
        }
      } else {
        emit({ step: "channels", state: "skipped", teammateId, message: input.t("No channel selected") });
      }

      emit({ step: "memory", state: "running", teammateId, message: input.t("Preparing memory") });
      try {
        await listTeammateMemoryScopes(cwd, teammateId);
        if (!isCurrent()) return staleCreateResult();
        emit({ step: "memory", state: "success", teammateId, message: input.t("Memory ready") });
      } catch (caught) {
        if (!isCurrent()) return staleCreateResult();
        partial = true;
        partialMessage ||= caught instanceof Error ? caught.message : String(caught);
        emit({ step: "memory", state: "failed", teammateId, partial: true, message: partialMessage || input.t("Memory setup needs attention") });
      }

      emit({ step: "refresh", state: "running", teammateId, message: input.t("Refreshing workspace") });
      try {
        await refreshAiTeammates(cwd);
        if (!isCurrent()) return staleCreateResult();
        emit({ step: "refresh", state: "success", teammateId, partial, message: partial ? input.t("Teammate created with setup warnings") : input.t("Teammate ready") });
      } catch (caught) {
        if (!isCurrent()) return staleCreateResult();
        partial = true;
        partialMessage ||= caught instanceof Error ? caught.message : String(caught);
        emit({ step: "refresh", state: "failed", teammateId, partial: true, message: partialMessage || input.t("Refresh failed. Open teammate management to review.") });
      }

      return {
        ok: !partial,
        teammateId,
        partial,
        message: partial ? partialMessage || input.t("Teammate created with setup warnings") : input.t("Teammate ready"),
      };
    } catch (caught) {
      if (!isCurrent()) return staleCreateResult();
      const message = caught instanceof Error ? caught.message : String(caught);
      emit({ step: inferFailedCreateStep(message), state: "failed", message });
      return { ok: false, message };
    } finally {
      if (isCurrent()) setAiTeammatesLoading(false);
    }
  }

  async function removeAiTeammate(teammateId: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      const message = "本地工作区未就绪";
      errorController.report({ surface: "teammate", identity: teammateId, action: "disable", scope: "validation" }, message);
      throw new Error(message);
    }
    const requestIdentity = teammateMutationIdentity(cwd, teammateId, "disable");
    const requestToken = mutationRequestGuard.next(requestIdentity);
    const workspaceEpoch = workspaceEpochRef.current;
    errorController.clear("teammate", teammateId, "disable");
    try {
      await disableAiTeammate(cwd, teammateId);
      if (!isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) return;
      await refreshAiTeammates(cwd);
      if (!isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) return;
      input.closeTeammateIfActive(teammateId);
    } catch (caught) {
      if (isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        errorController.report({ surface: "teammate", identity: teammateId, action: "disable", scope: "mutation" }, caught);
      }
      throw caught;
    }
  }

  async function hardDeleteAiTeammateAndRefresh(teammateId: string, reason?: string): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      const message = "本地工作区未就绪";
      errorController.report({ surface: "teammate", identity: teammateId, action: "hard-delete", scope: "validation" }, message);
      throw new Error(message);
    }
    const requestIdentity = teammateMutationIdentity(cwd, teammateId, "hard-delete");
    const requestToken = mutationRequestGuard.next(requestIdentity);
    const workspaceEpoch = workspaceEpochRef.current;
    errorController.clear("teammate", teammateId, "hard-delete");
    try {
      await hardDeleteAiTeammate(cwd, teammateId, reason);
      if (!isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) return;
      await refreshAiTeammates(cwd);
      if (!isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) return;
      input.closeTeammateIfActive(teammateId);
    } catch (caught) {
      if (isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        errorController.report({ surface: "teammate", identity: teammateId, action: "hard-delete", scope: "mutation" }, caught);
      }
      throw caught;
    }
  }

  async function updateAiTeammateSettings(
    teammateId: string,
    updateInput: UpdateAiTeammateRequest,
    action: TeammateMutationAction = "update",
  ): Promise<AiTeammate> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      const message = "本地工作区未就绪";
      errorController.report({ surface: "teammate", identity: teammateId, action, scope: "validation" }, message);
      throw new Error(message);
    }
    const requestIdentity = teammateMutationIdentity(cwd, teammateId, action);
    const requestToken = mutationRequestGuard.next(requestIdentity);
    const workspaceEpoch = workspaceEpochRef.current;
    setAiTeammatesLoading(true);
    errorController.clear("teammate", teammateId, action);
    try {
      const response = await updateAiTeammate(cwd, teammateId, updateInput);
      if (isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        setAiTeammates((current) => upsertAiTeammate(current, response.teammate));
        void refreshAiTeammates(cwd);
      }
      return response.teammate;
    } catch (caught) {
      if (isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        errorController.report({ surface: "teammate", identity: teammateId, action, scope: "mutation" }, caught);
      }
      throw caught;
    } finally {
      if (isCurrentMutationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        setAiTeammatesLoading(false);
      }
    }
  }

  async function toggleAiTeammatePinned(teammateId: string): Promise<void> {
    const teammate = aiTeammatesRef.current.find((item) => item.id === teammateId);
    if (teammate) {
      await updateAiTeammateSettings(teammateId, { pinned: !teammate.pinned }, "pin");
    }
  }

  async function toggleAiTeammateHidden(teammateId: string): Promise<void> {
    const teammate = aiTeammatesRef.current.find((item) => item.id === teammateId);
    if (teammate) {
      await updateAiTeammateSettings(teammateId, { hidden: !teammate.hidden }, "visibility");
    }
  }

  async function archiveAiTeammate(teammateId: string): Promise<void> {
    const teammate = aiTeammatesRef.current.find((item) => item.id === teammateId);
    if (!teammate || teammate.hidden || teammate.status === "disabled") {
      return;
    }
    await updateAiTeammateSettings(teammateId, { hidden: true }, "archive");
    input.closeTeammateIfActive(teammateId);
  }

  function upsertAiTeammateAction(teammate: AiTeammate): void {
    setAiTeammates((current) => upsertAiTeammate(current, teammate));
  }

  async function refreshAiTeammates(cwd = input.cwd.trim()): Promise<void> {
    if (!cwd) {
      setAiTeammates([]);
      setTeammateChannelMembershipsByTeammate({});
      aiTeammatesRef.current = [];
      teammateChannelMembershipsRef.current = {};
      errorController.clear("list", "workspace");
      return;
    }

    const requestToken = listRequestGuard.next();
    const workspaceEpoch = workspaceEpochRef.current;
    setAiTeammatesLoading(true);
    errorController.clear("list", "workspace", "load");
    try {
      const response = await listAiTeammates(cwd);
      if (!isCurrentListRequest(cwd, workspaceEpoch, requestToken)) return;
      aiTeammatesRef.current = response.teammates;
      setAiTeammates(response.teammates);
      await refreshTeammateChannelMemberships(cwd, response.teammates);
    } catch (caught) {
      if (isCurrentListRequest(cwd, workspaceEpoch, requestToken)) {
        errorController.report({ surface: "list", identity: "workspace", action: "load", scope: "load" }, caught);
      }
    } finally {
      if (isCurrentListRequest(cwd, workspaceEpoch, requestToken)) setAiTeammatesLoading(false);
    }
  }

  function isCurrentListRequest(cwd: string, workspaceEpoch: number, requestToken: number): boolean {
    return cwdRef.current === cwd && workspaceEpochRef.current === workspaceEpoch &&
      listRequestGuard.isCurrent(requestToken);
  }

  async function refreshTeammateChannelMemberships(
    cwd = input.cwd.trim(),
    teammates = aiTeammatesRef.current,
  ): Promise<void> {
    if (!cwd || teammates.length === 0) {
      teammateChannelMembershipsRef.current = {};
      setTeammateChannelMembershipsByTeammate({});
      errorController.clear("list", "workspace", "load-memberships");
      return;
    }

    const requestToken = membershipRequestGuard.next();
    const workspaceEpoch = workspaceEpochRef.current;
    setTeammateChannelMembershipsLoading(true);
    errorController.clear("list", "workspace", "load-memberships");
    try {
      const responses = await Promise.all(
        teammates.map((teammate) => listTeammateChannels(cwd, teammate.id)),
      );
      if (!isCurrentMembershipRequest(cwd, workspaceEpoch, requestToken)) return;
      const memberships = Object.fromEntries(
        responses.map((response) => [response.teammateId, response.memberships]),
      );
      teammateChannelMembershipsRef.current = memberships;
      setTeammateChannelMembershipsByTeammate(memberships);
    } catch (caught) {
      if (isCurrentMembershipRequest(cwd, workspaceEpoch, requestToken)) {
        errorController.report({ surface: "list", identity: "workspace", action: "load-memberships", scope: "load" }, caught);
      }
    } finally {
      if (isCurrentMembershipRequest(cwd, workspaceEpoch, requestToken)) {
        setTeammateChannelMembershipsLoading(false);
      }
    }
  }

  function isCurrentMembershipRequest(cwd: string, workspaceEpoch: number, requestToken: number): boolean {
    return cwdRef.current === cwd && workspaceEpochRef.current === workspaceEpoch &&
      membershipRequestGuard.isCurrent(requestToken);
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
    ], channelId, "add");
  }

  async function removeChannelTeammate(channelId: string, teammateId: string): Promise<void> {
    if (!channelId) {
      return;
    }
    const next = readTeammateChannelMembershipPayload(teammateId)
      .filter((membership) => membership.channelId !== channelId);
    await saveTeammateChannelMemberships(teammateId, next, channelId, "remove");
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
    await saveTeammateChannelMemberships(teammateId, next, channelId, "set-default");
  }

  function readTeammateChannelMembershipPayload(teammateId: string): { readonly channelId: string; readonly isDefault?: boolean }[] {
    return (teammateChannelMembershipsRef.current[teammateId] ?? []).map((membership) => ({
      channelId: membership.channelId,
      isDefault: membership.isDefault,
    }));
  }

  async function saveTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly { readonly channelId: string; readonly isDefault?: boolean }[],
    channelId: string,
    action: TeammateChannelRelationAction,
  ): Promise<void> {
    const cwd = input.cwd.trim();
    const relationshipIdentity = teammateChannelRelationIdentity(channelId, teammateId);
    if (!cwd) {
      const message = "请输入 workspace path";
      errorController.report({ surface: "channel-relation", identity: relationshipIdentity, action, scope: "validation" }, message);
      throw new Error(message);
    }

    const requestIdentity = JSON.stringify([cwd, relationshipIdentity, action]);
    const requestToken = channelRelationRequestGuard.next(requestIdentity);
    const workspaceEpoch = workspaceEpochRef.current;
    setChannelTeammateSavingId(teammateId);
    errorController.clear("channel-relation", relationshipIdentity, action);
    try {
      const response = await replaceTeammateChannels(cwd, teammateId, memberships);
      if (!isCurrentChannelRelationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) return;
      const nextMemberships = {
        ...teammateChannelMembershipsRef.current,
        [teammateId]: response.memberships,
      };
      teammateChannelMembershipsRef.current = nextMemberships;
      setTeammateChannelMembershipsByTeammate((current) => ({
        ...current,
        [teammateId]: response.memberships,
      }));
      await input.refreshChannels(cwd);
      if (isCurrentChannelRelationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        errorController.clear("channel-relation", relationshipIdentity, action);
      }
    } catch (caught) {
      if (isCurrentChannelRelationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        errorController.report({ surface: "channel-relation", identity: relationshipIdentity, action, scope: "mutation" }, caught);
      }
      throw caught;
    } finally {
      if (isCurrentChannelRelationRequest(cwd, workspaceEpoch, requestIdentity, requestToken)) {
        setChannelTeammateSavingId("");
      }
    }
  }

  function isCurrentChannelRelationRequest(
    cwd: string,
    workspaceEpoch: number,
    requestIdentity: string,
    requestToken: number,
  ): boolean {
    return cwdRef.current === cwd && workspaceEpochRef.current === workspaceEpoch &&
      channelRelationRequestGuard.isCurrent(requestIdentity, requestToken);
  }

  function resetForCwd(): void {
    workspaceEpochRef.current += 1;
    listRequestGuard.next();
    membershipRequestGuard.next();
    mutationRequestGuard.reset();
    channelRelationRequestGuard.reset();
    createRequestGuard.reset();
    activeCreateIdentityRef.current = "";
    aiTeammatesRef.current = [];
    teammateChannelMembershipsRef.current = {};
    setAiTeammates([]);
    setAiTeammatesLoading(false);
    setTeammateChannelMembershipsByTeammate({});
    setTeammateChannelMembershipsLoading(false);
    setChannelTeammateSavingId("");
    errorController.reset();
  }

  const listError = latestTeammateListError(errorController.entries);
  const actionErrorMessagesByTeammateId = teammateActionErrorMessages(errorController.entries);
  const channelRelationErrorByChannelId = latestTeammateChannelRelationErrorByChannelId(errorController.entries);
  const error: DomainError | undefined = listError ? { scope: "load", message: listError.message } : undefined;

  return {
    state: {
      aiTeammates,
      aiTeammatesLoading,
      teammateChannelMembershipsByTeammate,
      teammateChannelMembershipsLoading,
      channelTeammateSavingId,
      errors: errorController.entries,
      listErrorMessage: listError?.message ?? "",
      actionErrorMessagesByTeammateId,
      channelRelationErrorByChannelId,
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
      archiveAiTeammate,
      addChannelTeammate,
      removeChannelTeammate,
      setDefaultChannelTeammate,
      resetForCwd,
    },
    refresh: refreshAiTeammates,
    isLoading: aiTeammatesLoading || teammateChannelMembershipsLoading,
    error,
    clearError: () => {
      if (listError) errorController.clear(listError.surface, listError.identity, listError.action);
    },
  };
}

function staleCreateResult(): TeammateCreateResult {
  return { ok: false, stale: true };
}

function teammateMutationIdentity(cwd: string, teammateId: string, action: TeammateMutationAction): string {
  return JSON.stringify([cwd, teammateId, action]);
}

function inferFailedCreateStep(message: string): TeammateCreateSetupStep {
  const normalized = message.toLocaleLowerCase();
  if (normalized.includes("provider") || normalized.includes("model") || normalized.includes("api key")) {
    return "model";
  }
  if (normalized.includes("channel")) {
    return "channels";
  }
  if (normalized.includes("avatar") || normalized.includes("image") || normalized.includes("attachment")) {
    return "avatar";
  }
  if (normalized.includes("memory")) {
    return "memory";
  }
  return "record";
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
