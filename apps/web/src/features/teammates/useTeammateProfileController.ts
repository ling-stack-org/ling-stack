import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  createTeammatePersonaDraft,
  deleteTeammateAvatar,
  uploadTeammateAvatar,
} from "../../api.js";
import { useI18n } from "../../i18n.js";
import {
  imageDataUrlToFile,
  readImageFileDataUrl,
  useLingToast,
} from "../../shared/ui/index.js";
import type {
  AiTeammate,
  TeammatePersonaDraft,
  UpdateAiTeammateRequest,
} from "../../types.js";
import {
  splitAdditionalInstructions,
  teammateToSettingsForm,
  type TeammateSettingsForm,
} from "./teammate-workspace-utils.js";
import type { TeammateUpdateAction } from "./types.js";
import { useTeammateAsyncRequestOwner } from "./useTeammateAsyncRequestOwner.js";

export interface PersonaImportForm {
  readonly sourcePath: string;
  readonly content: string;
}

export interface TeammateProfileController {
  readonly avatarCropSource?: string;
  readonly avatarTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly importingPersona: boolean;
  readonly personaBusyAction: "" | "apply" | "preview";
  readonly personaDraft?: TeammatePersonaDraft;
  readonly personaError: string;
  readonly personaImportForm: PersonaImportForm;
  readonly profileDirty: boolean;
  readonly profileError: string;
  readonly savingProfile: boolean;
  readonly uploadingAvatar: boolean;
  readonly applyPersonaDraft: () => Promise<boolean>;
  readonly cancelAvatarCrop: () => void;
  readonly confirmAvatarCrop: (dataUrl: string) => Promise<void>;
  readonly previewPersonaImport: () => Promise<void>;
  readonly removeAvatar: () => Promise<void>;
  readonly resetProfile: () => void;
  readonly saveProfile: () => Promise<void>;
  readonly selectAvatarFile: (file?: File) => Promise<void>;
  readonly setPersonaImportForm: (form: PersonaImportForm) => void;
}

export function useTeammateProfileController({
  cwd,
  teammate,
  settingsForm,
  setSettingsForm,
  isProtectedSystemTeammate,
  onUpdateTeammate,
  onTeammateUpdated,
  onRefreshTeammates,
}: {
  readonly cwd: string;
  readonly teammate: AiTeammate;
  readonly settingsForm: TeammateSettingsForm;
  readonly setSettingsForm: Dispatch<SetStateAction<TeammateSettingsForm>>;
  readonly isProtectedSystemTeammate: boolean;
  readonly onUpdateTeammate: (
    teammateId: string,
    input: UpdateAiTeammateRequest,
    action?: TeammateUpdateAction,
  ) => Promise<AiTeammate>;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
  readonly onRefreshTeammates?: () => void | Promise<void>;
}): TeammateProfileController {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const avatarTriggerRef = useRef<HTMLButtonElement>(null);
  const avatarFileNameRef = useRef("avatar.png");
  const requestOwner = useTeammateAsyncRequestOwner<"avatar" | "persona" | "profile">(
    teammate.id,
    JSON.stringify([cwd.trim(), teammate.id]),
  );
  const [avatarCropSource, setAvatarCropSource] = useState<string>();
  const [personaImportForm, setPersonaImportForm] = useState<PersonaImportForm>({ sourcePath: "", content: "" });
  const [personaDraft, setPersonaDraft] = useState<TeammatePersonaDraft>();
  const [personaBusyAction, setPersonaBusyAction] = useState<"" | "apply" | "preview">("");
  const importingPersona = Boolean(personaBusyAction);
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const personaError = requestOwner.latestError?.action === "persona" ? requestOwner.latestError.message : "";
  const profileError = requestOwner.latestError?.action === "persona" ? "" : requestOwner.latestError?.message ?? "";
  const profileDirty = isProfileDirty(teammate, settingsForm, isProtectedSystemTeammate);

  useEffect(() => {
    setAvatarCropSource(undefined);
    setPersonaImportForm({ sourcePath: "", content: "" });
    setPersonaDraft(undefined);
    setPersonaBusyAction("");
    setSavingProfile(false);
    setUploadingAvatar(false);
  }, [teammate.id]);

  function focusAvatarTrigger(): void {
    window.requestAnimationFrame(() => avatarTriggerRef.current?.focus({ preventScroll: true }));
  }

  function cancelAvatarCrop(): void {
    setAvatarCropSource(undefined);
    focusAvatarTrigger();
  }

  async function selectAvatarFile(file?: File): Promise<void> {
    if (!file || uploadingAvatar) return;
    if (!file.type.startsWith("image/")) {
      requestOwner.reportImmediate("avatar", t("Choose an image file"));
      return;
    }
    const operation = requestOwner.begin("avatar");
    if (!requestOwner.isActionCurrent(operation)) return;
    try {
      avatarFileNameRef.current = file.name;
      const dataUrl = await readImageFileDataUrl(file);
      if (!requestOwner.isActionCurrent(operation)) return;
      setAvatarCropSource(dataUrl);
      requestOwner.clearError(operation);
    } catch {
      requestOwner.reportError(operation, t("The image could not be opened. Choose another file."));
    }
  }

  async function confirmAvatarCrop(dataUrl: string): Promise<void> {
    if (uploadingAvatar) return;
    const operation = requestOwner.begin("avatar");
    if (!requestOwner.isActionCurrent(operation)) return;
    setUploadingAvatar(true);
    try {
      const response = await uploadTeammateAvatar(
        cwd.trim(),
        teammate.id,
        imageDataUrlToFile(dataUrl, avatarFileNameRef.current),
      );
      if (!requestOwner.isActionCurrent(operation)) return;
      onTeammateUpdated?.(response.teammate);
      await onRefreshTeammates?.();
      if (!requestOwner.isActionCurrent(operation)) return;
      setAvatarCropSource(undefined);
      requestOwner.clearError(operation);
      showToast({
        message: t("Avatar updated"),
        scope: `teammate:profile:${operation.teammateId}:avatar`,
        tone: "success",
      });
      focusAvatarTrigger();
    } catch {
      if (!requestOwner.isActionCurrent(operation)) return;
      const message = t("Avatar changes were not saved. Try again.");
      requestOwner.reportError(operation, message);
      throw new Error(message);
    } finally {
      if (requestOwner.isActionCurrent(operation)) setUploadingAvatar(false);
    }
  }

  async function removeAvatar(): Promise<void> {
    if (uploadingAvatar || !teammate.avatarImageAttachmentId) return;
    const operation = requestOwner.begin("avatar");
    if (!requestOwner.isActionCurrent(operation)) return;
    setUploadingAvatar(true);
    try {
      const response = await deleteTeammateAvatar(cwd.trim(), teammate.id);
      if (!requestOwner.isActionCurrent(operation)) return;
      onTeammateUpdated?.(response.teammate ?? { ...teammate, avatarImageAttachmentId: undefined });
      await onRefreshTeammates?.();
      if (!requestOwner.isActionCurrent(operation)) return;
      requestOwner.clearError(operation);
      showToast({
        message: t("Avatar removed"),
        scope: `teammate:profile:${operation.teammateId}:avatar`,
        tone: "success",
      });
    } catch {
      requestOwner.reportError(operation, t("Avatar changes were not saved. Try again."));
    } finally {
      if (requestOwner.isActionCurrent(operation)) setUploadingAvatar(false);
    }
  }

  function resetProfile(): void {
    const authoritative = teammateToSettingsForm(teammate);
    setSettingsForm((current) => ({
      ...current,
      displayName: authoritative.displayName,
      description: authoritative.description,
      status: authoritative.status,
      pinned: authoritative.pinned,
      hidden: authoritative.hidden,
      systemPrompt: authoritative.systemPrompt,
      appendSystemPromptText: authoritative.appendSystemPromptText,
    }));
    setPersonaDraft(undefined);
    requestOwner.clearActionError("profile");
  }

  async function saveProfile(): Promise<void> {
    if (!profileDirty || savingProfile) return;
    const operation = requestOwner.begin("profile");
    if (!requestOwner.isActionCurrent(operation)) return;
    setSavingProfile(true);
    try {
      const updated = await onUpdateTeammate(teammate.id, profileUpdateInput(
        teammate,
        settingsForm,
        isProtectedSystemTeammate,
      ), "profile-save");
      if (!requestOwner.isActionCurrent(operation)) return;
      setSettingsForm((current) => ({
        ...teammateToSettingsForm(updated),
        modelBindingMode: current.modelBindingMode,
        providerPresetId: current.providerPresetId,
      }));
      onTeammateUpdated?.(updated);
      requestOwner.clearError(operation);
      showToast({
        message: t("Teammate profile saved"),
        scope: `teammate:profile:${operation.teammateId}:save`,
        tone: "success",
      });
    } catch {
      requestOwner.reportError(operation, t("Profile changes were not saved. Try again."));
    } finally {
      if (requestOwner.isActionCurrent(operation)) setSavingProfile(false);
    }
  }

  async function previewPersonaImport(): Promise<void> {
    if (isProtectedSystemTeammate || importingPersona) return;
    if (!personaImportForm.content.trim()) {
      requestOwner.reportImmediate("persona", t("Paste persona content first"));
      return;
    }
    const operation = requestOwner.begin("persona");
    if (!requestOwner.isActionCurrent(operation)) return;
    setPersonaBusyAction("preview");
    try {
      const response = await createTeammatePersonaDraft(cwd.trim(), teammate.id, {
        content: personaImportForm.content,
        sourcePath: personaImportForm.sourcePath.trim() || undefined,
      });
      if (!requestOwner.isActionCurrent(operation)) return;
      setPersonaDraft(response.draft);
      requestOwner.clearError(operation);
    } catch {
      requestOwner.reportError(operation, t("Persona draft could not be prepared. Try again."));
    } finally {
      if (requestOwner.isActionCurrent(operation)) setPersonaBusyAction("");
    }
  }

  async function applyPersonaDraft(): Promise<boolean> {
    if (!personaDraft || importingPersona || isProtectedSystemTeammate) return false;
    const operation = requestOwner.begin("persona");
    if (!requestOwner.isActionCurrent(operation)) return false;
    setPersonaBusyAction("apply");
    try {
      setSettingsForm((current) => ({
        ...current,
        displayName: personaDraft.displayName.trim() || teammate.displayName,
        description: personaDraft.description.trim(),
        systemPrompt: personaDraft.systemPrompt,
      }));
      setPersonaDraft(undefined);
      setPersonaImportForm({ sourcePath: "", content: "" });
      requestOwner.clearError(operation);
      return true;
    } finally {
      if (requestOwner.isActionCurrent(operation)) setPersonaBusyAction("");
    }
  }

  function updatePersonaImportForm(form: PersonaImportForm): void {
    setPersonaImportForm(form);
    setPersonaDraft(undefined);
    requestOwner.clearActionError("persona");
  }

  return {
    avatarCropSource,
    avatarTriggerRef,
    importingPersona,
    personaBusyAction,
    personaDraft,
    personaError,
    personaImportForm,
    profileDirty,
    profileError,
    savingProfile,
    uploadingAvatar,
    applyPersonaDraft,
    cancelAvatarCrop,
    confirmAvatarCrop,
    previewPersonaImport,
    removeAvatar,
    resetProfile,
    saveProfile,
    selectAvatarFile,
    setPersonaImportForm: updatePersonaImportForm,
  };
}

function profileUpdateInput(
  teammate: AiTeammate,
  form: TeammateSettingsForm,
  isProtected: boolean,
): UpdateAiTeammateRequest {
  if (isProtected) {
    return {
      displayName: form.displayName.trim() || teammate.displayName,
      description: form.description.trim(),
      appendSystemPrompt: splitAdditionalInstructions(form.appendSystemPromptText),
    };
  }
  return {
    displayName: form.displayName.trim() || teammate.displayName,
    description: form.description.trim(),
    status: form.status,
    pinned: form.pinned,
    hidden: form.hidden,
    systemPrompt: form.systemPrompt.trim() || null,
  };
}

function isProfileDirty(
  teammate: AiTeammate,
  form: TeammateSettingsForm,
  isProtected: boolean,
): boolean {
  const current = teammateToSettingsForm(teammate);
  if (
    form.displayName.trim() !== current.displayName ||
    form.description.trim() !== current.description
  ) return true;
  if (isProtected) return form.appendSystemPromptText.trim() !== current.appendSystemPromptText;
  return form.status !== current.status ||
    form.pinned !== current.pinned ||
    form.hidden !== current.hidden ||
    form.systemPrompt.trim() !== current.systemPrompt;
}
