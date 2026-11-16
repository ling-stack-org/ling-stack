import type { CodeAssessmentDetail, CodeAssessmentSnapshot, CodeAssessmentSnapshotFile } from "./code-assessments.js";

export interface CodeAssessmentFileSummary extends Omit<CodeAssessmentSnapshotFile, "diff"> {
  readonly additions: number;
  readonly deletions: number;
}

/** History and result views carry source metadata; a selected file is fetched separately. */
export interface CodeAssessmentOverview extends Omit<CodeAssessmentDetail, "snapshot"> {
  readonly snapshot: Omit<CodeAssessmentSnapshot, "files"> & { readonly files: readonly CodeAssessmentFileSummary[] };
}

export interface CodeAssessmentFilePreview {
  readonly snapshotDigest: string;
  readonly file: CodeAssessmentSnapshotFile;
}
