import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { MediaJob, RunStore } from "@ling-stack/core";
import type { MediaExecutionVideoImageInput } from "@ling-stack/providers";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { resolveMediaProjectAssetContentPath } from "./project-asset-routes.js";

const MAX_PROVIDER_IMAGE_INPUT_BYTES = 45 * 1024 * 1024;

export function assertProviderImageInputTotalBytes(totalBytes: number): void {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_PROVIDER_IMAGE_INPUT_BYTES) {
    throw invalidMediaAsset("一次生成使用的图片总大小不能超过 45 MiB。");
  }
}

type VideoImageMaterializationStore = Pick<
  RunStore,
  "paths" | "getMediaProjectAsset" | "getMediaSceneRunByMediaJobId"
>;

interface PersistedVideoImageInput {
  readonly assetId: string;
  readonly role: MediaExecutionVideoImageInput["role"];
  readonly checksum: string;
}

export function materializeMediaJobVideoImageInputs(
  store: VideoImageMaterializationStore,
  job: MediaJob,
): readonly MediaExecutionVideoImageInput[] {
  const references = parsePersistedVideoImageInputs(job.input.videoImageInputs);
  if (references.length === 0) {
    return [];
  }
  const sceneRun = store.getMediaSceneRunByMediaJobId(job.id);
  if (!sceneRun) {
    throw invalidMediaAsset("图片输入缺少对应的场景运行记录。");
  }

  let totalBytes = 0;
  return references.map((reference) => {
    const asset = store.getMediaProjectAsset(reference.assetId);
    if (!asset || asset.projectId !== sceneRun.projectId) {
      throw invalidMediaAsset("场景图片不属于当前媒体项目。");
    }
    if (asset.checksum !== reference.checksum) {
      throw invalidMediaAsset("场景图片记录已发生变化，请重新选择后再生成。");
    }

    let content: Buffer;
    try {
      const path = resolveMediaProjectAssetContentPath(store, asset);
      const stats = statSync(path);
      if (!stats.isFile() || stats.size !== asset.sizeBytes) {
        throw invalidMediaAsset("场景图片文件不存在或大小已发生变化。");
      }
      totalBytes += stats.size;
      assertProviderImageInputTotalBytes(totalBytes);
      content = readFileSync(path);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw invalidMediaAsset("场景图片文件无法读取，请重新上传后再试。");
    }

    const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (content.byteLength !== asset.sizeBytes || checksum !== asset.checksum) {
      throw invalidMediaAsset("场景图片校验失败，请重新上传后再试。");
    }
    return {
      role: reference.role,
      imageUrl: `data:${asset.contentType};base64,${content.toString("base64")}`,
    };
  });
}

function parsePersistedVideoImageInputs(value: unknown): readonly PersistedVideoImageInput[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidMediaAsset("场景图片运行快照无效，请重新生成该场景。");
  }
  const result: PersistedVideoImageInput[] = [];
  const assetIds = new Set<string>();
  let role: PersistedVideoImageInput["role"] | undefined;
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.assetId !== "string" ||
      !item.assetId ||
      (item.role !== "first_frame" && item.role !== "reference_image") ||
      typeof item.checksum !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(item.checksum)
    ) {
      throw invalidMediaAsset("场景图片运行快照无效，请重新生成该场景。");
    }
    if (assetIds.has(item.assetId) || (role && role !== item.role)) {
      throw invalidMediaAsset("场景图片运行快照包含重复素材或混合用途。");
    }
    assetIds.add(item.assetId);
    role = item.role;
    result.push({ assetId: item.assetId, role: item.role, checksum: item.checksum });
  }
  return result;
}

function invalidMediaAsset(message: string): HttpError {
  return new HttpError(400, "invalid_media_asset", message);
}
