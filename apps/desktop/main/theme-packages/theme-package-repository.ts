import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  parseThemePackageBytes,
  type LingThemeImageDecoder,
  type ParsedLingThemePackage,
} from "@ling-stack/ui-react/theme";
import type {
  DesktopThemePackageArchiveRequest,
  DesktopThemePackageBootstrapResult,
  DesktopThemePackageCapabilities,
  DesktopThemePackageDeleteRequest,
  DesktopThemePackageDeleteResult,
  DesktopThemePackageDescriptor,
  DesktopThemePackageInstallResult,
  DesktopThemePackageListResult,
  DesktopThemePackageReadRequest,
  DesktopThemePackageReadResult,
  DesktopThemePackageReimportRequest,
  DesktopThemePackageReimportResult,
  DesktopThemePackageResult,
  DesktopThemePackageSetActiveRequest,
  DesktopThemePackageSetActiveResult,
  DesktopThemePackageWarning,
} from "../../shared/theme-package-capabilities.js";
import {
  cleanupPendingWarning,
  copyThemeArrayBuffer,
  dedupeThemeWarnings,
  normalizeThemePackageError,
  prepareThemeArchiveRequest,
  repositoryError,
  themeFailure,
  themeRootCoordination,
  themeSuccess,
  validateOptionalThemeChecksum,
  validateThemeExpectedRevision,
  validateThemeIdInput,
  validateThemeRequestId,
} from "./theme-package-errors.js";
import {
  readInstalledTheme,
  renameThemePath,
  safeRemoveThemePath,
  syncDirectory,
  themePathExists,
  writeThemeCandidate,
  type ReadInstalledTheme,
  type ThemePackageFileContext,
  type ThemePackageFileHooks,
} from "./theme-package-files.js";
import { decodeDesktopThemeImage } from "./theme-package-image-decoder.js";
import {
  advanceThemeOperationJournal,
  createThemeOperationJournal,
  listThemeOperationJournals,
  writeThemeOperationJournal,
  type DesktopThemeOperationJournalV1,
  type JournalOperationEntry,
} from "./theme-package-journal.js";
import {
  assertPortableThemeId,
  finalThemePath,
  initializeThemePackagePaths,
  rollbackThemePath,
  stagingOperationPath,
  trashThemePath,
  type ThemePackagePaths,
} from "./theme-package-paths.js";

interface RepositoryIndexEntry {
  readonly descriptor: DesktopThemePackageDescriptor;
  readonly packagePath: string;
}
export interface DesktopThemePackageRepositoryOptions {
  readonly themesRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly decodeImage?: LingThemeImageDecoder;
  readonly hooks?: ThemePackageFileHooks;
  readonly now?: () => string;
  readonly createOperationId?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly builtInThemeIds?: readonly string[];
}

export class DesktopThemePackageRepository implements DesktopThemePackageCapabilities {
  readonly #coordination;
  readonly #options: DesktopThemePackageRepositoryOptions;
  readonly #index = new Map<string, RepositoryIndexEntry>();
  readonly #builtInThemeIds: ReadonlySet<string>;
  #paths?: ThemePackagePaths;
  #revision = 0;
  #initialized = false;
  #activeGuardReady = false;
  #activeThemeId?: string;
  #recoveryWarnings: DesktopThemePackageWarning[] = [];

  constructor(options: DesktopThemePackageRepositoryOptions) {
    this.#options = options;
    this.#coordination = themeRootCoordination(options.themesRoot);
    this.#builtInThemeIds = new Set(options.builtInThemeIds ?? ["ling-light", "ling-dark"]);
  }
  async initialize(): Promise<DesktopThemePackageBootstrapResult> {
    return this.#coordination.mutex.run(async () => {
      if (this.#initialized) return this.#bootstrapSuccess();
      try {
        this.#paths = await initializeThemePackagePaths(this.#options.themesRoot);
        this.#recoveryWarnings = await this.#recoverOperations();
        await this.#scanIndex();
        this.#revision = 1;
        this.#initialized = true;
        this.#activeGuardReady = false;
        return this.#bootstrapSuccess();
      } catch (error) {
        return themeFailure(normalizeThemePackageError(error, { fallbackCode: "storage_unavailable" }));
      }
    });
  }
  async bootstrap(): Promise<DesktopThemePackageBootstrapResult> {
    return this.#coordination.mutex.run(async () => this.#withInitialized(() => this.#bootstrapSuccess()));
  }

  async list(): Promise<DesktopThemePackageListResult> {
    return this.#coordination.mutex.run(async () => this.#withInitialized(() => themeSuccess(this.#descriptors())));
  }

  async read(request: DesktopThemePackageReadRequest): Promise<DesktopThemePackageReadResult> {
    return this.#coordination.mutex.run(async () => this.#withInitialized(async () => {
      try {
        validateThemeIdInput(request.themeId);
        const entry = this.#index.get(request.themeId);
        if (!entry) throw repositoryError("theme_not_found", { themeId: request.themeId });
        if (entry.descriptor.health === "corrupt") return themeSuccess({ descriptor: entry.descriptor });
        const installed = await readInstalledTheme(this.#context(), entry.packagePath, {
          includePreviewBytes: request.includePreviewBytes === true,
        });
        return themeSuccess({
          descriptor: entry.descriptor,
          ...(installed.licenseText !== undefined ? { licenseText: installed.licenseText } : {}),
          ...(installed.previewBytes
            ? { previewBytes: copyThemeArrayBuffer(installed.previewBytes) }
            : {}),
        });
      } catch (error) {
        return themeFailure(normalizeThemePackageError(error, { themeId: request.themeId }));
      }
    }));
  }

  async install(request: DesktopThemePackageArchiveRequest): Promise<DesktopThemePackageInstallResult> {
    const prepared = prepareThemeArchiveRequest(request);
    if (!prepared.ok) return prepared.result;
    return this.#coordination.requestDedupe.run(request.requestId, `install:${prepared.fingerprint}`, async () => {
      return this.#coordination.mutex.run(async () => this.#withInitialized(async () => {
        let operationId: string | undefined;
        let themeId: string | undefined;
        let finalPublished = false;
        try {
          const parsed = await this.#parseArchive(prepared.bytes, request.rendererPackageChecksumSha256);
          themeId = parsed.manifest.id;
          if (this.#index.has(parsed.manifest.id)) {
            throw repositoryError("theme_already_installed", { themeId: parsed.manifest.id });
          }
          operationId = this.#operationId();
          const now = this.#now();
          let journal = createThemeOperationJournal({
            operationId,
            kind: "install",
            themeId: parsed.manifest.id,
            candidateChecksumSha256: parsed.packageChecksumSha256,
            now,
          });
          await writeThemeOperationJournal(this.#context(), journal);
          const operationPath = stagingOperationPath(this.#requirePaths(), operationId);
          const candidatePath = join(operationPath, "candidate");
          await writeThemeCandidate(this.#context(), candidatePath, parsed, { installedAt: now, updatedAt: now });
          await readInstalledTheme(this.#context(), candidatePath);
          journal = advanceThemeOperationJournal(journal, "candidate-ready", this.#now());
          await writeThemeOperationJournal(this.#context(), journal);
          const finalPath = finalThemePath(this.#requirePaths(), parsed.manifest.id);
          await renameThemePath(this.#context(), candidatePath, finalPath);
          finalPublished = true;
          await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
          journal = advanceThemeOperationJournal(journal, "published", this.#now());
          await writeThemeOperationJournal(this.#context(), journal);
          const installed = await readInstalledTheme(this.#context(), finalPath);
          const descriptor = this.#publishIndex(finalPath, installed);
          const warnings = await this.#cleanupSuccess(operationId, parsed.manifest.id, [operationPath]);
          return themeSuccess(descriptor, warnings);
        } catch (error) {
          if (operationId) {
            const operationPath = stagingOperationPath(this.#requirePaths(), operationId);
            if (finalPublished) {
              if (themeId) {
                try {
                  await this.#quarantineFailedInstall(themeId, operationId);
                } catch (rollbackError) {
                  return themeFailure(repositoryError("rollback_failed", {
                    operationId,
                    themeId,
                    cause: rollbackError,
                  }));
                }
              }
              return themeFailure(repositoryError("publication_failed", { operationId, themeId, cause: error }));
            }
            await safeRemoveThemePath(this.#context(), operationPath).catch(() => undefined);
          }
          return themeFailure(normalizeThemePackageError(error, { operationId }));
        }
      }));
    });
  }

  async reimport(request: DesktopThemePackageReimportRequest): Promise<DesktopThemePackageReimportResult> {
    const prepared = prepareThemeArchiveRequest(request);
    if (!prepared.ok) return prepared.result;
    try {
      assertPortableThemeId(request.themeId);
      validateThemeExpectedRevision(request.expectedRecordRevision);
      validateOptionalThemeChecksum(request.expectedCurrentChecksumSha256);
    } catch (error) {
      return themeFailure(normalizeThemePackageError(error, { themeId: request.themeId }));
    }
    const fingerprint = `reimport:${request.themeId}:${request.expectedRecordRevision}:${request.expectedCurrentChecksumSha256 ?? ""}:${prepared.fingerprint}`;
    return this.#coordination.requestDedupe.run(request.requestId, fingerprint, async () => this.#coordination.mutex.run(async () => {
      return this.#withInitialized(async () => this.#performReimport(request, prepared.bytes));
    }));
  }

  async delete(request: DesktopThemePackageDeleteRequest): Promise<DesktopThemePackageDeleteResult> {
    try {
      validateThemeRequestId(request.requestId);
      validateThemeExpectedRevision(request.expectedRecordRevision);
      validateOptionalThemeChecksum(request.expectedCurrentChecksumSha256);
      if (!this.#builtInThemeIds.has(request.themeId)) assertPortableThemeId(request.themeId);
    } catch (error) {
      return themeFailure(normalizeThemePackageError(error, { themeId: request.themeId }));
    }
    const fingerprint = `delete:${request.themeId}:${request.expectedRecordRevision}:${request.expectedCurrentChecksumSha256 ?? ""}`;
    return this.#coordination.requestDedupe.run(request.requestId, fingerprint, async () => this.#coordination.mutex.run(async () => {
      return this.#withInitialized(async () => this.#performDelete(request));
    }));
  }

  async setActive(request: DesktopThemePackageSetActiveRequest): Promise<DesktopThemePackageSetActiveResult> {
    return this.#coordination.mutex.run(async () => this.#withInitialized(() => {
      try {
        validateThemeIdInput(request.themeId);
        const local = this.#index.get(request.themeId);
        if (!this.#builtInThemeIds.has(request.themeId) && local?.descriptor.health !== "ready") {
          throw repositoryError("theme_not_found", { themeId: request.themeId });
        }
        this.#activeThemeId = request.themeId;
        this.#activeGuardReady = true;
        return themeSuccess({ activeThemeId: request.themeId });
      } catch (error) {
        return themeFailure(normalizeThemePackageError(error, { themeId: request.themeId }));
      }
    }));
  }

  async #performReimport(
    request: DesktopThemePackageReimportRequest,
    bytes: Uint8Array,
  ): Promise<DesktopThemePackageReimportResult> {
    let operationId: string | undefined;
    let backupCreated = false;
    let journal: DesktopThemeOperationJournalV1 | undefined;
    try {
      const current = this.#requireCurrent(request.themeId, request.expectedRecordRevision, request.expectedCurrentChecksumSha256);
      const parsed = await this.#parseArchive(bytes, request.rendererPackageChecksumSha256);
      if (parsed.manifest.id !== request.themeId) throw repositoryError("theme_id_mismatch", { themeId: request.themeId });
      operationId = this.#operationId();
      const now = this.#now();
      const currentRead = await readInstalledTheme(this.#context(), current.packagePath).catch(() => undefined);
      journal = createThemeOperationJournal({
        operationId,
        kind: "reimport",
        themeId: request.themeId,
        expectedPreviousChecksumSha256: current.descriptor.packageChecksumSha256,
        candidateChecksumSha256: parsed.packageChecksumSha256,
        now,
      });
      await writeThemeOperationJournal(this.#context(), journal);
      const operationPath = stagingOperationPath(this.#requirePaths(), operationId);
      const candidatePath = join(operationPath, "candidate");
      await writeThemeCandidate(this.#context(), candidatePath, parsed, {
        installedAt: currentRead?.record.installedAt ?? now,
        updatedAt: now,
      });
      await readInstalledTheme(this.#context(), candidatePath);
      journal = advanceThemeOperationJournal(journal, "candidate-ready", this.#now());
      await writeThemeOperationJournal(this.#context(), journal);
      const rollbackPath = rollbackThemePath(this.#requirePaths(), request.themeId, operationId);
      await renameThemePath(this.#context(), current.packagePath, rollbackPath);
      backupCreated = true;
      await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
      journal = advanceThemeOperationJournal(journal, "backup-created", this.#now());
      await writeThemeOperationJournal(this.#context(), journal);
      await renameThemePath(this.#context(), candidatePath, current.packagePath);
      await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
      const installed = await readInstalledTheme(this.#context(), current.packagePath);
      journal = advanceThemeOperationJournal(journal, "published", this.#now());
      await writeThemeOperationJournal(this.#context(), journal);
      const descriptor = this.#publishIndex(current.packagePath, installed);
      const warnings = await this.#cleanupSuccess(operationId, request.themeId, [rollbackPath, operationPath]);
      return themeSuccess(descriptor, warnings);
    } catch (error) {
      if (!operationId) return themeFailure(normalizeThemePackageError(error, { themeId: request.themeId }));
      if (!backupCreated) {
        await safeRemoveThemePath(this.#context(), stagingOperationPath(this.#requirePaths(), operationId)).catch(() => undefined);
        return themeFailure(normalizeThemePackageError(error, { operationId, themeId: request.themeId }));
      }
      const restored = await this.#restoreRollback(request.themeId, operationId);
      if (!restored) return themeFailure(repositoryError("rollback_failed", { operationId, themeId: request.themeId, cause: error }));
      return themeFailure(normalizeThemePackageError(error, {
        operationId,
        themeId: request.themeId,
        fallbackCode: "publication_failed",
      }));
    }
  }

  async #performDelete(request: DesktopThemePackageDeleteRequest): Promise<DesktopThemePackageDeleteResult> {
    let operationId: string | undefined;
    let committed = false;
    try {
      if (!this.#activeGuardReady) throw repositoryError("active_theme_unknown", { themeId: request.themeId });
      if (this.#builtInThemeIds.has(request.themeId)) throw repositoryError("built_in_theme_protected", { themeId: request.themeId });
      if (this.#activeThemeId === request.themeId) throw repositoryError("active_theme_protected", { themeId: request.themeId });
      const current = this.#requireCurrent(request.themeId, request.expectedRecordRevision, request.expectedCurrentChecksumSha256);
      operationId = this.#operationId();
      const now = this.#now();
      let journal = createThemeOperationJournal({
        operationId,
        kind: "delete",
        themeId: request.themeId,
        expectedPreviousChecksumSha256: current.descriptor.packageChecksumSha256,
        now,
      });
      await writeThemeOperationJournal(this.#context(), journal);
      const trashPath = trashThemePath(this.#requirePaths(), request.themeId, operationId);
      await renameThemePath(this.#context(), current.packagePath, trashPath);
      committed = true;
      await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
      journal = advanceThemeOperationJournal(journal, "delete-staged", this.#now());
      const warnings: DesktopThemePackageWarning[] = [];
      await writeThemeOperationJournal(this.#context(), journal).catch(() => warnings.push(cleanupPendingWarning(operationId, request.themeId)));
      this.#index.delete(request.themeId);
      this.#revision += 1;
      warnings.push(...await this.#cleanupSuccess(operationId, request.themeId, [
        trashPath,
        stagingOperationPath(this.#requirePaths(), operationId),
      ]));
      return themeSuccess({ repositoryRevision: this.#revision }, dedupeThemeWarnings(warnings));
    } catch (error) {
      if (operationId && !committed) {
        await safeRemoveThemePath(this.#context(), stagingOperationPath(this.#requirePaths(), operationId)).catch(() => undefined);
      }
      return themeFailure(normalizeThemePackageError(error, { operationId, themeId: request.themeId }));
    }
  }

  #requireCurrent(themeId: string, expectedRevision: number, expectedChecksum?: string): RepositoryIndexEntry {
    const current = this.#index.get(themeId);
    if (!current) throw repositoryError("theme_not_found", { themeId });
    if (current.descriptor.recordRevision !== expectedRevision) {
      throw repositoryError("stale_repository_revision", { themeId });
    }
    const actualChecksum = current.descriptor.packageChecksumSha256;
    if (current.descriptor.health === "ready" && (!expectedChecksum || expectedChecksum !== actualChecksum)) {
      throw repositoryError("checksum_mismatch", { themeId });
    }
    if (expectedChecksum && actualChecksum && expectedChecksum !== actualChecksum) {
      throw repositoryError("checksum_mismatch", { themeId });
    }
    return current;
  }

  async #parseArchive(bytes: Uint8Array, rendererChecksum: string): Promise<ParsedLingThemePackage> {
    const parsed = await parseThemePackageBytes(bytes, { decodeImage: this.#options.decodeImage ?? decodeDesktopThemeImage });
    if (parsed.packageChecksumSha256 !== rendererChecksum) throw repositoryError("checksum_mismatch");
    return parsed;
  }

  async #recoverOperations(): Promise<DesktopThemePackageWarning[]> {
    const warnings: DesktopThemePackageWarning[] = [];
    for (const entry of await listThemeOperationJournals(this.#requirePaths())) {
      try {
        await this.#recoverOperation(entry);
      } catch (error) {
        if (normalizeThemePackageError(error).detail.code === "rollback_failed") throw error;
        warnings.push(cleanupPendingWarning(entry.operationId, entry.journal?.themeId));
      }
    }
    for (const name of await readdir(this.#requirePaths().trashRoot)) {
      const path = join(this.#requirePaths().trashRoot, name);
      await safeRemoveThemePath(this.#context(), path).catch(() => warnings.push(cleanupPendingWarning(undefined, undefined, `.trash/${name}`)));
    }
    return dedupeThemeWarnings(warnings);
  }

  async #recoverOperation(entry: JournalOperationEntry): Promise<void> {
    if (!entry.journal) {
      await safeRemoveThemePath(this.#context(), entry.operationPath);
      return;
    }
    const { journal } = entry;
    const finalPath = finalThemePath(this.#requirePaths(), journal.themeId);
    const rollbackPath = rollbackThemePath(this.#requirePaths(), journal.themeId, journal.operationId);
    const trashPath = trashThemePath(this.#requirePaths(), journal.themeId, journal.operationId);
    if (journal.phase === "staging") {
      await safeRemoveThemePath(this.#context(), entry.operationPath);
      return;
    }
    if (journal.phase === "delete-staged") {
      await safeRemoveThemePath(this.#context(), trashPath);
      await safeRemoveThemePath(this.#context(), entry.operationPath);
      return;
    }
    const finalValid = await this.#isValidPackage(finalPath);
    const rollbackValid = await this.#isValidPackage(rollbackPath);
    if (journal.phase === "candidate-ready" && journal.kind === "install" && !finalValid && rollbackValid) {
      if (await themePathExists(trashPath)) await safeRemoveThemePath(this.#context(), trashPath);
      await renameThemePath(this.#context(), rollbackPath, trashPath);
      await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
      await safeRemoveThemePath(this.#context(), trashPath);
      await safeRemoveThemePath(this.#context(), entry.operationPath);
      return;
    }
    if (journal.phase === "candidate-ready" && !rollbackValid) {
      await safeRemoveThemePath(this.#context(), entry.operationPath);
      return;
    }
    if (finalValid) {
      if (await themePathExists(rollbackPath)) {
        if (await themePathExists(trashPath)) await safeRemoveThemePath(this.#context(), trashPath);
        await renameThemePath(this.#context(), rollbackPath, trashPath);
        await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
        await safeRemoveThemePath(this.#context(), trashPath);
      }
      await safeRemoveThemePath(this.#context(), entry.operationPath);
      return;
    }
    if (rollbackValid) {
      if (await themePathExists(finalPath)) {
        if (await themePathExists(trashPath)) await safeRemoveThemePath(this.#context(), trashPath);
        await renameThemePath(this.#context(), finalPath, trashPath);
      }
      try {
        await renameThemePath(this.#context(), rollbackPath, finalPath);
        await syncDirectory(this.#context(), this.#requirePaths().authorityRoot);
        await readInstalledTheme(this.#context(), finalPath);
      } catch (error) {
        throw repositoryError("rollback_failed", { operationId: journal.operationId, themeId: journal.themeId, cause: error });
      }
      await safeRemoveThemePath(this.#context(), trashPath);
      await safeRemoveThemePath(this.#context(), entry.operationPath);
    }
  }

  async #restoreRollback(themeId: string, operationId: string): Promise<boolean> {
    const paths = this.#requirePaths();
    const finalPath = finalThemePath(paths, themeId);
    const rollbackPath = rollbackThemePath(paths, themeId, operationId);
    const trashPath = trashThemePath(paths, themeId, operationId);
    try {
      if (await themePathExists(finalPath)) await renameThemePath(this.#context(), finalPath, trashPath);
      await renameThemePath(this.#context(), rollbackPath, finalPath);
      await syncDirectory(this.#context(), paths.authorityRoot);
      const installed = await readInstalledTheme(this.#context(), finalPath);
      this.#index.set(themeId, { descriptor: this.#descriptor(installed, this.#index.get(themeId)?.descriptor.recordRevision ?? this.#revision), packagePath: finalPath });
      await safeRemoveThemePath(this.#context(), trashPath).catch(() => undefined);
      await safeRemoveThemePath(this.#context(), stagingOperationPath(paths, operationId)).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  async #quarantineFailedInstall(themeId: string, operationId: string): Promise<void> {
    const paths = this.#requirePaths();
    const finalPath = finalThemePath(paths, themeId);
    if (await themePathExists(finalPath)) {
      await renameThemePath(this.#context(), finalPath, rollbackThemePath(paths, themeId, operationId));
      await syncDirectory(this.#context(), paths.authorityRoot);
    }
  }

  async #scanIndex(): Promise<void> {
    this.#index.clear();
    for (const name of (await readdir(this.#requirePaths().authorityRoot)).sort()) {
      if (name.startsWith(".")) continue;
      let packagePath: string;
      try {
        assertPortableThemeId(name);
        packagePath = finalThemePath(this.#requirePaths(), name);
        const info = await lstat(packagePath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw repositoryError("corrupt_installation", { themeId: name });
        const installed = await readInstalledTheme(this.#context(), packagePath);
        this.#index.set(name, { descriptor: this.#descriptor(installed, 1), packagePath });
      } catch {
        try {
          packagePath = finalThemePath(this.#requirePaths(), name);
          this.#index.set(name, {
            descriptor: Object.freeze({ themeId: name, health: "corrupt", recordRevision: 1, issueCode: "corrupt_installation" }),
            packagePath,
          });
        } catch {
          // Unknown root entries are retained and never followed or exposed as installable themes.
        }
      }
    }
  }

  #publishIndex(packagePath: string, installed: ReadInstalledTheme): DesktopThemePackageDescriptor {
    this.#revision += 1;
    const descriptor = this.#descriptor(installed, this.#revision);
    this.#index.set(descriptor.themeId, { descriptor, packagePath });
    return descriptor;
  }

  #descriptor(installed: ReadInstalledTheme, recordRevision: number): DesktopThemePackageDescriptor {
    return Object.freeze({
      themeId: installed.record.themeId,
      health: "ready",
      recordRevision,
      manifest: installed.manifest,
      packageChecksumSha256: installed.record.packageChecksumSha256,
      installedAt: installed.record.installedAt,
      updatedAt: installed.record.updatedAt,
      ...(installed.preview ? { preview: installed.preview } : {}),
    });
  }

  async #cleanupSuccess(
    operationId: string,
    themeId: string,
    paths: readonly string[],
  ): Promise<DesktopThemePackageWarning[]> {
    for (const path of paths) {
      try {
        await safeRemoveThemePath(this.#context(), path);
      } catch {
        return [cleanupPendingWarning(operationId, themeId)];
      }
    }
    return [];
  }

  async #isValidPackage(path: string): Promise<boolean> {
    if (!await themePathExists(path)) return false;
    return readInstalledTheme(this.#context(), path).then(() => true, () => false);
  }

  #bootstrapSuccess(): DesktopThemePackageBootstrapResult {
    return themeSuccess({
      repositoryRevision: this.#revision,
      packages: this.#descriptors(),
      recoveryWarnings: Object.freeze([...this.#recoveryWarnings]),
      activeGuardReady: this.#activeGuardReady,
    });
  }

  #descriptors(): readonly DesktopThemePackageDescriptor[] {
    return Object.freeze([...this.#index.values()].map((entry) => entry.descriptor).sort((left, right) => left.themeId.localeCompare(right.themeId, "en-US")));
  }

  #withInitialized<T>(action: () => T | Promise<T>): T | Promise<T> | DesktopThemePackageResult<never> {
    if (!this.#initialized) return themeFailure(repositoryError("storage_unavailable"));
    return action();
  }

  #context(): ThemePackageFileContext {
    return {
      paths: this.#requirePaths(),
      platform: this.#options.platform ?? process.platform,
      decodeImage: this.#options.decodeImage ?? decodeDesktopThemeImage,
      hooks: this.#options.hooks,
      sleep: this.#options.sleep,
    };
  }

  #requirePaths(): ThemePackagePaths {
    if (!this.#paths) throw repositoryError("storage_unavailable");
    return this.#paths;
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString();
  }

  #operationId(): string {
    return this.#options.createOperationId?.() ?? randomUUID();
  }
}
