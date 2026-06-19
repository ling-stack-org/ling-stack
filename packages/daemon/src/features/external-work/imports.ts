import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, resolve as resolvePath } from "node:path";
import {
  normalizeGitHubExternalWorkItem,
  normalizeLinearExternalWorkItem,
  parseExternalWorkflowMarkdown,
  renderExternalWorkflowPrompt,
  type ExternalWorkImportResponse,
  type ExternalWorkItem,
  type ExternalWorkStoreFacet,
  type RunArtifact,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
  type WorkspaceStoreFacet,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { normalizeArtifactPath } from "../../shared/path.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { parseExternalGitHubImportRequest, parseExternalLinearImportRequest } from "./schemas.js";
import { readExternalWorkflowMarkdown } from "./workflow.js";

type ExternalWorkImportStore =
  ExternalWorkStoreFacet &
  WorkspaceStoreFacet &
  RunExecutionStoreFacet &
  RunStorePathsFacet;

export async function handleExternalGitHubImport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub external work import` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubImportRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }

    const workflowMarkdown = readExternalWorkflowMarkdown(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowMarkdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const externalWorkItem = normalizeGitHubExternalWorkItem({
      eventType: input.eventType,
      payload: input.payload,
      repositoryFullName: workflowDefinition.config.source.repository,
    });
    const renderedPrompt = renderExternalWorkflowPrompt(workflowDefinition.promptTemplate, { item: externalWorkItem });
    const now = new Date().toISOString();
    const imported = store.createOrReuseExternalWorkWorkflow(
      {
        channelId: channel.id,
        externalWorkItem,
        workflowDefinition,
        renderedPrompt,
      },
      now,
    );
    const artifacts = imported.duplicate
      ? store.listExternalWorkArtifacts(imported.externalWork.id)
      : createExternalWorkEvidenceArtifacts(store, imported.externalWork.id, externalWorkItem, renderedPrompt, now);
    if (!imported.duplicate) {
      store.updateExternalWorkArtifacts(imported.externalWork.id, artifacts.map((artifact) => artifact.id), new Date().toISOString());
    }
    const responseBody: ExternalWorkImportResponse = {
      externalWorkItem,
      workflow: imported.workflow,
      workflowStep: imported.workflowStep,
      artifacts,
      duplicate: imported.duplicate,
    };
    writeJson(response, imported.duplicate ? 200 : 201, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalLinearImport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for Linear external work import` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalLinearImportRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }

    const workflowMarkdown = readExternalWorkflowMarkdown(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowMarkdown);
    if (workflowDefinition.config.source.kind !== "linear") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const externalWorkItem = normalizeLinearExternalWorkItem({
      eventType: input.eventType,
      payload: input.payload,
      projectSlug: workflowDefinition.config.source.projectSlug,
    });
    const renderedPrompt = renderExternalWorkflowPrompt(workflowDefinition.promptTemplate, { item: externalWorkItem });
    const now = new Date().toISOString();
    const imported = store.createOrReuseExternalWorkWorkflow(
      {
        channelId: channel.id,
        externalWorkItem,
        workflowDefinition,
        renderedPrompt,
      },
      now,
    );
    const artifacts = imported.duplicate
      ? store.listExternalWorkArtifacts(imported.externalWork.id)
      : createExternalWorkEvidenceArtifacts(store, imported.externalWork.id, externalWorkItem, renderedPrompt, now);
    if (!imported.duplicate) {
      store.updateExternalWorkArtifacts(imported.externalWork.id, artifacts.map((artifact) => artifact.id), new Date().toISOString());
    }
    const responseBody: ExternalWorkImportResponse = {
      externalWorkItem,
      workflow: imported.workflow,
      workflowStep: imported.workflowStep,
      artifacts,
      duplicate: imported.duplicate,
    };
    writeJson(response, imported.duplicate ? 200 : 201, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function createExternalWorkEvidenceArtifacts(
  store: ExternalWorkImportStore,
  externalWorkId: string,
  externalWorkItem: ExternalWorkItem,
  renderedPrompt: string,
  createdAt: string,
): RunArtifact[] {
  const artifactDir = resolvePath(store.paths.artifactsDir, "external-work", externalWorkId);
  mkdirSync(artifactDir, { recursive: true });
  const itemJson = `${JSON.stringify(externalWorkItem, null, 2)}\n`;
  const itemPath = resolvePath(artifactDir, "normalized-item.json");
  writeFileSync(itemPath, itemJson, "utf8");
  const promptText = `${renderedPrompt.trim()}\n`;
  const promptPath = resolvePath(artifactDir, "rendered-prompt.md");
  writeFileSync(promptPath, promptText, "utf8");

  return [
    store.createArtifact({
      externalWorkId,
      type: "json",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, itemPath)),
      title: "Normalized external work item",
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(itemJson, "utf8"),
      createdAt,
    }),
    store.createArtifact({
      externalWorkId,
      type: "markdown",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, promptPath)),
      title: "Rendered workflow prompt",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength(promptText, "utf8"),
      createdAt,
    }),
  ];
}
