import type { ResponseLanguage } from "@ling-stack/core";
import { formatServerCatalogMessage } from "@ling-stack/localization";

export type LingMaterializationCopyIssue =
  | "image_unavailable"
  | "pdf_unavailable"
  | "office_unavailable"
  | "link_private"
  | "workspace_file_outside_root"
  | "generic_unavailable";

export function renderMaterializationClarifyCopy(input: {
  readonly issue: LingMaterializationCopyIssue;
  readonly label: string;
  readonly language: ResponseLanguage;
}): string {
  return formatServerCatalogMessage(input.language, `daemon.materialization.${input.issue}`, { label: input.label });
}
