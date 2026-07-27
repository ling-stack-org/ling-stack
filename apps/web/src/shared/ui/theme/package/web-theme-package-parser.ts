import {
  LING_THEME_PACKAGE_LIMITS,
  LingThemePackageError,
  parseThemePackageBytes,
  type LingThemeImageDecodeRequest,
  type LingThemePackageIssue,
} from "@ling-stack/ui-react/theme";
import {
  WebThemePackageError,
  type ParsedWebThemePackage,
  type ParsedWebThemePreview,
} from "./web-theme-package-types.js";

export async function parseWebThemePackage(file: File): Promise<ParsedWebThemePackage> {
  if (!file.name.toLocaleLowerCase("en-US").endsWith(".ling-theme")) {
    throw issue("unsupported-extension", "$", "Choose a .ling-theme file.");
  }
  if (file.size <= 0) {
    throw issue("archive-empty", "$", "Theme archive must not be empty.");
  }
  if (file.size > LING_THEME_PACKAGE_LIMITS.archiveBytes) {
    throw issue("archive-too-large", "$", "Theme archive must be no larger than 20 MB.");
  }

  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  try {
    const parsed = await parseThemePackageBytes(archiveBytes, { decodeImage: decodeWebThemeImage });
    return Object.freeze({
      archiveBytes,
      ...(parsed.licenseText !== undefined ? { licenseText: parsed.licenseText } : {}),
      manifest: parsed.manifest,
      originalFileName: file.name,
      packageChecksumSha256: parsed.packageChecksumSha256,
      ...(parsed.preview ? { preview: webPreview(parsed.preview) } : {}),
      warnings: parsed.warnings,
    });
  } catch (error) {
    if (error instanceof LingThemePackageError) throw new WebThemePackageError(error.issues);
    throw error;
  }
}

function webPreview(
  preview: NonNullable<Awaited<ReturnType<typeof parseThemePackageBytes>>["preview"]>,
): ParsedWebThemePreview {
  return Object.freeze({
    blob: new Blob([copyToArrayBuffer(preview.bytes)], { type: preview.mimeType }),
    byteLength: preview.byteLength,
    checksumSha256: preview.checksumSha256,
    height: preview.height,
    mimeType: preview.mimeType,
    path: preview.path,
    width: preview.width,
  });
}

async function decodeWebThemeImage(
  request: LingThemeImageDecodeRequest,
): Promise<{ readonly height: number; readonly width: number }> {
  const blob = new Blob([copyToArrayBuffer(request.bytes)], { type: request.mimeType });
  if (globalThis.createImageBitmap) {
    const bitmap = await globalThis.createImageBitmap(blob, { imageOrientation: "none" });
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Unable to decode ${request.path}.`));
    };
    image.src = url;
  });
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function issue(code: string, path: string, message: string): WebThemePackageError {
  const value: LingThemePackageIssue = Object.freeze({ code, path, message });
  return new WebThemePackageError([value]);
}
