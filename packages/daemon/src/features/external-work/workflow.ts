import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  parseExternalWorkflowMarkdown,
  parseSecretRef,
  updateExternalWorkflowSecretRef,
  type Channel,
  type ExternalSourceKind,
  type ExternalWorkSecretMutationResponse,
  type ExternalWorkWorkflowMutationResponse,
  type ExternalWorkflowDefinition,
  type ExternalWorkWorkflowConfigureRequest,
  type SecretPurpose,
  type SecretResolver,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { ExternalSecretStore } from "../../context.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { isPathInsideRoot } from "../../shared/path.js";
import { readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  readExternalWorkSecretConfigureRequest,
  readExternalWorkSecretDeleteRequest,
  readExternalWorkWorkflowConfigureRequest,
} from "./schemas.js";
import {
  buildExternalWorkStatusSecret,
  buildExternalWorkStatusWorkflowSummary,
  parseExternalWorkflowStatus,
  readExternalWorkflowStatusFile,
} from "./status.js";

export async function handleExternalWorkWorkflowConfigure(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work workflow setup` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = readExternalWorkWorkflowConfigureRequest(body);
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }

    const targetPath = resolveExternalWorkflowWritablePath(channel, cwd, input.workflowPath);
    const existingFile = readExternalWorkflowStatusFile(channel, cwd, input.workflowPath);
    const existingParsed = parseExternalWorkflowStatus(existingFile.markdown);
    const workflowCreated = !existingFile.exists;
    let workflowUpdated = false;

    if (!existingFile.exists || !existingParsed.workflowDefinition) {
      writeFileSync(targetPath, buildMinimalExternalWorkflowMarkdown(input), "utf8");
      workflowUpdated = true;
    }

    const workflowFile = readExternalWorkflowStatusFile(channel, cwd, input.workflowPath);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    if (!parsed.workflowDefinition) {
      throw new Error(parsed.error ?? "Generated WORKFLOW.md is invalid.");
    }
    const responseBody: ExternalWorkWorkflowMutationResponse = {
      cwd,
      channelId: channel.id,
      sourceKind: parsed.workflowDefinition.config.source.kind,
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed),
      workflowCreated,
      workflowUpdated,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkSecretConfigure(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalSecretStore: ExternalSecretStore,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work secret setup` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = readExternalWorkSecretConfigureRequest(body);
    const prepared = prepareExternalWorkSecretMutation(storeRegistry, cwd, input.channelId, input.workflowPath);
    const token = input.token.trim();
    if (!token) {
      throw new Error("token is required.");
    }
    const secretRef = normalizeExternalWorkSecretRef(input.secretRef ?? prepared.workflowDefinition.config.source.secretRef, prepared.workflowDefinition);
    const setStatus = externalSecretStore.setSecret(secretRef, token, externalWorkSecretPurpose(prepared.workflowDefinition.config.source.kind));
    if (!setStatus.configured) {
      throw new Error(setStatus.message ?? `Could not save secret: ${secretRef}`);
    }

    const workflowUpdated = updateExternalWorkWorkflowSecretRefIfNeeded(prepared.workflowFile.path, prepared.workflowFile.markdown, secretRef, input.updateWorkflow !== false);
    const workflowFile = readExternalWorkflowStatusFile(prepared.channel, cwd, input.workflowPath);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    const workflowDefinition = parsed.workflowDefinition ?? prepared.workflowDefinition;
    const responseBody: ExternalWorkSecretMutationResponse = {
      cwd,
      channelId: prepared.channel.id,
      sourceKind: workflowDefinition.config.source.kind,
      secretRef,
      secret: buildExternalWorkStatusSecret(secretResolver, secretRef, externalWorkSecretPurpose(workflowDefinition.config.source.kind)),
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed, secretRef),
      workflowUpdated,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkSecretDelete(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalSecretStore: ExternalSecretStore,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work secret deletion` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = readExternalWorkSecretDeleteRequest(body);
    const prepared = prepareExternalWorkSecretMutation(storeRegistry, cwd, input.channelId, input.workflowPath);
    const sourceKind = prepared.workflowDefinition.config.source.kind;
    const secretRef = input.secretRef ?? prepared.workflowDefinition.config.source.secretRef;
    if (!secretRef) {
      throw new Error("WORKFLOW.md source.secretRef is required to remove a configured token.");
    }
    const parsedRef = parseSecretRef(secretRef);
    if (parsedRef.kind !== "keychain") {
      throw new Error("Only keychain: external work secrets can be removed from Web Settings.");
    }
    externalSecretStore.deleteSecret(secretRef, externalWorkSecretPurpose(sourceKind));
    const workflowFile = readExternalWorkflowStatusFile(prepared.channel, cwd, input.workflowPath);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    const responseBody: ExternalWorkSecretMutationResponse = {
      cwd,
      channelId: prepared.channel.id,
      sourceKind,
      secretRef,
      secret: buildExternalWorkStatusSecret(secretResolver, secretRef, externalWorkSecretPurpose(sourceKind)),
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed, secretRef),
      workflowUpdated: false,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export function prepareExternalWorkSecretMutation(
  storeRegistry: RunStoreRegistry,
  cwd: string,
  channelId: string,
  workflowPath: string | undefined,
): {
  readonly channel: Channel;
  readonly workflowFile: { readonly path: string; readonly exists: boolean; readonly markdown: string; readonly error?: string };
  readonly workflowDefinition: ExternalWorkflowDefinition;
} {
  const store = storeRegistry.getStore(cwd);
  const channel = store.getChannel(channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }
  const workflowFile = readExternalWorkflowStatusFile(channel, cwd, workflowPath);
  if (!workflowFile.exists || !workflowFile.markdown) {
    throw new Error(workflowFile.error ?? "WORKFLOW.md was not found");
  }
  const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
  return {
    channel,
    workflowFile: {
      path: workflowFile.path,
      exists: true,
      markdown: workflowFile.markdown,
      ...(workflowFile.error ? { error: workflowFile.error } : {}),
    },
    workflowDefinition,
  };
}

export function resolveExternalWorkflowWritablePath(channel: Channel, cwd: string, workflowPathInput: string | undefined): string {
  const root = channel.boundPath ?? cwd;
  const rootRealPath = realpathSync(root);
  const workflowPath = workflowPathInput
    ? isAbsolute(workflowPathInput)
      ? workflowPathInput
      : resolvePath(rootRealPath, workflowPathInput)
    : resolvePath(rootRealPath, "WORKFLOW.md");

  if (!isPathInsideRoot(rootRealPath, workflowPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  const existing = statFileIfPresent(workflowPath);
  if (existing) {
    if (!existing.isFile()) {
      throw new Error("Workflow path is not a file");
    }
    const workflowRealPath = realpathSync(workflowPath);
    if (!isPathInsideRoot(rootRealPath, workflowRealPath)) {
      throw new Error("workflowPath must resolve inside the channel bound path");
    }
    return workflowRealPath;
  }

  const parentPath = resolvePath(workflowPath, "..");
  mkdirSync(parentPath, { recursive: true });
  const parentRealPath = realpathSync(parentPath);
  if (!isPathInsideRoot(rootRealPath, parentRealPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  return workflowPath;
}

export function buildMinimalExternalWorkflowMarkdown(input: ExternalWorkWorkflowConfigureRequest): string {
  const sourceBlock = input.sourceKind === "github"
    ? [
        "source:",
        "  kind: github",
        `  repository: ${input.repository}`,
        "  events:",
        "    - pull_request.opened",
        "    - pull_request.synchronize",
        "    - issue.opened",
      ]
    : [
        "source:",
        "  kind: linear",
        `  projectSlug: ${input.projectSlug}`,
        "  events:",
        "    - issue.created",
      ];
  return [
    "---",
    ...sourceBlock,
    "scheduler:",
    "  reconcileOnStartup: false",
    "agent:",
    "  teammateId: engineer",
    "---",
    "",
    "Review {{ item.kind }} {{ item.identifier }}.",
    "",
    "Title: {{ item.title }}",
    "State: {{ item.state }}",
    "",
    "Summarize the requested work, identify required code, test, and docs changes, and propose a safe implementation plan.",
    "Do not perform external mutations unless a separate approval-gated action is explicitly requested.",
    "",
  ].join("\n");
}

export function normalizeExternalWorkSecretRef(secretRef: string | undefined, workflowDefinition: ExternalWorkflowDefinition): string {
  if (secretRef) {
    const parsed = parseSecretRef(secretRef);
    if (parsed.kind !== "keychain") {
      throw new Error("Web token setup requires a keychain: secretRef.");
    }
    return secretRef;
  }
  return `keychain:${defaultExternalWorkSecretName(workflowDefinition)}`;
}

export function externalWorkSecretPurpose(sourceKind: ExternalSourceKind): "github_token" | "linear_token" {
  return sourceKind === "github" ? "github_token" : "linear_token";
}

export function updateExternalWorkWorkflowSecretRefIfNeeded(path: string, markdown: string, secretRef: string, shouldUpdate: boolean): boolean {
  if (!shouldUpdate) {
    return false;
  }
  const current = parseExternalWorkflowMarkdown(markdown).config.source.secretRef;
  if (current === secretRef) {
    return false;
  }
  writeFileSync(path, updateExternalWorkflowSecretRef(markdown, secretRef), "utf8");
  return true;
}

export function readExternalWorkflowMarkdown(
  input: { readonly workflowMarkdown?: string; readonly workflowPath?: string },
  channel: Channel,
  cwd: string,
): string {
  return readExternalWorkflowFile(input, channel, cwd).markdown;
}

export function readExternalWorkflowFile(
  input: { readonly workflowMarkdown?: string; readonly workflowPath?: string },
  channel: Channel | undefined,
  cwd: string,
): { readonly markdown: string; readonly path?: string; readonly directory: string } {
  if (input.workflowMarkdown !== undefined) {
    const root = channel?.boundPath ?? cwd;
    return { markdown: input.workflowMarkdown, directory: root };
  }
  const root = channel?.boundPath ?? cwd;
  const workflowPath = input.workflowPath
    ? isAbsolute(input.workflowPath)
      ? input.workflowPath
      : resolvePath(root, input.workflowPath)
    : resolvePath(root, "WORKFLOW.md");
  let rootRealPath: string;
  let workflowRealPath: string;
  try {
    rootRealPath = realpathSync(root);
    workflowRealPath = realpathSync(workflowPath);
  } catch (error) {
    throw new Error(`Workflow file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPathInsideRoot(rootRealPath, workflowRealPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  return {
    markdown: readFileSync(workflowRealPath, "utf8"),
    path: workflowRealPath,
    directory: resolvePath(workflowRealPath, ".."),
  };
}

export function resolveExternalGitHubToken(workflowDefinition: ExternalWorkflowDefinition, secretResolver: SecretResolver): string | undefined {
  return resolveExternalSourceToken(workflowDefinition, secretResolver, "github_token", "GitHub");
}

export function resolveExternalSourceToken(
  workflowDefinition: ExternalWorkflowDefinition,
  secretResolver: SecretResolver,
  purpose: SecretPurpose,
  label: string,
): string | undefined {
  const secretRef = workflowDefinition.config.source.secretRef;
  if (!secretRef) {
    return undefined;
  }
  const secret = secretResolver.resolve(secretRef, purpose);
  if (!secret.configured || !secret.value) {
    throw new Error(secret.status?.message ?? `${label} token is not configured: ${secretRef}`);
  }
  return secret.value;
}

function defaultExternalWorkSecretName(workflowDefinition: ExternalWorkflowDefinition): string {
  const source = workflowDefinition.config.source;
  const target = source.kind === "github" ? source.repository : source.projectSlug;
  const suffix = (target ?? "default")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 80) || "DEFAULT";
  return `LING_STACK_${source.kind.toUpperCase()}_${suffix}_TOKEN`;
}

function statFileIfPresent(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
