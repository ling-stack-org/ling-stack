import type {
  LingThemeImageMimeType,
  LingThemePackageIssue,
  LingThemePackManifest,
} from "@ling-stack/ui-react/theme";
import { LingThemePackageError } from "@ling-stack/ui-react/theme";

export type WebThemePreviewMimeType = LingThemeImageMimeType;

export interface ParsedWebThemePreview {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly height: number;
  readonly mimeType: WebThemePreviewMimeType;
  readonly path: string;
  readonly width: number;
}

export interface ParsedWebThemePackage {
  readonly archiveBytes: Uint8Array;
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly originalFileName: string;
  readonly packageChecksumSha256: string;
  readonly preview?: ParsedWebThemePreview;
  readonly warnings: readonly LingThemePackageIssue[];
}

export class WebThemePackageError extends LingThemePackageError {
  constructor(issues: readonly LingThemePackageIssue[]) {
    super(issues);
    this.name = "WebThemePackageError";
  }
}
