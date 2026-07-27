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

export interface PersonaImportForm {
  readonly sourcePath: string;
  readonly content: string;
}

export interface TeammateProfileController {
  readonly avatarCropSource?: string;
  readonly avatarTriggerRef: RefObject<HTMLButtonElement>;
  readonly importingPersona: boolean;
  readonly personaDraft?: TeammatePersonaDraft;
  readonly personaImportForm: PersonaImportForm;
  readonly profileDirty: boolean;
  readonly profileError: string;
  readonly savingProfile: boolean;
  readonly uploadingAvatar: boolean;
  readonly applyPersonaDraft: () => Promise<void>;
  readonly cancelAvatarCrop: () => void;
  readonly confirmAvatarCrop: (dataUrl: string) => Promise<void>;
  readonly previewPersonaImport: () => Promise<void>;
  readonly removeAvatar: () => Promise<void>;
  readonly resetProfile: () => void;
  readonly saveProfile: () => Promise<void>;
  readonly selectAvatarFile: (file?: File) => Promise<void>;
  readonly setPersonaImportForm: Dispatch<SetStateAction<PersonaImportForm>>;
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
  readonly onUpdateTeammate: (teammateId: string, input: UpdateAiTeammateRequest) => Promise<AiTeammate>;
  readonly onTeammateUpdated?: (teammate: AiTeammate) => void;
  readonly onRefreshTeammates?: () => void | Promise<void>;
}): TeammateProfileController {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const avatarTriggerRef = useRef<HTMLButtonElement>(null);
  const avatarFileNameRef = useRef("avatar.png");
  const [avatarCropSource, setAvatarCropSource] = useState<string>();
  const [personaImportForm, setPersonaImportForm] = useState<PersonaImportForm>({ sourcePath: "", content: "" });
  const [personaDraft, setPersonaDraft] = useState<TeammatePersonaDraft>();
  const [importingPersona, setImportingPersona] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [profileError, setProfileError] = useState("");
  const profileDirty = isProfileDirty(teammate, settingsForm, isProtectedSystemTeammate);

  useEffect(() => {
    setAvatarCropSource(undefined);
    setPersonaImportForm({ sourcePath: "", content: "" });
    setPersonaDraft(undefined);
    setProfileError("");
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
      setProfileError(t("Choose an image file"));
      return;
    }
    try {
      avatarFileNameRef.current = file.name;
      setAvatarCropSource(await readImageFileDataUrl(file));
      setProfileError("");
    } catch {
      setProfileError(t("The image could not be opened. Choose another file."));
    }
  }

  async function confirmAvatarCrop(dataUrl: string): Promise<void> {
    if (uploadingAvatar) return;
    setUploadingAvatar(true);
    setProfileError("");
    try {
      const response = await uploadTeammateAvatar(
        cwd.trim(),
        teammate.id,
        imageDataUrlToFile(dataUrl, avatarFileNameRef.current),
      );
      onTeammateUpdated?.(response.teammate);
      await onRefreshTeammates?.();
      setAvatarCropSource(undefined);
      showToast({
        message: t("Avatar updated"),
        scope: `teammate:profile:${teammate.id}:avatar`,
        tone: "success",
      });
      focusAvatarTrigger();
    } catch {
      const message = t("Avatar changes were not saved. Try again.");
      setProfileError(message);
      throw new Error(message);
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function removeAvatar(): Promise<void> {
    if (uploadingAvatar || !teammate.avatarImageAttachmentId) return;
    setUploadingAvatar(true);
    setProfileError("");
    try {
      const response = await deleteTeammateAvatar(cwd.trim(), teammate.id);
      onTeammateUpdated?.(response.teammate ?? { ...teammate, avatarImageAttachmentId: undefined });
      await onRefreshTeammates?.();
      showToast({
        message: t("Avatar removed"),
        scope: `teammate:profile:${teammate.id}:avatar`,
        tone: "success",
      });
    } catch {
      setProfileError(t("Avatar changes were not saved. Try again."));
    } finally {
      setUploadingAvatar(false);
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
    setProfileError("");
  }

  async function saveProfile(): Promise<void> {
    if (!profileDirty || savingProfile) return;
    setSavingProfile(true);
    setProfileError("");
    try {
      const updated = await onUpdateTeammate(teammate.id, profileUpdateInput(
        teammate,
        settingsForm,
        isProtectedSystemTeammate,
      ));
      setSettingsForm((current) => ({
        ...teammateToSettingsForm(updated),
        providerPresetId: current.providerPresetId,
      }));
      onTeammateUpdated?.(updated);
      showToast({
        message: t("Teammate profile saved"),
        scope: `teammate:profile:${teammate.id}:save`,
        tone: "success",
      });
    } catch {
      setProfileError(t("Profile changes were not saved. Try again."));
    } finally {
      setSavingProfile(false);
    }
  }

  async function previewPersonaImport(): Promise<void> {
    if (isProtectedSystemTeammate || importingPersona) return;
    if (!personaImportForm.content.trim()) {
      setProfileError(t("Paste persona content first"));
      return;
    }
    setImportingPersona(true);
    setProfileError("");
    try {
      const response = await createTeammatePersonaDraft(cwd.trim(), teammate.id, {
        content: personaImportForm.content,
        sourcePath: personaImportForm.sourcePath.trim() || undefined,
      });
      setPersonaDraft(response.draft);
    } catch {
      setProfileError(t("Persona draft could not be prepared. Try again."));
    } finally {
      setImportingPersona(false);
    }
  }

  async function applyPersonaDraft(): Promise<void> {
    if (!personaDraft || importingPersona || isProtectedSystemTeammate) return;
    setImportingPersona(true);
    setProfileError("");
    try {
      const updated = await onUpdateTeammate(teammate.id, {
        displayName: personaDraft.displayName.trim() || teammate.displayName,
        description: personaDraft.description.trim(),
        systemPrompt: personaDraft.systemPrompt.trim() || null,
        appendSystemPrompt: personaDraft.appendSystemPrompt,
      });
      setSettingsForm((current) => ({
        ...teammateToSettingsForm(updated),
        providerPresetId: current.providerPresetId,
      }));
      onTeammateUpdated?.(updated);
      setPersonaDraft(undefined);
      setPersonaImportForm({ sourcePath: "", content: "" });
      showToast({
        message: t("Persona applied"),
        scope: `teammate:profile:${teammate.id}:persona`,
        tone: "success",
      });
    } catch {
      setProfileError(t("Persona changes were not saved. Try again."));
    } finally {
      setImportingPersona(false);
    }
  }

  return {
    avatarCropSource,
    avatarTriggerRef,
    importingPersona,
    personaDraft,
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
    setPersonaImportForm,
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
