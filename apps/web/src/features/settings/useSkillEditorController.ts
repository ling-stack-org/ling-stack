import { useMemo, useState } from "react";
import { LingDaemonError } from "@ling-stack/api-client";
import {
  createSkillCandidateDraft,
  createSkillImportDraft,
  previewSkillImport,
  previewSkillRevision,
  publishSkillImportDraft,
  publishSkillRevision,
} from "../../api.js";
import type {
  SkillImportDraft,
  SkillRegistryEntry,
  SkillRevisionPreview,
} from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  emptySkillEditorSeed,
  isEvolvedSkillEntry,
  skillEditableDefinitionFromForm,
  skillEditorFingerprint,
  skillEditorImportRequest,
  skillEditorSeedFromDraft,
  skillEditorSeedFromSkill,
  type SkillEditorForm,
  type SkillEditorMode,
  type SkillEditorPreservedDefinition,
} from "./skill-editor-utils.js";
import { skillImportBlockingWarningCodes, skillImportHasBlockingWarnings } from "./skill-import-utils.js";

export type SkillEditorBusyState = "" | "checking" | "saving";

export interface SkillEditorCompletedResult {
  readonly skills: readonly SkillRegistryEntry[];
  readonly candidateId?: string;
  readonly mode: SkillEditorMode;
}

export function useSkillEditorController({
  cwd,
  onCompleted,
  onSuccess,
  t,
}: {
  readonly cwd: string;
  readonly onCompleted: (result: SkillEditorCompletedResult) => Promise<void>;
  readonly onSuccess: (message: string) => void;
  readonly t: SettingsTranslator;
}) {
  const emptySeed = useMemo(emptySkillEditorSeed, []);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SkillEditorMode>("create");
  const [form, setFormState] = useState<SkillEditorForm>(emptySeed.form);
  const [preserved, setPreserved] = useState<SkillEditorPreservedDefinition>(emptySeed.preserved);
  const [initialFingerprint, setInitialFingerprint] = useState(skillEditorFingerprint(emptySeed.form));
  const [skill, setSkill] = useState<SkillRegistryEntry | undefined>();
  const [candidateId, setCandidateId] = useState("");
  const [busy, setBusy] = useState<SkillEditorBusyState>("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState<SkillRevisionPreview | undefined>();
  const [authorityConfirmation, setAuthorityConfirmation] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState(false);
  const dirty = skillEditorFingerprint(form) !== initialFingerprint;

  function resetTransientState(): void {
    setBusy("");
    setError("");
    setConflict(false);
    setPreview(undefined);
    setAuthorityConfirmation(false);
    setDiscardConfirmation(false);
  }

  function openCreate(): void {
    const seed = emptySkillEditorSeed();
    setMode("create");
    setFormState(seed.form);
    setPreserved(seed.preserved);
    setInitialFingerprint(skillEditorFingerprint(seed.form));
    setSkill(undefined);
    setCandidateId("");
    resetTransientState();
    setOpen(true);
  }

  function openCandidate(draft: SkillImportDraft, sourceCandidateId: string): void {
    const seed = skillEditorSeedFromDraft(draft);
    setMode("candidate");
    setFormState(seed.form);
    setPreserved(seed.preserved);
    setInitialFingerprint(skillEditorFingerprint(seed.form));
    setSkill(undefined);
    setCandidateId(sourceCandidateId);
    resetTransientState();
    setOpen(true);
  }

  function openRevision(entry: SkillRegistryEntry): void {
    const seed = skillEditorSeedFromSkill(entry);
    setMode("revision");
    setFormState(seed.form);
    setPreserved(seed.preserved);
    setInitialFingerprint(skillEditorFingerprint(seed.form));
    setSkill(entry);
    setCandidateId("");
    resetTransientState();
    setOpen(true);
  }

  function closeImmediately(): void {
    setOpen(false);
    setSkill(undefined);
    setCandidateId("");
    resetTransientState();
  }

  function requestClose(): void {
    if (busy) return;
    if (dirty) {
      setDiscardConfirmation(true);
      return;
    }
    closeImmediately();
  }

  function discardChanges(): void {
    closeImmediately();
  }

  function continueEditing(): void {
    setDiscardConfirmation(false);
  }

  function setForm(next: SkillEditorForm): void {
    setFormState(next);
    setError("");
    setConflict(false);
    setPreview(undefined);
    setAuthorityConfirmation(false);
    setDiscardConfirmation(false);
  }

  async function save(): Promise<void> {
    if (busy || authorityConfirmation) return;
    if (mode === "revision") {
      await saveRevision(false);
      return;
    }
    await saveCreateOrCandidate();
  }

  async function confirmAuthorityChanges(): Promise<void> {
    if (busy || mode !== "revision") return;
    await saveRevision(true);
  }

  async function saveRevision(confirmAuthority: boolean): Promise<void> {
    if (!skill) return;
    setBusy(confirmAuthority ? "saving" : "checking");
    try {
      setError("");
      setConflict(false);
      const request = {
        expectedUpdatedAt: skill.updatedAt,
        definition: skillEditableDefinitionFromForm(form),
      };
      const previewResponse = await previewSkillRevision(cwd.trim(), skill.id, request);
      setPreview(previewResponse.preview);
      if (!previewResponse.preview.canPublish) {
        setError(t("Fix the highlighted skill fields before saving."));
        return;
      }
      if (previewResponse.preview.requiresConfirmation && !confirmAuthority) {
        setAuthorityConfirmation(true);
        return;
      }
      setBusy("saving");
      const response = await publishSkillRevision(cwd.trim(), skill.id, {
        ...request,
        ...(confirmAuthority ? { confirmAuthorityChanges: true } : {}),
      });
      closeImmediately();
      await onCompleted({ skills: [response.skill], mode: "revision" });
      onSuccess(t("Skill updated"));
    } catch (caught) {
      if (caught instanceof LingDaemonError && caught.code === "skill_revision_conflict") {
        setConflict(true);
        setError(t("This skill was updated elsewhere. Reload the latest version before saving."));
      } else {
        setError(skillEditorErrorMessage(caught, t));
      }
    } finally {
      setBusy("");
    }
  }

  async function saveCreateOrCandidate(): Promise<void> {
    setBusy("checking");
    try {
      setError("");
      const sourcePath = mode === "candidate" && candidateId ? `skill-candidates/${candidateId}` : undefined;
      const request = skillEditorImportRequest(form, preserved, { sourcePath });
      const previewResponse = await previewSkillImport(cwd.trim(), request);
      if (skillImportHasBlockingWarnings(previewResponse.preview)) {
        setError(t("Fix the highlighted skill fields before saving."));
        return;
      }
      setBusy("saving");
      const draftResponse = mode === "candidate"
        ? await createSkillCandidateDraft(cwd.trim(), candidateId, { content: request.content })
        : await createSkillImportDraft(cwd.trim(), request);
      const draftIssues = skillImportBlockingWarningCodes({
        source: draftResponse.draft.source,
        ...(draftResponse.draft.sourcePath ? { sourcePath: draftResponse.draft.sourcePath } : {}),
        ...(draftResponse.draft.packId ? { packId: draftResponse.draft.packId } : {}),
        name: draftResponse.draft.name,
        ...(draftResponse.draft.version ? { version: draftResponse.draft.version } : {}),
        description: draftResponse.draft.description,
        definitions: draftResponse.draft.definitions,
        warnings: draftResponse.draft.warnings,
      });
      if (draftIssues.length > 0) {
        setError(t("The skill changed during validation. Review it and try again."));
        return;
      }
      const response = await publishSkillImportDraft(cwd.trim(), draftResponse.draft.id);
      const completedMode = mode;
      const completedCandidateId = candidateId;
      closeImmediately();
      await onCompleted({
        skills: response.skills,
        mode: completedMode,
        ...(completedCandidateId ? { candidateId: completedCandidateId } : {}),
      });
      onSuccess(t(completedMode === "create" ? "Skill created" : "AI skill created"));
    } catch (caught) {
      setError(skillEditorErrorMessage(caught, t));
    } finally {
      setBusy("");
    }
  }

  function reloadRevision(entry: SkillRegistryEntry): void {
    openRevision(entry);
  }

  return {
    open,
    mode,
    form,
    skill,
    busy,
    error,
    conflict,
    preview,
    dirty,
    authorityConfirmation,
    discardConfirmation,
    sourceKind: mode === "candidate" || (skill && isEvolvedSkillEntry(skill)) ? "evolved" as const : "user" as const,
    openCreate,
    openCandidate,
    openRevision,
    requestClose,
    discardChanges,
    continueEditing,
    setForm,
    save,
    confirmAuthorityChanges,
    reloadRevision,
  } as const;
}

function skillEditorErrorMessage(error: unknown, t: SettingsTranslator): string {
  if (error instanceof LingDaemonError) {
    if (error.code === "skill_not_editable") {
      return t("This skill is managed by a read-only source and cannot be edited.");
    }
    if (error.code === "skill_revision_confirmation_required") {
      return t("Review the runtime requirement changes before saving.");
    }
  }
  return error instanceof Error ? error.message : String(error);
}
