import type { LingThemePackManifest } from "@ling-stack/ui-react/theme";
import {
  deleteStoredThemeManifest,
  listStoredThemeManifests,
} from "../web-theme-storage.js";
import {
  deleteStoredWebThemePackage,
  putStoredWebThemePackage,
  readStoredWebThemePackage,
  type StoredWebThemePackage,
  type WebThemePackagePublication,
} from "./web-theme-package-repository.js";
import {
  themePackageRepositoryFailure,
  themePackageRepositorySuccess,
  type ThemePackageRepositoryBootstrapValue,
  type ThemePackageRepositoryDeleteRequest,
  type ThemePackageRepositoryDeleteValue,
  type ThemePackageRepositoryDescriptor,
  type ThemePackageRepositoryErrorCode,
  type ThemePackageRepositoryInstallRequest,
  type ThemePackageRepositoryPort,
  type ThemePackageRepositoryReadRequest,
  type ThemePackageRepositoryReadValue,
  type ThemePackageRepositoryReimportRequest,
  type ThemePackageRepositoryResult,
  type ThemePackageRepositorySetActiveRequest,
  type ThemePackageRepositorySetActiveValue,
} from "./theme-package-repository-port.js";

export interface WebThemePackageRepositoryDependencies {
  readonly deleteStoredPackage: typeof deleteStoredWebThemePackage;
  readonly deleteStoredManifest: typeof deleteStoredThemeManifest;
  readonly listStoredManifests: typeof listStoredThemeManifests;
  readonly putStoredPackage: typeof putStoredWebThemePackage;
  readonly readStoredPackage: typeof readStoredWebThemePackage;
}

const DEFAULT_DEPENDENCIES: WebThemePackageRepositoryDependencies = Object.freeze({
  deleteStoredPackage: deleteStoredWebThemePackage,
  deleteStoredManifest: deleteStoredThemeManifest,
  listStoredManifests: listStoredThemeManifests,
  putStoredPackage: putStoredWebThemePackage,
  readStoredPackage: readStoredWebThemePackage,
});

export class WebThemePackageRepositoryAdapter implements ThemePackageRepositoryPort {
  readonly kind = "web" as const;
  readonly #dependencies: WebThemePackageRepositoryDependencies;
  readonly #recordRevisions = new Map<string, number>();
  #repositoryRevision = 0;

  constructor(dependencies: WebThemePackageRepositoryDependencies = DEFAULT_DEPENDENCIES) {
    this.#dependencies = dependencies;
  }

  async bootstrap(): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryBootstrapValue>> {
    const listed = await this.list();
    if (!listed.ok) return listed;
    if (this.#repositoryRevision === 0) this.#repositoryRevision = 1;
    return themePackageRepositorySuccess(Object.freeze({
      activeGuardReady: true,
      packages: listed.value,
      recoveryWarnings: Object.freeze([]),
      repositoryRevision: this.#repositoryRevision,
    }));
  }

  async list(): Promise<ThemePackageRepositoryResult<readonly ThemePackageRepositoryDescriptor[]>> {
    try {
      const manifests = await this.#dependencies.listStoredManifests();
      const descriptors = await Promise.all(manifests
        .filter(isLocalThemeManifest)
        .map(async (manifest) => {
          const stored = await this.#dependencies.readStoredPackage(manifest.id);
          return this.#descriptor(stored ?? legacyStoredPackage(manifest));
        }));
      return themePackageRepositorySuccess(Object.freeze(descriptors.sort((left, right) => (
        left.themeId.localeCompare(right.themeId, "en-US")
      ))));
    } catch (error) {
      return webStorageFailure(error);
    }
  }

  async read(
    request: ThemePackageRepositoryReadRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryReadValue>> {
    try {
      const stored = await this.#dependencies.readStoredPackage(request.themeId);
      if (!stored) return themePackageRepositoryFailure("theme_not_found", { themeId: request.themeId });
      return themePackageRepositorySuccess(Object.freeze({
        descriptor: this.#descriptor(stored),
        ...(stored.licenseText !== undefined ? { licenseText: stored.licenseText } : {}),
        ...(request.includePreviewBytes && stored.preview
          ? { preview: { ...stored.preview, blob: stored.preview.blob.slice() } }
          : {}),
      }));
    } catch (error) {
      return webStorageFailure(error, request.themeId);
    }
  }

  async install(
    request: ThemePackageRepositoryInstallRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDescriptor>> {
    try {
      if (await this.#dependencies.readStoredPackage(request.publication.manifest.id)) {
        return themePackageRepositoryFailure("theme_already_installed", {
          themeId: request.publication.manifest.id,
        });
      }
      const stored = await this.#dependencies.putStoredPackage(webPublication(request));
      this.#advance(stored.manifest.id);
      return themePackageRepositorySuccess(this.#descriptor(stored));
    } catch (error) {
      return webStorageFailure(error, request.publication.manifest.id);
    }
  }

  async reimport(
    request: ThemePackageRepositoryReimportRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDescriptor>> {
    if (request.publication.manifest.id !== request.themeId) {
      return themePackageRepositoryFailure("theme_id_mismatch", { themeId: request.themeId });
    }
    try {
      const current = await this.#dependencies.readStoredPackage(request.themeId);
      if (!current) return themePackageRepositoryFailure("theme_not_found", { themeId: request.themeId });
      const conflict = this.#conflict(request, current);
      if (conflict) return conflict;
      const stored = await this.#dependencies.putStoredPackage(webPublication(request), current.installedAt);
      this.#advance(request.themeId);
      return themePackageRepositorySuccess(this.#descriptor(stored));
    } catch (error) {
      return webStorageFailure(error, request.themeId);
    }
  }

  async delete(
    request: ThemePackageRepositoryDeleteRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDeleteValue>> {
    try {
      const current = await this.#dependencies.readStoredPackage(request.themeId);
      if (!current) return themePackageRepositoryFailure("theme_not_found", { themeId: request.themeId });
      const conflict = this.#conflict(request, current);
      if (conflict) return conflict;
      await this.#dependencies.deleteStoredPackage(request.themeId);
      // v1 records had no package metadata; keep an explicit manifest cleanup
      // until that legacy storage shape is no longer supported.
      await this.#dependencies.deleteStoredManifest(request.themeId);
      this.#recordRevisions.delete(request.themeId);
      this.#repositoryRevision += 1;
      return themePackageRepositorySuccess(Object.freeze({ repositoryRevision: this.#repositoryRevision }));
    } catch (error) {
      return webStorageFailure(error, request.themeId);
    }
  }

  async setActive(
    request: ThemePackageRepositorySetActiveRequest,
  ): Promise<ThemePackageRepositoryResult<ThemePackageRepositorySetActiveValue>> {
    return themePackageRepositorySuccess(Object.freeze({ activeThemeId: request.themeId }));
  }

  #advance(themeId: string): void {
    this.#repositoryRevision += 1;
    this.#recordRevisions.set(themeId, (this.#recordRevisions.get(themeId) ?? 0) + 1);
  }

  #conflict(
    request: Pick<ThemePackageRepositoryDeleteRequest, "expectedCurrentChecksumSha256" | "expectedRecordRevision" | "themeId">,
    current: StoredWebThemePackage,
  ): ThemePackageRepositoryResult<never> | undefined {
    const recordRevision = this.#recordRevisions.get(request.themeId) ?? 1;
    if (request.expectedRecordRevision !== recordRevision) {
      return themePackageRepositoryFailure("stale_repository_revision", { themeId: request.themeId });
    }
    if (
      request.expectedCurrentChecksumSha256 !== undefined
      && request.expectedCurrentChecksumSha256 !== current.packageChecksumSha256
    ) {
      return themePackageRepositoryFailure("checksum_mismatch", { themeId: request.themeId });
    }
    return undefined;
  }

  #descriptor(stored: StoredWebThemePackage): ThemePackageRepositoryDescriptor {
    const themeId = stored.manifest.id;
    const recordRevision = this.#recordRevisions.get(themeId) ?? 1;
    this.#recordRevisions.set(themeId, recordRevision);
    return Object.freeze({
      health: "ready",
      installedAt: stored.installedAt,
      manifest: stored.manifest,
      recordRevision,
      themeId,
      updatedAt: stored.updatedAt,
      ...(stored.packageChecksumSha256 !== undefined
        ? { packageChecksumSha256: stored.packageChecksumSha256 }
        : {}),
      ...(stored.preview
        ? {
          preview: Object.freeze({
            byteLength: stored.preview.byteLength,
            checksumSha256: stored.preview.checksumSha256,
            height: stored.preview.height,
            mimeType: stored.preview.mimeType,
            path: stored.preview.path,
            width: stored.preview.width,
          }),
        }
        : {}),
    });
  }
}

function isLocalThemeManifest(manifest: LingThemePackManifest): boolean {
  return manifest.source === "local-generated" || manifest.source === "local-import";
}

function legacyStoredPackage(manifest: LingThemePackManifest): StoredWebThemePackage {
  return Object.freeze({
    installedAt: new Date(0).toISOString(),
    manifest,
    updatedAt: new Date(0).toISOString(),
  });
}

function webPublication(request: ThemePackageRepositoryInstallRequest): WebThemePackagePublication {
  return Object.freeze({
    manifest: request.publication.manifest,
    packageChecksumSha256: request.publication.packageChecksumSha256,
    ...(request.publication.licenseText !== undefined ? { licenseText: request.publication.licenseText } : {}),
    ...(request.publication.preview !== undefined ? { preview: request.publication.preview } : {}),
  });
}

function webStorageFailure(
  error: unknown,
  themeId?: string,
): ThemePackageRepositoryResult<never> {
  return themePackageRepositoryFailure(webStorageErrorCode(error), {
    retryable: true,
    ...(themeId !== undefined ? { themeId } : {}),
  });
}

function webStorageErrorCode(error: unknown): ThemePackageRepositoryErrorCode {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return "disk_full";
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "permission_denied";
    if (error.name === "InvalidStateError") return "storage_unavailable";
  }
  return "unknown_io";
}
