import type {
  SkillImportDraft,
  SkillImportDraftRequest,
  SkillImportPreview,
  SkillImportWarning,
  SkillImportWarningCode,
} from "../../types.js";

export interface SkillImportForm {
  readonly fileName: string;
  readonly content: string;
}

export const initialSkillImportForm: SkillImportForm = {
  fileName: "",
  content: "",
};

const supportedSkillImportExtensions = new Set(["md", "markdown", "json", "txt"]);

export function normalizeSkillImportFileName(value: string): string {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)?.trim() ?? "";
}

export function isSupportedSkillImportFileName(value: string): boolean {
  const fileName = normalizeSkillImportFileName(value).toLowerCase();
  const extension = fileName.includes(".") ? fileName.split(".").at(-1) ?? "" : "";
  return supportedSkillImportExtensions.has(extension);
}

export function buildSkillImportRequest(form: SkillImportForm): SkillImportDraftRequest {
  const fileName = normalizeSkillImportFileName(form.fileName);
  return {
    content: form.content,
    ...(fileName ? { sourcePath: fileName } : {}),
  };
}

export function skillImportWarnings(preview: SkillImportPreview): readonly SkillImportWarning[] {
  return [...preview.warnings, ...preview.definitions.flatMap((item) => item.warnings ?? [])];
}

export function skillImportHasBlockingWarnings(preview: SkillImportPreview): boolean {
  return skillImportWarnings(preview).some((warning) => warning.severity === "error");
}

export function skillImportBlockingWarningCodes(preview: SkillImportPreview): readonly SkillImportWarningCode[] {
  return [...new Set(skillImportWarnings(preview)
    .filter((warning) => warning.severity === "error")
    .map((warning) => warning.code))];
}

export function skillImportProblemLabel(code: SkillImportWarningCode): string {
  switch (code) {
    case "duplicate_skill_id":
      return "A skill with the same identity already exists.";
    case "missing_metadata":
      return "The file is missing required skill information.";
    case "unknown_tool":
      return "The skill requires a tool Ling does not recognize.";
    case "unknown_provider_capability":
      return "The skill requires an unsupported model capability.";
    case "unsupported_section":
      return "The file contains content Ling cannot import.";
    case "permission_like_instruction":
      return "The skill contains permission instructions that require review.";
    case "secret_reference":
      return "The skill contains a secret reference that requires review.";
    case "external_send_claim":
      return "The skill contains an external-send instruction that requires review.";
  }
}

export function skillImportPreviewFromDraft(draft: SkillImportDraft): SkillImportPreview {
  return {
    source: draft.source,
    ...(draft.sourcePath ? { sourcePath: draft.sourcePath } : {}),
    ...(draft.packId ? { packId: draft.packId } : {}),
    name: draft.name,
    ...(draft.version ? { version: draft.version } : {}),
    description: draft.description,
    definitions: draft.definitions,
    warnings: draft.warnings,
  };
}

export function skillImportContentFromDraft(draft: SkillImportDraft): string {
  return JSON.stringify({
    name: draft.name,
    description: draft.description,
    skills: draft.definitions.map((item) => item.definition),
  }, null, 2);
}
