export declare const packageRoot: string;
export declare const repoRoot: string;
export declare const catalogRoot: string;
export declare function sourceRevision(messages: Record<string, string>): string;
export declare function assertCatalogImportRetainsMessages(
  previousMessages: Record<string, string>,
  nextMessages: Record<string, string>,
): void;
export declare function messageSourceHash(value: string): string;
