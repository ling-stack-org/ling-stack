import {
  LING_THEME_PACKAGE_LIMITS,
  LingThemePackageError,
  type LingThemeImageDecoder,
  type LingThemeImageMimeType,
  type LingThemePackageIssue,
} from "./package-types.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export interface ValidatedLingThemeImage {
  readonly height: number;
  readonly mimeType: LingThemeImageMimeType;
  readonly width: number;
}

export async function validateThemeImage(
  path: string,
  bytes: Uint8Array,
  decodeImage: LingThemeImageDecoder,
): Promise<ValidatedLingThemeImage> {
  const mimeType = sniffThemeImageMime(bytes);
  if (!mimeType || !themeImageExtensionMatchesMime(path, mimeType)) {
    throw imageIssue("invalid-preview-mime", path, "Theme preview extension does not match its image bytes.");
  }

  let dimensions;
  try {
    dimensions = await decodeImage(Object.freeze({ bytes, mimeType, path }));
  } catch {
    throw imageIssue("invalid-preview-image", path, "Theme preview could not be decoded as an image.");
  }
  const { height, width } = dimensions;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || Math.max(width, height) > LING_THEME_PACKAGE_LIMITS.imageEdgePixels
    || width * height > LING_THEME_PACKAGE_LIMITS.decodedPixels
  ) {
    throw imageIssue("invalid-preview-dimensions", path, "Theme preview dimensions exceed the supported image limits.");
  }
  return Object.freeze({ height, mimeType, width });
}

export function sniffThemeImageMime(bytes: Uint8Array): LingThemeImageMimeType | undefined {
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) return "image/webp";
  return undefined;
}

export function themeImageExtensionMatchesMime(path: string, mimeType: LingThemeImageMimeType): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  if (mimeType === "image/png") return lower.endsWith(".png");
  if (mimeType === "image/webp") return lower.endsWith(".webp");
  return lower.endsWith(".jpg") || lower.endsWith(".jpeg");
}

function imageIssue(code: string, path: string, message: string): LingThemePackageError {
  const issue: LingThemePackageIssue = Object.freeze({ code, path, message });
  return new LingThemePackageError([issue]);
}
