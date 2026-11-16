import type { WorkflowTemplateListResponse, WorkflowTemplateVersionResponse, WorkflowTemplateSaveRequest,
  WorkflowTemplateReviewRequest, WorkflowTemplateReviewResponse, WorkflowTemplatePreviewRequest,
  WorkflowTemplatePreviewResponse } from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const workflowTemplateEndpoints = {
  async listWorkflowTemplates(this: LingDaemonEndpointContext, cwd: string, options: { readonly includeArchived?: boolean } = {}): Promise<WorkflowTemplateListResponse> {
    return this._get("/workflow-templates", { cwd, includeArchived: options.includeArchived });
  },
  async getWorkflowTemplateVersion(this: LingDaemonEndpointContext, cwd: string, id: string, version: string): Promise<WorkflowTemplateVersionResponse> {
    return this._get(`/workflow-templates/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`, { cwd });
  },
  async saveWorkflowTemplateVersion(this: LingDaemonEndpointContext, cwd: string, input: WorkflowTemplateSaveRequest): Promise<WorkflowTemplateVersionResponse> {
    return this._post("/workflow-templates", { cwd }, input);
  },
  async setWorkflowTemplateReviewStatus(this: LingDaemonEndpointContext, cwd: string, id: string, input: WorkflowTemplateReviewRequest): Promise<WorkflowTemplateReviewResponse> {
    return this._patch(`/workflow-templates/${encodeURIComponent(id)}/review`, { cwd }, input);
  },
  async previewWorkflowTemplate(this: LingDaemonEndpointContext, cwd: string, input: WorkflowTemplatePreviewRequest): Promise<WorkflowTemplatePreviewResponse> {
    return this._post("/workflow-templates/preview", { cwd }, input);
  },
};

export type WorkflowTemplateEndpoints = PublicEndpointGroup<typeof workflowTemplateEndpoints>;
