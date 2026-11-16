import type { WorkflowTemplateSaveRequest, WorkflowTemplateReviewRequest, WorkflowTemplatePreviewRequest } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export const listWorkflowTemplates = (cwd: string, options: { readonly includeArchived?: boolean } = {}) => daemonClient.listWorkflowTemplates(cwd, options);
export const getWorkflowTemplateVersion = (cwd: string, id: string, version: string) => daemonClient.getWorkflowTemplateVersion(cwd, id, version);
export const saveWorkflowTemplateVersion = (cwd: string, input: WorkflowTemplateSaveRequest) => daemonClient.saveWorkflowTemplateVersion(cwd, input);
export const setWorkflowTemplateReviewStatus = (cwd: string, id: string, input: WorkflowTemplateReviewRequest) => daemonClient.setWorkflowTemplateReviewStatus(cwd, id, input);
export const previewWorkflowTemplate = (cwd: string, input: WorkflowTemplatePreviewRequest) => daemonClient.previewWorkflowTemplate(cwd, input);
