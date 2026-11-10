import { BACKGROUND_LIMITS, BackgroundError, backgroundDigest, backgroundOutputDimensions, backgroundVideoMimeType,
  checkBackgroundDimensions, checkBackgroundVideoMetadata, inspectBackgroundImage, parseBackgroundAsset,
  type BackgroundImage, type BackgroundVideoMimeType, type PrepareBackgroundRequest } from "@ling-stack/ui-react/theme";

export async function prepareWebBackground(request: PrepareBackgroundRequest, signal: AbortSignal): Promise<BackgroundImage> {
  const videoType = backgroundVideoMimeType(request.bytes, request.fileName, request.mimeType);
  if (videoType) return prepareWebVideoBackground(request, videoType, signal);
  const header = inspectBackgroundImage(request.bytes, request.fileName, request.mimeType);
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(request.bytes)], { type: header.mimeType }),
    { imageOrientation: "from-image", colorSpaceConversion: "default" });
  try {
    signal.throwIfAborted();
    checkBackgroundDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    const output = backgroundOutputDimensions(bitmap.width, bitmap.height);
    canvas.width = output.width; canvas.height = output.height;
    try {
      const context = canvas.getContext("2d", { colorSpace: "srgb" });
      if (!context) throw new BackgroundError("unavailable");
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, output.width, output.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new BackgroundError("invalid-image")), "image/png"));
      signal.throwIfAborted();
      if (blob.size > BACKGROUND_LIMITS.bytes) throw new BackgroundError("capacity");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const normalized = inspectBackgroundImage(bytes);
      const asset = parseBackgroundAsset({ kind: "image", assetId: await backgroundDigest(bytes), mimeType: normalized.mimeType,
        byteLength: bytes.length, width: normalized.width, height: normalized.height });
      return { asset, bytes };
    } finally { canvas.width = 0; canvas.height = 0; }
  } catch (error) {
    if (signal.aborted) throw new BackgroundError("aborted");
    throw error;
  } finally { bitmap.close(); }
}

export async function readVideoBackgroundMetadata(bytes: Uint8Array, fileName: string, mimeType: string, signal?: AbortSignal): Promise<{
  readonly mimeType: BackgroundVideoMimeType;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}> {
  const videoType = backgroundVideoMimeType(bytes, fileName, mimeType);
  if (!videoType) throw new BackgroundError("invalid-image");
  const metadata = await loadVideoMetadata(bytes, videoType, signal);
  checkBackgroundVideoMetadata(metadata.videoWidth, metadata.videoHeight, metadata.duration);
  return Object.freeze({ mimeType: videoType, width: metadata.videoWidth, height: metadata.videoHeight, duration: metadata.duration });
}

async function prepareWebVideoBackground(request: PrepareBackgroundRequest, videoType: BackgroundVideoMimeType, signal: AbortSignal): Promise<BackgroundImage> {
  const metadata = await readVideoBackgroundMetadata(request.bytes, request.fileName, videoType, signal);
  if (request.width !== metadata.width || request.height !== metadata.height || Math.abs((request.duration ?? 0) - metadata.duration) > 0.05) {
    throw new BackgroundError("invalid-request");
  }
  const bytes = new Uint8Array(request.bytes);
  const asset = parseBackgroundAsset({ kind: "video", assetId: await backgroundDigest(bytes), mimeType: metadata.mimeType,
    byteLength: bytes.length, width: metadata.width, height: metadata.height, duration: metadata.duration });
  return { asset, bytes };
}

export async function verifyBackgroundImage(image: BackgroundImage): Promise<BackgroundImage> {
  const asset = parseBackgroundAsset(image.asset);
  if (!(image.bytes instanceof Uint8Array) || image.bytes.length !== asset.byteLength
    || await backgroundDigest(image.bytes) !== asset.assetId) throw new BackgroundError("corrupt");
  if (asset.kind === "video") {
    const metadata = await readVideoBackgroundMetadata(image.bytes, `background.${asset.mimeType === "video/mp4" ? "mp4" : "webm"}`, asset.mimeType);
    if (metadata.width !== asset.width || metadata.height !== asset.height || Math.abs(metadata.duration - asset.duration) > 0.05) throw new BackgroundError("corrupt");
    return { asset, bytes: image.bytes };
  }
  const header = inspectBackgroundImage(image.bytes);
  if (header.mimeType !== "image/png" || header.width !== asset.width || header.height !== asset.height) throw new BackgroundError("corrupt");
  return { asset, bytes: image.bytes };
}

function loadVideoMetadata(bytes: Uint8Array, mimeType: BackgroundVideoMimeType, signal?: AbortSignal): Promise<{
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly duration: number;
}> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    const video = document.createElement("video");
    let settled = false;
    const timer = window.setTimeout(() => finish(undefined, new BackgroundError("invalid-image")), 10_000);
    const finish = (value?: HTMLVideoElement, error?: unknown) => {
      if (settled) return;
      settled = true;
      const metadata = value ? { videoWidth: value.videoWidth, videoHeight: value.videoHeight, duration: value.duration } : undefined;
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (metadata) resolve(metadata);
      else reject(error instanceof BackgroundError ? error : new BackgroundError("invalid-image"));
    };
    const abort = () => finish(undefined, new BackgroundError("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => finish(video);
    video.onerror = () => finish(undefined, new BackgroundError("invalid-image"));
    video.src = url;
  });
}
