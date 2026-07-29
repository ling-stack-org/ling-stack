import { inflateSync } from "fflate";
import { validateThemeManifest } from "../validate-theme.js";
import { inspectZipCentralDirectory, type InspectedZipEntry } from "./inspect-zip-central-directory.js";
import {
  LING_THEME_PACKAGE_LIMITS,
  LingThemePackageError,
  type LingThemePackageIndexEntry,
  type LingThemePackageIssue,
  type NormalizedLingThemePackageFile,
  type ParsedLingThemePackage,
  type ParseThemePackageBytesOptions,
} from "./package-types.js";
import { validateThemeImage } from "./theme-image-validation.js";
import { normalizeThemePackagePath, validateThemePackageIndex } from "./validate-package-index.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const WINDOWS_RESERVED_THEME_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
const ROOT_FIELDS = new Set([
  "schemaVersion", "id", "name", "familyId", "description", "author", "homepage", "license",
  "colorScheme", "source", "tokens", "desktop", "presentation", "artwork", "generation", "preview",
]);
const DESKTOP_FIELDS = new Set([
  "windowBackground", "sidebarMaterial", "overlayMaterial", "titlebarForeground", "shadowStrength", "blurStrength",
]);
const PRESENTATION_FIELDS = new Set(["profileId", "surfaceIntensity", "artworkIntensity", "decorationSet"]);
const GENERATION_FIELDS = new Set([
  "mode", "createdAt", "compilerVersion", "plannerModelRef", "artworkModelRef", "promptTemplateVersion", "sourceAssetCount",
]);
const TOKEN_FIELDS = Object.freeze({
  background: new Set(["app", "panel", "elevated", "subtle", "pressed", "overlay", "code", "sidebar", "composer"]),
  text: new Set(["strong", "default", "muted", "soft", "inverse", "link"]),
  border: new Set(["default", "strong", "focus"]),
  action: new Set(["accent", "accentHover", "accentPressed", "accentForeground", "selection"]),
  shadow: new Set(["low", "medium", "overlay"]),
  native: new Set(["selection", "scrollbar", "scrollbarHover"]),
});
const STATUS_FIELDS = new Set(["success", "warning", "danger", "info"]);
const STATUS_TONE_FIELDS = new Set(["foreground", "background", "border"]);

export async function parseThemePackageBytes(
  archiveBytes: Uint8Array,
  options: ParseThemePackageBytesOptions,
): Promise<ParsedLingThemePackage> {
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength === 0) {
    throw packageIssue("archive-empty", "$", "Theme archive is empty.");
  }
  if (archiveBytes.byteLength > LING_THEME_PACKAGE_LIMITS.archiveBytes) {
    throw packageIssue("archive-too-large", "$", "Theme archive exceeds the 20 MB limit.");
  }

  const inspection = inspectZipCentralDirectory(archiveBytes);
  if (!inspection.ok) throw new LingThemePackageError(inspection.issues);
  const index = validateThemePackageIndex(archiveBytes.byteLength, inspection.entries);
  if (!index.ok) throw new LingThemePackageError(index.issues);
  const extracted = extractArchiveFiles(archiveBytes, inspection.entries, index.files);

  const manifestBytes = extracted.get("theme.json");
  if (!manifestBytes) throw packageIssue("missing-manifest", "theme.json", "Theme archive is missing theme.json.");
  const rawManifest = parseManifest(manifestBytes);
  const shapeIssue = validateStrictManifestShape(rawManifest);
  if (shapeIssue) throw new LingThemePackageError([shapeIssue]);
  if (isRecord(rawManifest) && rawManifest.artwork !== undefined) {
    throw packageIssue(
      "runtime-artwork-not-supported",
      "artwork",
      "Imported runtime artwork is not supported. Theme packages may include tokens and an isolated preview only.",
    );
  }
  const validation = validateThemeManifest(rawManifest, { source: "local-import" });
  if (!validation.ok) throw new LingThemePackageError(validation.issues);
  const manifest = validation.candidate.manifest;
  if (WINDOWS_RESERVED_THEME_ID.test(manifest.id)) {
    throw packageIssue("reserved-id", "id", "Theme id is reserved by a supported desktop platform.");
  }

  const previewPath = manifest.preview ? normalizeThemePackagePath(manifest.preview) : undefined;
  if (manifest.preview && (!previewPath || !previewPath.startsWith("assets/"))) {
    throw packageIssue("invalid-preview", "preview", "Theme preview must reference a canonical asset path.");
  }
  const assetPaths = [...extracted.keys()].filter((path) => path.startsWith("assets/"));
  if (assetPaths.some((path) => path !== previewPath)) {
    throw packageIssue("unreferenced-asset", "assets", "Theme archive contains an asset that is not its declared preview.");
  }
  if (previewPath && !extracted.has(previewPath)) {
    throw packageIssue("missing-preview", "preview", "Theme preview asset is missing from the archive.");
  }

  const previewBytes = previewPath ? extracted.get(previewPath) : undefined;
  const previewValidation = previewPath && previewBytes
    ? await validateThemeImage(previewPath, previewBytes, options.decodeImage)
    : undefined;
  const previewChecksumSha256 = previewBytes ? await sha256(previewBytes) : undefined;
  const preview = previewPath && previewBytes && previewValidation && previewChecksumSha256
    ? Object.freeze({
      byteLength: previewBytes.byteLength,
      bytes: previewBytes,
      checksumSha256: previewChecksumSha256,
      height: previewValidation.height,
      mimeType: previewValidation.mimeType,
      path: previewPath as `assets/${string}`,
      width: previewValidation.width,
    })
    : undefined;

  const licenseSource = extracted.get("LICENSE.txt");
  const licenseText = licenseSource ? decodeText(licenseSource, "LICENSE.txt") : undefined;
  const canonicalManifestBytes = textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const normalizedLicenseBytes = licenseText !== undefined ? textEncoder.encode(licenseText) : undefined;
  const files = await normalizedFiles(canonicalManifestBytes, normalizedLicenseBytes, preview);
  const warnings: LingThemePackageIssue[] = licenseText === undefined
    ? [Object.freeze({
      code: "license-not-declared",
      path: "LICENSE.txt",
      message: "This theme does not declare redistribution rights.",
    })]
    : [];

  return Object.freeze({
    archiveByteLength: archiveBytes.byteLength,
    files: Object.freeze(files),
    ...(licenseText !== undefined ? { licenseText } : {}),
    manifest,
    packageChecksumSha256: await sha256(archiveBytes),
    ...(preview ? { preview } : {}),
    warnings: Object.freeze(warnings),
  });
}

function extractArchiveFiles(
  archiveBytes: Uint8Array,
  inspectedEntries: readonly InspectedZipEntry[],
  indexedFiles: readonly LingThemePackageIndexEntry[],
): Map<string, Uint8Array> {
  const indexedPaths = new Set(indexedFiles.map((entry) => entry.path));
  const extracted = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const entry of inspectedEntries) {
    if (entry.kind !== "file" || !indexedPaths.has(entry.path)) continue;
    const compressed = archiveBytes.subarray(entry.dataOffset, entry.dataEnd);
    let decoded: Uint8Array;
    if (entry.compressionMethod === 0) {
      if (entry.compressedBytes !== entry.uncompressedBytes) {
        throw packageIssue("invalid-entry-size", entry.path, "Stored theme entry size does not match its declaration.");
      }
      decoded = compressed.slice();
    } else {
      try {
        const boundedOutput = new Uint8Array(entry.uncompressedBytes + 1);
        decoded = inflateSync(compressed, { out: boundedOutput }).slice();
      } catch {
        throw packageIssue("invalid-archive", entry.path, "Theme archive entry could not be decoded.");
      }
    }
    if (decoded.byteLength !== entry.uncompressedBytes) {
      throw packageIssue("invalid-entry-size", entry.path, "Theme entry size does not match the archive directory.");
    }
    if (crc32(decoded) !== entry.crc32) {
      throw packageIssue("invalid-entry-crc", entry.path, "Theme entry failed its CRC integrity check.");
    }
    actualTotal += decoded.byteLength;
    if (actualTotal > LING_THEME_PACKAGE_LIMITS.totalUncompressedBytes) {
      throw packageIssue("file-too-large", "$", "Theme archive exceeds the 32 MB uncompressed limit.");
    }
    extracted.set(entry.path, decoded);
  }
  if (extracted.size !== indexedFiles.length) {
    throw packageIssue("invalid-archive", "$", "Theme archive files changed during bounded decoding.");
  }
  return extracted;
}

async function normalizedFiles(
  manifestBytes: Uint8Array,
  licenseBytes: Uint8Array | undefined,
  preview: ParsedLingThemePackage["preview"],
): Promise<NormalizedLingThemePackageFile[]> {
  const sources: Array<Omit<NormalizedLingThemePackageFile, "checksumSha256">> = [{
    byteLength: manifestBytes.byteLength,
    bytes: manifestBytes,
    mimeType: "application/json",
    path: "theme.json",
  }];
  if (licenseBytes) sources.push({
    byteLength: licenseBytes.byteLength,
    bytes: licenseBytes,
    mimeType: "text/plain",
    path: "LICENSE.txt",
  });
  if (preview) sources.push({
    byteLength: preview.byteLength,
    bytes: preview.bytes,
    mimeType: preview.mimeType,
    path: preview.path,
  });
  const files = await Promise.all(sources.map(async (file) => Object.freeze({
    ...file,
    checksumSha256: await sha256(file.bytes),
  })));
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function parseManifest(bytes: Uint8Array): unknown {
  const text = decodeText(bytes, "theme.json");
  try {
    return JSON.parse(text);
  } catch {
    throw packageIssue("invalid-manifest", "theme.json", "theme.json is not valid JSON.");
  }
}

function decodeText(bytes: Uint8Array, path: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw packageIssue("invalid-text", path, `${path} must be valid UTF-8 text.`);
  }
}

function validateStrictManifestShape(value: unknown): LingThemePackageIssue | undefined {
  if (!isRecord(value)) return undefined;
  const rootUnknown = firstUnknownKey(value, ROOT_FIELDS);
  if (rootUnknown) return schemaIssue("invalid-schema", rootUnknown);
  const nestedChecks: ReadonlyArray<readonly [unknown, ReadonlySet<string>, string, string]> = [
    [value.desktop, DESKTOP_FIELDS, "desktop", "invalid-schema"],
    [value.presentation, PRESENTATION_FIELDS, "presentation", "invalid-presentation"],
    [value.generation, GENERATION_FIELDS, "generation", "invalid-schema"],
  ];
  for (const [candidate, allowed, path, code] of nestedChecks) {
    if (!isRecord(candidate)) continue;
    const unknown = firstUnknownKey(candidate, allowed);
    if (unknown) return schemaIssue(code, `${path}.${unknown}`);
  }
  if (!isRecord(value.tokens)) return undefined;
  const tokenGroups = new Set([...Object.keys(TOKEN_FIELDS), "status"]);
  const unknownGroup = firstUnknownKey(value.tokens, tokenGroups);
  if (unknownGroup) return schemaIssue("invalid-schema", `tokens.${unknownGroup}`);
  for (const [group, allowed] of Object.entries(TOKEN_FIELDS)) {
    const candidate = value.tokens[group];
    if (!isRecord(candidate)) continue;
    const unknown = firstUnknownKey(candidate, allowed);
    if (unknown) return schemaIssue("invalid-schema", `tokens.${group}.${unknown}`);
  }
  if (isRecord(value.tokens.status)) {
    const unknownTone = firstUnknownKey(value.tokens.status, STATUS_FIELDS);
    if (unknownTone) return schemaIssue("invalid-schema", `tokens.status.${unknownTone}`);
    for (const tone of STATUS_FIELDS) {
      const candidate = value.tokens.status[tone];
      if (!isRecord(candidate)) continue;
      const unknown = firstUnknownKey(candidate, STATUS_TONE_FIELDS);
      if (unknown) return schemaIssue("invalid-schema", `tokens.status.${tone}.${unknown}`);
    }
  }
  return undefined;
}

function firstUnknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function schemaIssue(code: string, path: string): LingThemePackageIssue {
  return Object.freeze({ code, path, message: "Theme manifest contains a field that is not supported by schema version 1." });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copyToArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageIssue(code: string, path: string, message: string): LingThemePackageError {
  return new LingThemePackageError([Object.freeze({ code, path, message })]);
}
