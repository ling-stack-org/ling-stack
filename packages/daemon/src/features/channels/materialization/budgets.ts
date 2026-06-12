export interface LingMaterializationBudgets {
  readonly textAttachmentInlineBytes: number;
  readonly textAttachmentPromptChars: number;
  readonly pdfReadBytes: number;
  readonly pdfCacheChars: number;
  readonly pdfPromptChars: number;
  readonly officeReadBytes: number;
  readonly officeCacheChars: number;
  readonly officePromptChars: number;
  readonly linkBodyBytes: number;
  readonly linkBodyPromptChars: number;
  readonly linkBodyTimeoutMs: number;
  readonly linkBodyRedirects: number;
}

export const defaultLingMaterializationBudgets: LingMaterializationBudgets = {
  textAttachmentInlineBytes: 16 * 1024,
  textAttachmentPromptChars: 8_000,
  pdfReadBytes: 2 * 1024 * 1024,
  pdfCacheChars: 24_000,
  pdfPromptChars: 8_000,
  officeReadBytes: 2 * 1024 * 1024,
  officeCacheChars: 24_000,
  officePromptChars: 8_000,
  linkBodyBytes: 1024 * 1024,
  linkBodyPromptChars: 8_000,
  linkBodyTimeoutMs: 10_000,
  linkBodyRedirects: 3,
};
