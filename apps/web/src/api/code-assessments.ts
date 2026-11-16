import type { CodeAssessmentDetail, CodeAssessmentList, CodeAssessmentListOptions, CodeAssessmentOverview, CodeAssessmentFilePreview, CreateCodeAssessmentRequest, CreateCodeAssessmentCommentRequest, CodeFindingDisposition, CodeFindingCloseReason } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export function listCodeAssessments(cwd: string, kindOrOptions?: "review" | "security" | CodeAssessmentListOptions, offset = 0): Promise<CodeAssessmentList> { return daemonClient.listCodeAssessments(cwd, kindOrOptions, offset); }
export function getCodeAssessment(cwd: string, id: string): Promise<CodeAssessmentDetail> { return daemonClient.getCodeAssessment(cwd, id); }
export function getCodeAssessmentOverview(cwd: string, id: string): Promise<CodeAssessmentOverview> { return daemonClient.getCodeAssessmentOverview(cwd, id); }
export function getCodeAssessmentFile(cwd: string, id: string, path: string): Promise<CodeAssessmentFilePreview> { return daemonClient.getCodeAssessmentFile(cwd, id, path); }
export function createCodeAssessment(cwd: string, input: CreateCodeAssessmentRequest): Promise<CodeAssessmentDetail> { return daemonClient.createCodeAssessment(cwd, input); }
export function createCodeAssessmentOverview(cwd: string, input: CreateCodeAssessmentRequest): Promise<CodeAssessmentOverview> { return daemonClient.createCodeAssessmentOverview(cwd, input); }
export function cancelCodeAssessment(cwd: string, id: string): Promise<CodeAssessmentDetail> { return daemonClient.cancelCodeAssessment(cwd, id); }
export function setCodeFindingDisposition(cwd: string, assessmentId: string, findingId: string, input: { readonly snapshotDigest: string; readonly disposition: CodeFindingDisposition; readonly reason?: string; readonly closeReason?: CodeFindingCloseReason }) { return daemonClient.setCodeFindingDisposition(cwd, assessmentId, findingId, input); }
export function listCodeAssessmentComments(cwd: string, assessmentId: string, findingId: string) { return daemonClient.listCodeAssessmentComments(cwd, assessmentId, findingId); }
export function createCodeAssessmentComment(cwd: string, assessmentId: string, findingId: string, input: CreateCodeAssessmentCommentRequest) { return daemonClient.createCodeAssessmentComment(cwd, assessmentId, findingId, input); }

export function checkCodeAssessmentFreshness(cwd: string, id: string) { return daemonClient.checkCodeAssessmentFreshness(cwd, id); }
