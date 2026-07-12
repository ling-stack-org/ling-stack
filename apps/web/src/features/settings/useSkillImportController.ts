import { useEffect, useState } from "react";
import {
  createSkillImportDraft,
  previewSkillImport,
  publishSkillImportDraft,
} from "../../api.js";
import type {
  SkillImportDraft,
  SkillImportPreview,
  SkillSourceContextHealthFinding,
  SkillImportWarningCode,
} from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  buildSkillImportRequest,
  initialSkillImportForm,
  isSupportedSkillImportFileName,
  normalizeSkillImportFileName,
  skillImportBlockingWarningCodes,
  skillImportHasBlockingWarnings,
  skillImportContentFromDraft,
  skillImportPreviewFromDraft,
  type SkillImportForm,
} from "./skill-import-utils.js";

const feedbackDurationMs = 2000;

export type SkillImportBusyState = "" | "reading" | "checking" | "publishing";
export type SkillImportDialogMode = "file" | "draft";

export function useSkillImportController({
  cwd,
  onPublished,
  t,
}: {
  readonly cwd: string;
  readonly onPublished: (count: number) => Promise<void>;
  readonly t: SettingsTranslator;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SkillImportDialogMode>("file");
  const [form, setForm] = useState<SkillImportForm>(initialSkillImportForm);
  const [preview, setPreview] = useState<SkillImportPreview | undefined>();
  const [durableDraftId, setDurableDraftId] = useState("");
  const [contextFindings, setContextFindings] = useState<readonly SkillSourceContextHealthFinding[]>([]);
  const [busy, setBusy] = useState<SkillImportBusyState>("");
  const [error, setError] = useState("");
  const [blockingIssues, setBlockingIssues] = useState<readonly SkillImportWarningCode[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timeoutId = globalThis.setTimeout(() => setNotice(""), feedbackDurationMs);
    return () => globalThis.clearTimeout(timeoutId);
  }, [notice]);

  function resetDraftState(): void {
    setPreview(undefined);
    setDurableDraftId("");
    setContextFindings([]);
    setError("");
    setBlockingIssues([]);
  }

  function openImport(): void {
    setMode("file");
    setForm(initialSkillImportForm);
    resetDraftState();
    setOpen(true);
  }

  function openDraft(): void {
    setMode("draft");
    setForm(initialSkillImportForm);
    resetDraftState();
    setOpen(true);
  }

  function closeImport(): void {
    setOpen(false);
    setForm(initialSkillImportForm);
    resetDraftState();
    setBusy("");
  }

  function openExistingDraft(draft: SkillImportDraft, findings: readonly SkillSourceContextHealthFinding[]): void {
    setMode("draft");
    setForm({
      fileName: normalizeSkillImportFileName(draft.sourcePath ?? ""),
      content: skillImportContentFromDraft(draft),
    });
    setPreview(skillImportPreviewFromDraft(draft));
    setDurableDraftId(draft.id);
    setContextFindings(findings);
    setError("");
    setBlockingIssues([]);
    setOpen(true);
  }

  function updateContent(content: string): void {
    setForm((current) => ({ ...current, content }));
    resetDraftState();
  }

  function clearFile(): void {
    setForm((current) => ({ ...current, fileName: "" }));
    resetDraftState();
  }

  async function loadFile(file: File | undefined): Promise<void> {
    if (!file || busy) {
      return;
    }
    if (!isSupportedSkillImportFileName(file.name)) {
      setError(t("Choose a Markdown, JSON, or text skill file."));
      return;
    }
    setBusy("reading");
    try {
      const content = await file.text();
      setForm({ fileName: file.name, content });
      setPreview(undefined);
      setDurableDraftId("");
      setContextFindings([]);
      setError("");
      setBlockingIssues([]);
    } catch {
      setError(t("Could not read this skill file."));
    } finally {
      setBusy("");
    }
  }

  async function checkContent(): Promise<void> {
    if (!form.content.trim() || busy) {
      setError(t("Choose a file or paste skill content first."));
      return;
    }
    setBusy("checking");
    try {
      setError("");
      const response = await previewSkillImport(cwd.trim(), buildSkillImportRequest(form));
      setPreview(response.preview);
      setBlockingIssues(skillImportBlockingWarningCodes(response.preview));
      setDurableDraftId("");
      setContextFindings(response.contextFindings ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function importFile(): Promise<void> {
    if (!form.fileName || !form.content.trim() || busy) {
      setError(t("Choose a skill file first."));
      return;
    }
    setBusy("publishing");
    try {
      setError("");
      setBlockingIssues([]);
      const previewResponse = await previewSkillImport(cwd.trim(), buildSkillImportRequest(form));
      const previewIssues = skillImportBlockingWarningCodes(previewResponse.preview);
      if (previewIssues.length > 0) {
        setBlockingIssues(previewIssues);
        return;
      }

      const draftResponse = await createSkillImportDraft(cwd.trim(), buildSkillImportRequest(form));
      const durablePreview = skillImportPreviewFromDraft(draftResponse.draft);
      const durableIssues = skillImportBlockingWarningCodes(durablePreview);
      if (durableIssues.length > 0) {
        setBlockingIssues(durableIssues);
        return;
      }

      const response = await publishSkillImportDraft(cwd.trim(), draftResponse.draft.id);
      closeImport();
      await onPublished(response.skills.length);
      setNotice(t("Imported {count} skills", { count: response.skills.length }));
    } catch {
      setError(t("This skill could not be imported. Check the file and try again."));
    } finally {
      setBusy("");
    }
  }

  async function publish(): Promise<void> {
    if (!preview || skillImportHasBlockingWarnings(preview) || busy) {
      return;
    }
    setBusy("publishing");
    try {
      setError("");
      let publishDraftId = durableDraftId;
      if (!publishDraftId) {
        const draftResponse = await createSkillImportDraft(cwd.trim(), buildSkillImportRequest(form));
        const durablePreview = skillImportPreviewFromDraft(draftResponse.draft);
        if (skillImportHasBlockingWarnings(durablePreview)) {
          setPreview(durablePreview);
          setContextFindings(draftResponse.contextFindings ?? []);
          setError(t("The skill content changed and needs to be checked again."));
          return;
        }
        publishDraftId = draftResponse.draft.id;
      }
      const response = await publishSkillImportDraft(cwd.trim(), publishDraftId);
      closeImport();
      await onPublished(response.skills.length);
      setNotice(t("Published {count} skills", { count: response.skills.length }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  return {
    open,
    mode,
    form,
    preview,
    contextFindings,
    busy,
    error,
    blockingIssues,
    notice,
    openImport,
    openDraft,
    openExistingDraft,
    closeImport,
    updateContent,
    clearFile,
    loadFile,
    checkContent,
    importFile,
    publish,
  } as const;
}
