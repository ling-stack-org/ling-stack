import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_BYTES,
  importedManifest,
  themePackageFixture,
} from "../../../packages/ui-react/test/fixtures/theme-package-fixtures.mjs";
import { DesktopThemePackageRepository } from "../dist/main/theme-packages/theme-package-repository.js";

export { IMAGE_BYTES, importedManifest, themePackageFixture };

export async function createRepositoryFixture(options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ling-theme-repository-"));
  const themesRoot = join(temporaryRoot, "themes");
  const repository = new DesktopThemePackageRepository({
    themesRoot,
    decodeImage: async () => ({ width: 1280, height: 800 }),
    ...options,
  });
  return { repository, temporaryRoot, themesRoot };
}

export function archiveRequest(bytes, overrides = {}) {
  const owned = Uint8Array.from(bytes);
  return {
    requestId: overrides.requestId ?? "request-1",
    originalFileName: overrides.originalFileName ?? "quiet-focus.ling-theme",
    archiveBytes: owned.buffer,
    rendererPackageChecksumSha256: sha256(owned),
    ...overrides,
  };
}

export function archiveFor(themeId, overrides = {}) {
  return themePackageFixture({
    manifest: importedManifest({ id: themeId, name: overrides.name ?? themeId, ...overrides.manifest }),
    ...(overrides.license !== undefined ? { license: overrides.license } : {}),
    ...(overrides.preview ? { preview: overrides.preview } : {}),
  });
}

export async function rewriteInstallation(packagePath, update) {
  const path = join(packagePath, "installation.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  const next = update(structuredClone(record));
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

export async function writeJournal(themesRoot, journal) {
  const operationPath = join(themesRoot, ".staging", journal.operationId);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(operationPath, { recursive: true, mode: 0o700 });
  await writeFile(join(operationPath, "operation.json"), `${JSON.stringify({
    journalSchemaVersion: 1,
    startedAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:01.000Z",
    ...journal,
  }, null, 2)}\n`, { mode: 0o600 });
  return operationPath;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function errno(code) {
  return Object.assign(new Error(code), { code });
}
