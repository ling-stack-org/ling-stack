import type { CodeAssessmentComment, CreateCodeAssessmentCommentRequest } from "@ling-stack/contracts";

export interface CodeAssessmentCommentsStore {
  createCodeAssessmentComment(assessmentId: string, findingId: string,
    input: CreateCodeAssessmentCommentRequest & { readonly id: string; readonly now: string }): CodeAssessmentComment;
  listCodeAssessmentComments(assessmentId: string, findingId: string): readonly CodeAssessmentComment[];
}
