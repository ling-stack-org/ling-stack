import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  createMediaProjectAssetId,
  type MediaProject,
  type MediaProjectAsset,
  type MediaProjectAssetContentType,
  type RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { isPathInsideRoot, normalizeArtifactPath } from "../../shared/path.js";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import { isRecord, readString } from "../../shared/validation.js";
import { resolveArtifactContentPath } from "../runs/artifacts.js";
import { inspectSupportedImage } from "./image-inspection.js";

const MEDIA_PROJECT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_PROJECT_ASSET_REQUEST_MAX_BYTES = 40 * 1024 * 1024;
const MEDIA_PROJECT_ASSET_MIN_DIMENSION = 300;
const MEDIA_PROJECT_ASSET_MAX_DIMENSION = 6000;
const MEDIA_PROJECT_ASSET_MIN_RATIO = 0.4;
const MEDIA_PROJECT_ASSET_MAX_RATIO = 2.5;

export function assertMediaProjectAssetByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MEDIA_PROJECT_ASSET_MAX_BYTES) {
    throw new HttpError(400, "invalid_media_asset", "图片大小必须在 1 字节到 25 MiB 之间。");
  }
}

export function assertMediaProjectAssetDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MEDIA_PROJECT_ASSET_MIN_DIMENSION ||
    width > MEDIA_PROJECT_ASSET_MAX_DIMENSION ||
    height < MEDIA_PROJECT_ASSET_MIN_DIMENSION ||
    height > MEDIA_PROJECT_ASSET_MAX_DIMENSION
  ) {
    throw new HttpError(400, "invalid_media_asset", "图片宽高必须在 300 到 6000 像素之间。");
  }
  const ratio = width / height;
  if (ratio < MEDIA_PROJECT_ASSET_MIN_RATIO || ratio > MEDIA_PROJECT_ASSET_MAX_RATIO) {
    throw new HttpError(400, "invalid_media_asset", "图片宽高比必须在 0.4 到 2.5 之间。");
  }
}

type CreateMediaProjectAssetBody =
  | {
      readonly kind: "upload";
      readonly fileName: string;
      readonly contentType: string;
      readonly contentBase64: string;
    }
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
    };

export interface MediaProjectAssetRoute {
  readonly mediaProjectAssetId: string;
  readonly action?: "content";
}

export function parseMediaProjectAssetRoute(pathname: string): MediaProjectAssetRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-project-assets") {
    return { mediaProjectAssetId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "media-project-assets" && segments[2] === "content") {
    return { mediaProjectAssetId: segments[1], action: "content" };
  }
  return undefined;
}

export async function handleMediaProjectAssetsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  project: MediaProject,
): Promise<void> {
  if (request.method === "GET") {
    writeJson(response, 200, {
      mediaProjectId: project.id,
      assets: store.listMediaProjectAssets(project.id).map(toPublicMediaProjectAsset),
    });
    return;
  }
  if (request.method !== "POST") {
    methodNotAllowed(response, request.method, "/media-projects/:id/assets");
    return;
  }
  const body = parseCreateMediaProjectAssetBody(
    await readJsonBody(request, Math.max(config.maxBodyBytes, MEDIA_PROJECT_ASSET_REQUEST_MAX_BYTES)),
  );
  const asset = await persistMediaProjectAsset(store, project, body);
  writeJson(response, 201, { asset: toPublicMediaProjectAsset(asset) });
}

export function handleMediaProjectAssetRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: MediaProjectAssetRoute,
): void {
  const cwd = requestUrl(request, config).searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const asset = store.getMediaProjectAsset(route.mediaProjectAssetId);
    if (!asset) {
      throw new HttpError(404, "media_project_asset_not_found", `项目图片素材不存在：${route.mediaProjectAssetId}`);
    }
    if (route.action === "content") {
      handleMediaProjectAssetContent(request, response, store, asset);
      return;
    }
    if (request.method !== "DELETE") {
      methodNotAllowed(response, request.method, "/media-project-assets/:id");
      return;
    }
    const usageCount = countAssetUsage(store, asset);
    if (usageCount > 0) {
      throw new HttpError(409, "media_project_asset_in_use", `该图片正被 ${usageCount} 个场景使用，请先从场景中移除。`);
    }
    const contentDeletion = stageAssetContentDeletion(store, asset);
    try {
      if (!store.deleteMediaProjectAsset(asset.id)) {
        throw new HttpError(404, "media_project_asset_not_found", `项目图片素材不存在：${asset.id}`);
      }
    } catch (error) {
      contentDeletion.rollback();
      throw error;
    }
    contentDeletion.commit();
    writeJson(response, 200, { deleted: true, mediaProjectAssetId: asset.id });
  } catch (error) {
    writeMediaProjectAssetError(response, error);
  }
}

export function stageMediaProjectAssetContentsForDeletion(
  store: RunStore,
  project: MediaProject,
  assets: readonly MediaProjectAsset[],
): { readonly commit: () => void; readonly rollback: () => void } {
  const staged: Array<ReturnType<typeof stageAssetContentDeletion>> = [];
  try {
    for (const asset of assets) staged.push(stageAssetContentDeletion(store, asset));
  } catch (error) {
    for (const deletion of [...staged].reverse()) deletion.rollback();
    throw error;
  }
  const projectDirectory = resolveMediaProjectDirectoryPath(store.paths.attachmentsDir, project.id);
  return {
    commit: () => {
      for (const deletion of staged) deletion.commit();
      if (isPathInsideRoot(store.paths.attachmentsDir, projectDirectory)) {
        try {
          rmSync(projectDirectory, { recursive: true, force: true });
        } catch {
          // The durable records are gone; a hidden tombstone may be cleaned on a later project removal.
        }
      }
    },
    rollback: () => {
      for (const deletion of [...staged].reverse()) deletion.rollback();
    },
  };
}

export function resolveMediaProjectAssetContentPath(store: Pick<RunStore, "paths">, asset: MediaProjectAsset): string {
  if (isAbsolute(asset.path)) {
    throw new HttpError(403, "media_project_asset_outside_root", "项目图片素材路径超出当前工作区。");
  }
  const projectDirectory = resolveMediaProjectDirectoryPath(store.paths.attachmentsDir, asset.projectId);
  const absolutePath = resolvePath(store.paths.attachmentsDir, normalizeArtifactPath(asset.path));
  if (!isPathInsideRoot(projectDirectory, absolutePath)) {
    throw new HttpError(403, "media_project_asset_outside_root", "项目图片素材路径超出当前媒体项目。");
  }
  assertPathWithinRealRoot(store.paths.attachmentsDir, absolutePath);
  return absolutePath;
}

export function toPublicMediaProjectAsset(asset: MediaProjectAsset): Omit<MediaProjectAsset, "path"> {
  return {
    id: asset.id,
    projectId: asset.projectId,
    fileName: asset.fileName,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    checksum: asset.checksum,
    ...(asset.sourceArtifactId ? { sourceArtifactId: asset.sourceArtifactId } : {}),
    createdAt: asset.createdAt,
  };
}

async function persistMediaProjectAsset(
  store: RunStore,
  project: MediaProject,
  body: CreateMediaProjectAssetBody,
): Promise<MediaProjectAsset> {
  const source = readAssetSource(store, body);
  const validated = await validateImageBytes(source.content, body.kind === "upload" ? body.contentType : undefined);
  const checksum = `sha256:${createHash("sha256").update(source.content).digest("hex")}`;
  const existing = store.findMediaProjectAssetByChecksum(project.id, checksum);
  if (existing) {
    return existing;
  }

  const assetId = createMediaProjectAssetId();
  const extension = extensionForContentType(validated.contentType);
  const relativePath = normalizeArtifactPath(join("media-projects", project.id, `${assetId}${extension}`));
  const projectDirectory = resolveMediaProjectDirectoryPath(store.paths.attachmentsDir, project.id);
  const absolutePath = resolvePath(projectDirectory, `${assetId}${extension}`);
  assertPathWithinRealRoot(store.paths.attachmentsDir, absolutePath);
  const temporaryPath = `${absolutePath}.tmp-${randomUUID()}`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  assertPathWithinRealRoot(store.paths.attachmentsDir, absolutePath);
  try {
    writeFileSync(temporaryPath, source.content, { flag: "wx" });
    renameSync(temporaryPath, absolutePath);
    const asset = store.createMediaProjectAsset({
      id: assetId,
      projectId: project.id,
      fileName: normalizeDisplayFileName(source.fileName, extension),
      contentType: validated.contentType,
      sizeBytes: source.content.byteLength,
      width: validated.width,
      height: validated.height,
      checksum,
      sourceArtifactId: source.sourceArtifactId,
      path: relativePath,
    }, new Date().toISOString());
    if (asset.path !== relativePath) {
      rmSync(absolutePath, { force: true });
    }
    return asset;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(absolutePath, { force: true });
    throw error;
  }
}

function readAssetSource(
  store: RunStore,
  body: CreateMediaProjectAssetBody,
): { readonly content: Buffer; readonly fileName: string; readonly sourceArtifactId?: string } {
  if (body.kind === "upload") {
    return {
      content: decodeBase64(body.contentBase64),
      fileName: sanitizeDisplayFileName(body.fileName),
    };
  }
  const artifact = store.getArtifact(body.artifactId);
  if (!artifact || artifact.type !== "image") {
    throw new HttpError(400, "invalid_media_artifact", "只能从当前工作区导入已有图片结果。");
  }
  const path = resolveArtifactContentPath(store, artifact);
  assertPathWithinRealRoot(store.paths.artifactsDir, path);
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new HttpError(400, "invalid_media_asset", "图片结果不存在或不是文件。");
  }
  assertMediaProjectAssetByteLength(stats.size);
  return {
    content: readFileSync(path),
    fileName: sanitizeDisplayFileName(basename(artifact.path) || artifact.title || `${artifact.id}.png`),
    sourceArtifactId: artifact.id,
  };
}

async function validateImageBytes(
  content: Buffer,
  declaredContentType: string | undefined,
): Promise<{ readonly contentType: MediaProjectAssetContentType; readonly width: number; readonly height: number }> {
  assertMediaProjectAssetByteLength(content.byteLength);
  const inspection = inspectSupportedImage(content);
  if (!inspection) {
    throw new HttpError(400, "invalid_media_asset", "图片结构无效，只支持完整的 JPEG、PNG 或 WebP 图片。");
  }
  if (declaredContentType && declaredContentType !== inspection.contentType) {
    throw new HttpError(400, "invalid_media_asset", "图片声明格式与实际内容不一致。");
  }
  assertMediaProjectAssetDimensions(inspection.width, inspection.height);
  return inspection;
}

function handleMediaProjectAssetContent(
  request: IncomingMessage,
  response: ServerResponse,
  store: RunStore,
  asset: MediaProjectAsset,
): void {
  if (request.method !== "GET") {
    methodNotAllowed(response, request.method, "/media-project-assets/:id/content");
    return;
  }
  const path = resolveMediaProjectAssetContentPath(store, asset);
  const stats = lstatSync(path);
  if (!stats.isFile()) {
    throw new HttpError(404, "media_project_asset_content_not_found", "项目图片素材文件不存在。");
  }
  const content = readFileSync(path);
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": String(content.byteLength),
    "Content-Disposition": `inline; filename="${asset.fileName.replace(/"/g, "")}"`,
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function stageAssetContentDeletion(
  store: RunStore,
  asset: MediaProjectAsset,
): { readonly commit: () => void; readonly rollback: () => void } {
  const path = resolveMediaProjectAssetContentPath(store, asset);
  const stagedPath = `${path}.delete-${randomUUID()}`;
  let staged = false;
  try {
    renameSync(path, stagedPath);
    staged = true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  return {
    commit: () => {
      if (!staged) return;
      try {
        rmSync(stagedPath, { force: true });
        staged = false;
      } catch {
        // The database row is already gone. Leave the hidden tombstone for project cleanup.
      }
    },
    rollback: () => {
      if (!staged) return;
      renameSync(stagedPath, path);
      staged = false;
    },
  };
}

function countAssetUsage(store: RunStore, asset: MediaProjectAsset): number {
  return store.listMediaScenes(asset.projectId)
    .filter((scene) => scene.videoImageInputs.some((input) => input.assetId === asset.id))
    .length;
}

function parseCreateMediaProjectAssetBody(value: unknown): CreateMediaProjectAssetBody {
  if (!isRecord(value)) {
    throw new Error("项目图片素材请求必须是 JSON 对象");
  }
  const kind = readString(value, "kind");
  if (kind === "upload") {
    return {
      kind,
      fileName: readString(value, "fileName"),
      contentType: readString(value, "contentType"),
      contentBase64: readString(value, "contentBase64"),
    };
  }
  if (kind === "artifact") {
    return { kind, artifactId: readString(value, "artifactId") };
  }
  throw new Error("kind 必须是 upload 或 artifact");
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new HttpError(400, "invalid_media_asset", "图片内容不是有效的 Base64。");
  }
  const content = Buffer.from(value, "base64");
  if (content.toString("base64") !== value) {
    throw new HttpError(400, "invalid_media_asset", "图片内容不是规范的 Base64。");
  }
  return content;
}

function sanitizeDisplayFileName(value: string): string {
  const fileName = basename(value.trim()).replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").trim();
  if (!fileName || value.includes("/") || value.includes("\\")) {
    throw new HttpError(400, "invalid_media_asset", "图片文件名无效。");
  }
  return fileName.slice(0, 160);
}

function normalizeDisplayFileName(fileName: string, extension: string): string {
  return extname(fileName) ? fileName : `${fileName}${extension}`;
}

function extensionForContentType(contentType: MediaProjectAssetContentType): string {
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "image/webp") return ".webp";
  return ".png";
}

function resolveMediaProjectDirectoryPath(attachmentsRoot: string, projectId: string): string {
  const projectDirectory = resolvePath(attachmentsRoot, "media-projects", projectId);
  if (!isPathInsideRoot(attachmentsRoot, projectDirectory)) {
    throw new HttpError(403, "media_project_asset_outside_root", "媒体项目素材目录超出当前工作区。");
  }
  assertPathWithinRealRoot(attachmentsRoot, projectDirectory);
  return projectDirectory;
}

function assertPathWithinRealRoot(root: string, candidate: string): void {
  const lexicalRoot = resolvePath(root);
  const lexicalCandidate = resolvePath(candidate);
  if (!isPathInsideRoot(lexicalRoot, lexicalCandidate)) {
    throw new HttpError(403, "media_project_asset_outside_root", "项目图片素材路径超出当前工作区。");
  }
  const realRoot = resolveThroughExistingAncestor(lexicalRoot);
  const realCandidate = resolveThroughExistingAncestor(lexicalCandidate);
  if (!isPathInsideRoot(realRoot, realCandidate)) {
    throw new HttpError(403, "media_project_asset_outside_root", "项目图片素材真实路径超出当前工作区。");
  }
  assertNoSymlinkComponents(lexicalRoot, lexicalCandidate);
}

function resolveThroughExistingAncestor(path: string): string {
  const ancestor = nearestExistingAncestor(path);
  return resolvePath(realpathSync(ancestor), relative(ancestor, path));
}

function nearestExistingAncestor(path: string): string {
  let current = resolvePath(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function assertNoSymlinkComponents(root: string, candidate: string): void {
  const relativePath = relative(resolvePath(root), resolvePath(candidate));
  let current = resolvePath(root);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new HttpError(403, "media_project_asset_outside_root", "项目图片素材路径不能经过符号链接。");
    }
  }
}

function requestUrl(request: IncomingMessage, config: ResolvedDaemonConfig): URL {
  return new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
}

function methodNotAllowed(response: ServerResponse, method: string | undefined, path: string): void {
  writeJson(response, 405, { error: "method_not_allowed", message: `${method ?? "UNKNOWN"} is not allowed for ${path}` });
}

function writeMediaProjectAssetError(response: ServerResponse, error: unknown): void {
  const statusCode = error instanceof HttpError ? error.statusCode : 400;
  writeJson(response, statusCode, {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}
