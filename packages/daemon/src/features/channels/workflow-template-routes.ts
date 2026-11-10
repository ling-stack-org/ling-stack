import type { IncomingMessage, ServerResponse } from "node:http";
import { createSqliteWorkflowTemplateRegistryStore, WorkflowTemplateRegistryError } from "@ling-stack/core";
import { parseWorkflowTemplate, WorkflowTemplateValidationError, type WorkflowTemplateReviewRequest } from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readString } from "../../shared/validation.js";
import { parseWorkflowTemplateCompileRequest, previewWorkflowTemplate } from "./workflow-templates.js";

export async function handleWorkflowTemplateRoute(input: {
  readonly request: IncomingMessage; readonly response: ServerResponse; readonly url: URL;
  readonly config: ResolvedDaemonConfig; readonly storeRegistry: RunStoreRegistry; readonly runnerRegistry: RunnerRegistry;
}): Promise<void> {
  const { request, response, url } = input;
  try {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) throw new HttpError(400, "bad_request", "cwd query parameter is required");
    const store = input.storeRegistry.getStore(cwd), registry = createSqliteWorkflowTemplateRegistryStore(store);
    const methodNotAllowed = () => { throw new HttpError(405, "method_not_allowed", "Unsupported workflow template method"); };
    if (url.pathname === "/workflow-templates") {
      if (request.method === "GET") {
        writeJson(response, 200, { cwd, templates: registry.list({ includeArchived: url.searchParams.get("includeArchived") === "true", includeDisabled: true }) });
        return;
      }
      if (request.method !== "POST") methodNotAllowed();
      const body = await readJsonBody(request, input.config.maxBodyBytes);
      knownFields(body, ["id", "version", "template", "expectedRevision"]);
      const id = readString(body, "id"), previous = registry.get(id);
      if (previous && previous.source !== "workspace") throw new HttpError(403, "workflow_template_source_readonly", "This source cannot be edited through the workspace authoring API.");
      const saved = registry.saveVersion({ kind: "workflow_template", id, version: readString(body, "version"),
        template: parseWorkflowTemplate(body.template), source: "workspace",
        visibility: previous?.visibility ?? { workspaceVisible: true, promotableToWorkspace: false },
        expectedRevision: revision(body), now: new Date().toISOString() });
      writeJson(response, saved.status === "created" ? 201 : 200, { entry: saved.entry, version: saved.version });
      return;
    }
    if (url.pathname === "/workflow-templates/preview") {
      if (request.method !== "POST") methodNotAllowed();
      const body = await readJsonBody(request, input.config.maxBodyBytes);
      knownFields(body, ["channelId", "objective", "customTemplate", "customTemplateId", "customTemplateVersion", "customTemplateDigest", "autoStart", "confirmUnsafeAutoStart"]);
      const parsed = parseWorkflowTemplateCompileRequest(body, readString(body, "channelId"));
      writeJson(response, 200, previewWorkflowTemplate(store, parsed, input.runnerRegistry));
      return;
    }
    const versionRoute = url.pathname.match(/^\/workflow-templates\/([^/]+)\/versions\/([^/]+)$/u);
    if (versionRoute) {
      if (request.method !== "GET") methodNotAllowed();
      const id = decodeURIComponent(versionRoute[1]!), entry = registry.get(id), version = registry.getVersion(id, decodeURIComponent(versionRoute[2]!));
      if (!entry || !version) throw new HttpError(404, "workflow_template_not_found", "Template version not found");
      writeJson(response, 200, { entry, version });
      return;
    }
    const reviewRoute = url.pathname.match(/^\/workflow-templates\/([^/]+)\/review$/u);
    if (reviewRoute) {
      if (request.method !== "PATCH") methodNotAllowed();
      const body = await readJsonBody(request, input.config.maxBodyBytes);
      knownFields(body, ["expectedRevision", "reviewStatus", "version", "digest"]);
      const id = decodeURIComponent(reviewRoute[1]!), prior = registry.get(id);
      if (prior && prior.source !== "workspace") throw new HttpError(403, "workflow_template_source_readonly", "This source cannot be reviewed through the workspace authoring API.");
      const reviewStatus = readString(body, "reviewStatus");
      if (!["draft", "published", "disabled", "archived"].includes(reviewStatus)) throw new HttpError(400, "bad_request", "Invalid review status");
      if (reviewStatus !== "published" && ("version" in body || "digest" in body)) throw new HttpError(400, "bad_request", "Only publication accepts a version pin");
      const change = { expectedRevision: revision(body), reviewStatus,
        ...(reviewStatus === "published" ? { version: readString(body, "version"), digest: readString(body, "digest") } : {}) } as WorkflowTemplateReviewRequest;
      writeJson(response, 200, { entry: registry.setReviewStatus({ ...change, id, now: new Date().toISOString() }) });
      return;
    }
    throw new HttpError(404, "not_found", "Workflow template route not found");
  } catch (error) {
    const code = error instanceof HttpError || error instanceof WorkflowTemplateRegistryError ? error.code
      : error instanceof WorkflowTemplateValidationError ? error.code : "bad_request";
    const status = error instanceof HttpError ? error.statusCode : error instanceof WorkflowTemplateRegistryError
      ? code.endsWith("not_found") ? 404 : /conflict$/u.test(code) ? 409 : code.endsWith("corrupt") ? 500 : 400 : 400;
    writeJson(response, status, { error: code, message: error instanceof Error ? error.message : "Invalid workflow template request" });
  }
}

function knownFields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new HttpError(400, "bad_request", "Only supported JSON fields are accepted");
}
function revision(body: Record<string, unknown>): number {
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) throw new HttpError(400, "bad_request", "expectedRevision must be a non-negative integer");
  return Number(body.expectedRevision);
}
