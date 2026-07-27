import {
  analyzeThemeImage,
  type ThemeImageAnalysis,
} from "@ling-stack/ui-react/theme";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_EDGE = 8192;
const MAX_SOURCE_PIXELS = 32_000_000;
const MAX_SAMPLE_EDGE = 128;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type QuickThemeImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export type QuickThemeImageIssueCode =
  | "aborted"
  | "decode-failed"
  | "invalid-dimensions"
  | "invalid-extension"
  | "invalid-mime"
  | "sample-failed"
  | "source-empty"
  | "source-too-large";

export interface QuickThemeImageIssue {
  readonly code: QuickThemeImageIssueCode;
  readonly message: string;
}

export interface AnalyzedWebQuickThemeImage {
  readonly analysis: ThemeImageAnalysis;
  readonly blob: Blob;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly displayName: string;
  readonly height: number;
  readonly mimeType: QuickThemeImageMimeType;
  readonly width: number;
}

export class QuickThemeImageError extends Error {
  readonly issue: QuickThemeImageIssue;

  constructor(issue: QuickThemeImageIssue) {
    super(issue.message);
    this.name = "QuickThemeImageError";
    this.issue = issue;
  }
}

export async function analyzeWebQuickThemeImage(
  file: File,
  signal?: AbortSignal,
): Promise<AnalyzedWebQuickThemeImage> {
  throwIfAborted(signal);
  const extension = fileExtension(file.name);
  if (!extension) throw quickThemeImageError("invalid-extension", "Choose a PNG, JPEG, or WebP image.");
  if (file.size <= 0) throw quickThemeImageError("source-empty", "The selected image is empty.");
  if (file.size > MAX_SOURCE_BYTES) {
    throw quickThemeImageError("source-too-large", "The selected image is larger than 16 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  const mimeType = sniffImageMime(bytes);
  if (!mimeType || !extensionMatchesMime(extension, mimeType)) {
    throw quickThemeImageError("invalid-mime", "The image type does not match its file extension.");
  }

  const blob = new Blob([copyToArrayBuffer(bytes)], { type: mimeType });
  const decoded = await decodeThemeSource(blob);
  try {
    throwIfAborted(signal);
    if (
      decoded.width <= 0
      || decoded.height <= 0
      || Math.max(decoded.width, decoded.height) > MAX_SOURCE_EDGE
      || decoded.width * decoded.height > MAX_SOURCE_PIXELS
    ) {
      throw quickThemeImageError(
        "invalid-dimensions",
        "The image dimensions exceed the supported 8192 px or 32 MP limit.",
      );
    }
    const sample = sampleDecodedImage(decoded.source, decoded.width, decoded.height);
    throwIfAborted(signal);
    const sampledAnalysis = analyzeThemeImage(sample);
    const analysis = Object.freeze({
      ...sampledAnalysis,
      width: decoded.width,
      height: decoded.height,
      aspectRatio: round(decoded.width / decoded.height),
    });
    return Object.freeze({
      analysis,
      blob,
      byteLength: bytes.byteLength,
      checksumSha256: await sha256(bytes),
      displayName: safeDisplayName(file.name),
      height: decoded.height,
      mimeType,
      width: decoded.width,
    });
  } finally {
    decoded.release();
  }
}

interface DecodedThemeSource {
  readonly height: number;
  readonly release: () => void;
  readonly source: CanvasImageSource;
  readonly width: number;
}

async function decodeThemeSource(blob: Blob): Promise<DecodedThemeSource> {
  if (globalThis.createImageBitmap) {
    try {
      const bitmap = await globalThis.createImageBitmap(blob, { imageOrientation: "none" });
      return Object.freeze({
        height: bitmap.height,
        release: () => bitmap.close(),
        source: bitmap,
        width: bitmap.width,
      });
    } catch {
      // Safari and older Chromium builds can expose createImageBitmap but reject imageOrientation.
    }
  }
  return decodeThemeSourceWithImage(blob);
}

function decodeThemeSourceWithImage(blob: Blob): Promise<DecodedThemeSource> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve(Object.freeze({
        height: image.naturalHeight,
        release: () => URL.revokeObjectURL(objectUrl),
        source: image,
        width: image.naturalWidth,
      }));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(quickThemeImageError("decode-failed", "The selected image could not be decoded."));
    };
    image.src = objectUrl;
  });
}

function sampleDecodedImage(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, MAX_SAMPLE_EDGE / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
  if (!context) throw quickThemeImageError("sample-failed", "Local image analysis is unavailable in this browser.");
  try {
    context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
    return Object.freeze({
      height: sampleHeight,
      pixels: context.getImageData(0, 0, sampleWidth, sampleHeight).data,
      width: sampleWidth,
    });
  } catch {
    throw quickThemeImageError("sample-failed", "The selected image could not be analyzed locally.");
  }
}

function sniffImageMime(bytes: Uint8Array): QuickThemeImageMimeType | undefined {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) return "image/webp";
  return undefined;
}

function fileExtension(name: string): "jpeg" | "jpg" | "png" | "webp" | undefined {
  const normalized = name.trim().toLocaleLowerCase("en-US");
  if (normalized.endsWith(".png")) return "png";
  if (normalized.endsWith(".jpg")) return "jpg";
  if (normalized.endsWith(".jpeg")) return "jpeg";
  if (normalized.endsWith(".webp")) return "webp";
  return undefined;
}

function extensionMatchesMime(
  extension: Exclude<ReturnType<typeof fileExtension>, undefined>,
  mimeType: QuickThemeImageMimeType,
): boolean {
  if (mimeType === "image/png") return extension === "png";
  if (mimeType === "image/webp") return extension === "webp";
  return extension === "jpg" || extension === "jpeg";
}

function safeDisplayName(value: string): string {
  const name = value.trim().split(/[\\/]/u).pop()?.trim() ?? "";
  return name.slice(0, 160) || "theme-source";
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copyToArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw quickThemeImageError("aborted", "Local image analysis was cancelled.");
}

function quickThemeImageError(code: QuickThemeImageIssueCode, message: string): QuickThemeImageError {
  return new QuickThemeImageError(Object.freeze({ code, message }));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
