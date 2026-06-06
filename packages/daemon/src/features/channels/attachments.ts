import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ChannelAttachment, ChannelAttachmentKind, RunStore, TeammatePrivateAttachment } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { isPathInsideRoot, normalizeArtifactPath } from "../../shared/path.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import { formatTimestampSlug } from "../../shared/time.js";
import { buildAttachmentPreview } from "../previews/content-preview.js";
import { validateChannelMessageOwner } from "./protocol.js";
import { parseChannelAttachmentRequest, type ChannelAttachmentRequest } from "./schemas.js";

const CHANNEL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES = 40 * 1024 * 1024;

export type PersistTeammatePrivateAttachmentInput = ChannelAttachmentRequest & {
  readonly scope: "teammate_direct_thread" | "teammate_profile_avatar";
  readonly threadId?: string;
};

export async function handleChannelAttachmentsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        attachments: store.listChannelAttachments({ channelId, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, Math.max(config.maxBodyBytes, CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES));
      const input = parseChannelAttachmentRequest(body);
      const messageError = input.messageId ? validateChannelMessageOwner(store, channelId, input.messageId) : undefined;
      if (messageError) {
        writeJson(response, messageError.statusCode, { error: messageError.code, message: messageError.message });
        return;
      }
      const attachment = persistChannelAttachment(store, channelId, input);
      writeJson(response, 201, { attachment });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel attachments` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelAttachmentItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly attachmentId: string; readonly action?: "content" | "preview" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const attachment = store.getChannelAttachment(route.attachmentId);
    const privateAttachment = attachment ? undefined : store.getTeammatePrivateAttachment(route.attachmentId);
    const resolvedAttachment = attachment ?? privateAttachment;
    if (!resolvedAttachment) {
      writeJson(response, 404, { error: "attachment_not_found", message: `Attachment not found: ${route.attachmentId}` });
      return;
    }

    if (request.method === "GET" && route.action === "content") {
      handleGetAttachmentContent(response, store, resolvedAttachment);
      return;
    }

    if (request.method === "GET" && route.action === "preview") {
      if (!attachmentPreviewScopeMatches(url, resolvedAttachment)) {
        writeJson(response, 404, { error: "attachment_not_found", message: "Attachment preview was not found for this scope." });
        return;
      }
      handleGetAttachmentPreview(response, url, store, resolvedAttachment);
      return;
    }

    if (request.method === "GET" && !route.action) {
      writeJson(response, 200, { attachment: resolvedAttachment });
      return;
    }

    if (request.method === "DELETE" && !route.action) {
      deleteAttachmentContent(store, resolvedAttachment);
      if (attachment) {
        store.deleteChannelAttachment(route.attachmentId);
      } else if (privateAttachment) {
        const owner = store.getAiTeammate(privateAttachment.teammateId);
        if (owner?.avatarImageAttachmentId === privateAttachment.id) {
          store.updateAiTeammate(owner.id, { avatarImageAttachmentId: null }, new Date().toISOString());
        }
        store.deleteTeammatePrivateAttachment(route.attachmentId);
      }
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel attachment` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function attachmentPreviewScopeMatches(url: URL, attachment: ChannelAttachment | TeammatePrivateAttachment): boolean {
  const scope = url.searchParams.get("scope");
  const channelId = url.searchParams.get("channelId");
  const teammateId = url.searchParams.get("teammateId");
  if ("scope" in attachment) {
    if (scope && scope !== "teammate_private") {
      return false;
    }
    if (channelId) {
      return false;
    }
    return !teammateId || teammateId === attachment.teammateId;
  }

  if (scope && scope !== "channel") {
    return false;
  }
  if (teammateId) {
    return false;
  }
  return !channelId || channelId === attachment.channelId;
}

function persistChannelAttachment(store: RunStore, channelId: string, input: ChannelAttachmentRequest): ChannelAttachment {
  const safeFileName = sanitizeAttachmentFileName(input.fileName);
  const inferred = inferChannelAttachmentKind(safeFileName, input.contentType);
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.byteLength === 0) {
    throw new Error("Attachment content is empty");
  }
  if (content.byteLength > CHANNEL_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachment exceeds ${CHANNEL_ATTACHMENT_MAX_BYTES} bytes`);
  }

  const now = new Date().toISOString();
  const storageName = `${formatTimestampSlug(now)}-${safeFileName}`;
  const relativePath = normalizeArtifactPath(join(channelId, storageName));
  const absoluteDir = resolvePath(store.paths.attachmentsDir, channelId);
  const absolutePath = resolvePath(store.paths.attachmentsDir, relativePath);
  if (!isPathInsideRoot(store.paths.attachmentsDir, absolutePath)) {
    throw new Error("Attachment content path is outside .ling-stack/attachments");
  }
  mkdirSync(absoluteDir, { recursive: true });
  writeFileSync(absolutePath, content);

  return store.createChannelAttachment({
    channelId,
    messageId: input.messageId,
    kind: inferred.kind,
    fileName: safeFileName,
    contentType: inferred.contentType,
    sizeBytes: content.byteLength,
    path: relativePath,
    createdAt: now,
  });
}

export function persistTeammatePrivateAttachment(
  store: RunStore,
  teammateId: string,
  input: PersistTeammatePrivateAttachmentInput,
): TeammatePrivateAttachment {
  const safeFileName = sanitizeAttachmentFileName(input.fileName);
  const inferred = inferChannelAttachmentKind(safeFileName, input.contentType);
  if (input.scope === "teammate_profile_avatar" && inferred.kind !== "image") {
    throw new Error("Avatar upload must be an image attachment");
  }
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.byteLength === 0) {
    throw new Error("Attachment content is empty");
  }
  if (content.byteLength > CHANNEL_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachment exceeds ${CHANNEL_ATTACHMENT_MAX_BYTES} bytes`);
  }

  const now = new Date().toISOString();
  const storageName = `${formatTimestampSlug(now)}-${safeFileName}`;
  const scopeDir = input.scope === "teammate_profile_avatar" ? "avatar" : `direct/${input.threadId ?? "thread"}`;
  const relativePath = normalizeArtifactPath(join("teammates", teammateId, scopeDir, storageName));
  const absoluteDir = resolvePath(store.paths.attachmentsDir, "teammates", teammateId, scopeDir);
  const absolutePath = resolvePath(store.paths.attachmentsDir, relativePath);
  if (!isPathInsideRoot(store.paths.attachmentsDir, absolutePath)) {
    throw new Error("Attachment content path is outside .ling-stack/attachments");
  }
  mkdirSync(absoluteDir, { recursive: true });
  writeFileSync(absolutePath, content);

  return store.createTeammatePrivateAttachment({
    teammateId,
    threadId: input.threadId,
    messageId: input.messageId,
    scope: input.scope,
    kind: inferred.kind,
    fileName: safeFileName,
    contentType: inferred.contentType,
    sizeBytes: content.byteLength,
    path: relativePath,
    createdAt: now,
  });
}

function sanitizeAttachmentFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (trimmed !== basename(trimmed) || trimmed.includes("\\") || trimmed.includes("/")) {
    throw new Error("fileName must not contain path separators");
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").trim();
  if (!safe) {
    throw new Error("fileName must contain a safe filename");
  }
  inferChannelAttachmentKind(safe);
  return safe.slice(0, 160);
}

function inferChannelAttachmentKind(fileName: string, _contentType?: string): { readonly kind: ChannelAttachmentKind; readonly contentType: string } {
  const extension = extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    return { kind: "image", contentType: imageContentTypeForExtension(extension) };
  }
  if (extension === ".pdf") {
    return { kind: "pdf", contentType: "application/pdf" };
  }
  if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
    return { kind: "office", contentType: officeContentTypeForExtension(extension) };
  }
  if ([".txt", ".md", ".csv", ".json", ".log"].includes(extension)) {
    return { kind: "text", contentType: textContentTypeForExtension(extension) };
  }
  throw new Error("Unsupported attachment type. Allowed: png, jpg, jpeg, webp, gif, pdf, docx, xlsx, pptx, txt, md, csv, json, log");
}

function imageContentTypeForExtension(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return "image/png";
}

function officeContentTypeForExtension(extension: string): string {
  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function textContentTypeForExtension(extension: string): string {
  if (extension === ".md") {
    return "text/markdown; charset=utf-8";
  }
  if (extension === ".csv") {
    return "text/csv; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function handleGetAttachmentContent(response: ServerResponse, store: RunStore, attachment: ChannelAttachment | TeammatePrivateAttachment): void {
  let contentPath: string;
  try {
    contentPath = resolveAttachmentContentPath(store, attachment);
  } catch (error) {
    writeJson(response, 403, {
      error: "attachment_outside_root",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const stats = statSync(contentPath);
    if (!stats.isFile()) {
      writeJson(response, 404, {
        error: "attachment_content_not_found",
        message: `Attachment content is not a file: ${attachment.id}`,
      });
      return;
    }
    const content = readFileSync(contentPath);
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": attachment.contentType,
      "Content-Length": String(content.byteLength),
      "Content-Disposition": `inline; filename="${attachment.fileName.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    writeJson(response, 404, {
      error: "attachment_content_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleGetAttachmentPreview(response: ServerResponse, url: URL, store: RunStore, attachment: ChannelAttachment | TeammatePrivateAttachment): void {
  let contentPath: string;
  try {
    contentPath = resolveAttachmentContentPath(store, attachment);
  } catch (error) {
    writeJson(response, 403, {
      error: "attachment_outside_root",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const maxBytes = readOptionalIntegerQuery(url, "maxBytes", 1);
    writeJson(response, 200, buildAttachmentPreview({
      attachment,
      contentPath,
      maxBytes,
      imageUrl: attachment.kind === "image" ? attachmentContentUrl(url, attachment.id) : undefined,
    }));
  } catch (error) {
    writeJson(response, 404, {
      error: "attachment_preview_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function deleteAttachmentContent(store: RunStore, attachment: ChannelAttachment | TeammatePrivateAttachment): void {
  try {
    unlinkSync(resolveAttachmentContentPath(store, attachment));
  } catch {
    // Missing files should not block metadata cleanup.
  }
}

export function deleteAttachmentPath(store: RunStore, path: string): void {
  try {
    unlinkSync(resolveAttachmentPath(store, path));
  } catch {
    // Missing files should not block hard delete completion.
  }
}

export function resolveAttachmentContentPath(store: RunStore, attachment: ChannelAttachment | TeammatePrivateAttachment): string {
  return resolveAttachmentPath(store, attachment.path);
}

function attachmentContentUrl(url: URL, attachmentId: string): string {
  const previewCwd = url.searchParams.get("cwd");
  const query = new URLSearchParams();
  if (previewCwd) {
    query.set("cwd", previewCwd);
  }
  return `${url.origin}/attachments/${encodeURIComponent(attachmentId)}/content${query.size > 0 ? `?${query.toString()}` : ""}`;
}

function resolveAttachmentPath(store: RunStore, path: string): string {
  const absolutePath = isAbsolute(path)
    ? path
    : resolvePath(store.paths.attachmentsDir, path);
  if (!isPathInsideRoot(store.paths.attachmentsDir, absolutePath)) {
    throw new Error(`Attachment content path is outside .ling-stack/attachments: ${path}`);
  }
  return absolutePath;
}
