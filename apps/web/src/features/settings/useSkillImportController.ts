import { useEffect, useState } from "react";
import {
  createSkillImportDraft,
  previewSkillImport,
  publishSkillImportDraft,
} from "../../api.js";
import type { SkillRegistryEntry, SkillImportWarningCode } from "../../types.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import {
  buildSkillImportRequest,
  initialSkillImportForm,
  isSupportedSkillImportFileName,
  skillImportBlockingWarningCodes,
  skillImportHasBlockingWarnings,
  type SkillImportForm,
} from "./skill-import-utils.js";

const feedbackDurationMs = 2000;

export type SkillImportBusyState = "" | "reading" | "publishing";

export function useSkillImportController({
  cwd,
  onPublished,
  t,
}: {
  readonly cwd: string;
  readonly onPublished: (skills: readonly SkillRegistryEntry[]) => Promise<void>;
  readonly t: SettingsTranslator;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SkillImportForm>(initialSkillImportForm);
  const [busy, setBusy] = useState<SkillImportBusyState>("");
  const [error, setError] = useState("");
  const [blockingIssues, setBlockingIssues] = useState<readonly SkillImportWarningCode[]>([]);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!notice) return undefined;
    const timeoutId = globalThis.setTimeout(() => setNotice(""), feedbackDurationMs);
    return () => globalThis.clearTimeout(timeoutId);
  }, [notice]);

  function openImport(): void {
    setForm(initialSkillImportForm);
    setError("");
    setBlockingIssues([]);
    setBusy("");
    setOpen(true);
  }

  function closeImport(): void {
    if (busy) return;
    setOpen(false);
    setForm(initialSkillImportForm);
    setError("");
    setBlockingIssues([]);
  }

  async function loadFile(file: File | undefined): Promise<void> {
    if (!file || busy) return;
    if (!isSupportedSkillImportFileName(file.name)) {
      setError(t("Choose a Markdown, JSON, or text skill file."));
      return;
    }
    setBusy("reading");
    try {
      const content = await file.text();
      setForm({ fileName: file.name, content });
      setError("");
      setBlockingIssues([]);
    } catch {
      setError(t("Could not read this skill file."));
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
      const request = buildSkillImportRequest(form);
      const previewResponse = await previewSkillImport(cwd.trim(), request);
      const previewIssues = skillImportBlockingWarningCodes(previewResponse.preview);
      if (previewIssues.length > 0) {
        setBlockingIssues(previewIssues);
        return;
      }
      const draftResponse = await createSkillImportDraft(cwd.trim(), request);
      const durablePreview = {
        source: draftResponse.draft.source,
        ...(draftResponse.draft.sourcePath ? { sourcePath: draftResponse.draft.sourcePath } : {}),
        ...(draftResponse.draft.packId ? { packId: draftResponse.draft.packId } : {}),
        name: draftResponse.draft.name,
        ...(draftResponse.draft.version ? { version: draftResponse.draft.version } : {}),
        description: draftResponse.draft.description,
        definitions: draftResponse.draft.definitions,
        warnings: draftResponse.draft.warnings,
      };
      if (skillImportHasBlockingWarnings(durablePreview)) {
        setBlockingIssues(skillImportBlockingWarningCodes(durablePreview));
        return;
      }
      const response = await publishSkillImportDraft(cwd.trim(), draftResponse.draft.id);
      setOpen(false);
      setForm(initialSkillImportForm);
      await onPublished(response.skills);
      setNotice(t("Imported {count} skills", { count: response.skills.length }));
    } catch {
      setError(t("This skill could not be imported. Check the file and try again."));
    } finally {
      setBusy("");
    }
  }

  return {
    open,
    form,
    busy,
    error,
    blockingIssues,
    notice,
    openImport,
    closeImport,
    loadFile,
    importFile,
  } as const;
}
