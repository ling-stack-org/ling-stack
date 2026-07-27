import type { DesktopThemePackageCapabilities } from "../../../../../../desktop/shared/theme-package-capabilities.js";
import {
  themePackageRepositoryFailure,
  themePackageRepositorySuccess,
  type ThemePackageRepositoryBootstrapValue,
  type ThemePackageRepositoryDeleteRequest,
  type ThemePackageRepositoryDeleteValue,
  type ThemePackageRepositoryDescriptor,
  type ThemePackageRepositoryInstallRequest,
  type ThemePackageRepositoryPort,
  type ThemePackageRepositoryReadRequest,
  type ThemePackageRepositoryReadValue,
  type ThemePackageRepositoryReimportRequest,
  type ThemePackageRepositoryResult,
  type ThemePackageRepositorySetActiveRequest,
  type ThemePackageRepositorySetActiveValue,
} from "./theme-package-repository-port.js";

export type DesktopThemePackageCapabilityLike = DesktopThemePackageCapabilities;

export class DesktopThemePackageRepositoryAdapter implements ThemePackageRepositoryPort {
  readonly kind = "desktop" as const;
  readonly #capability: DesktopThemePackageCapabilityLike;

  constructor(capability: DesktopThemePackageCapabilityLike) {
    this.#capability = capability;
  }

  async bootstrap(): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryBootstrapValue>> {
    return this.#invoke(() => this.#capability.bootstrap());
  }

  async list(): Promise<ThemePackageRepositoryResult<readonly ThemePackageRepositoryDescriptor[]>> {
    return this.#invoke(() => this.#capability.list());
  }

  async read(
    request: ThemePackageRepositoryReadRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryReadValue>> {
    const result = await this.#invoke(() => this.#capability.read(request));
    if (!result.ok) return result;
    const { descriptor, licenseText, previewBytes } = result.value;
    return themePackageRepositorySuccess(Object.freeze({
      descriptor,
      ...(licenseText !== undefined ? { licenseText } : {}),
      ...(previewBytes && descriptor.preview
        ? {
          preview: Object.freeze({
            ...descriptor.preview,
            blob: new Blob([copyArrayBuffer(previewBytes)], { type: descriptor.preview.mimeType }),
          }),
        }
        : {}),
    }), result.warnings);
  }

  async install(
    request: ThemePackageRepositoryInstallRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDescriptor>> {
    return this.#invoke(() => this.#capability.install({
      archiveBytes: copyUint8Array(request.archiveBytes),
      originalFileName: request.originalFileName,
      rendererPackageChecksumSha256: request.publication.packageChecksumSha256,
      requestId: request.requestId,
    }));
  }

  async reimport(
    request: ThemePackageRepositoryReimportRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDescriptor>> {
    return this.#invoke(() => this.#capability.reimport({
      archiveBytes: copyUint8Array(request.archiveBytes),
      expectedRecordRevision: request.expectedRecordRevision,
      originalFileName: request.originalFileName,
      rendererPackageChecksumSha256: request.publication.packageChecksumSha256,
      requestId: request.requestId,
      themeId: request.themeId,
      ...(request.expectedCurrentChecksumSha256 !== undefined
        ? { expectedCurrentChecksumSha256: request.expectedCurrentChecksumSha256 }
        : {}),
    }));
  }

  async delete(
    request: ThemePackageRepositoryDeleteRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDeleteValue>> {
    return this.#invoke(() => this.#capability.delete(request));
  }

  async setActive(
    request: ThemePackageRepositorySetActiveRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositorySetActiveValue>> {
    return this.#invoke(() => this.#capability.setActive(request));
  }

  async #invoke<T>(
    operation: () => Promise<ThemePackageRepositoryResult<T>>,
  ): Promise<ThemePackageRepositoryResult<T>> {
    try {
      return await operation();
    } catch {
      return themePackageRepositoryFailure("unknown_io", { retryable: true });
    }
  }
}

function copyUint8Array(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function copyArrayBuffer(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}
