import { expect, test } from "@playwright/test";
import { lingLightTheme, type LingThemePackManifest } from "@ling-stack/ui-react/theme";
import type { DesktopThemePackageCapabilities } from "../../desktop/shared/theme-package-capabilities.js";
import {
  DesktopThemePackageRepositoryAdapter,
  WebThemePackageRepositoryAdapter,
  createThemePackageRepository,
  themePackageRepositorySuccess,
  type StoredWebThemePackage,
  type ThemePackageRepositoryDescriptor,
  type ThemePackageRepositoryInstallRequest,
  type ThemePackageRepositoryPort,
  type WebThemePackageRepositoryDependencies,
} from "../src/shared/ui/theme/package/index.js";
import { createDesktopThemeActiveBridge } from "../src/shared/ui/theme/desktop-theme-active-bridge.js";

const manifest = Object.freeze({
  ...lingLightTheme,
  id: "adapter-theme",
  name: "Adapter Theme",
  source: "local-import",
}) satisfies LingThemePackManifest;

const descriptor = Object.freeze({
  health: "ready",
  installedAt: "2026-07-26T00:00:00.000Z",
  manifest,
  packageChecksumSha256: "a".repeat(64),
  recordRevision: 1,
  themeId: manifest.id,
  updatedAt: "2026-07-26T00:00:00.000Z",
}) satisfies ThemePackageRepositoryDescriptor;

test("factory locks a complete Desktop capability and never falls back after native failure", async () => {
  let webFactoryCalls = 0;
  const native = fakeDesktopCapability({
    bootstrap: async () => ({
      ok: false,
      error: { code: "storage_unavailable", retryable: true },
    }),
  });
  const repository = createThemePackageRepository({
    desktopCapability: native,
    createWebRepository: () => {
      webFactoryCalls += 1;
      return fakeWebPort();
    },
  });

  expect(repository.kind).toBe("desktop");
  expect(await repository.bootstrap()).toEqual({
    ok: false,
    error: { code: "storage_unavailable", retryable: true },
  });
  expect((await repository.list()).ok).toBe(true);
  expect(webFactoryCalls).toBe(0);
});

test("factory treats a partial Desktop capability as absent and preserves the legacy Web path", async () => {
  let nativeCalls = 0;
  const web = new WebThemePackageRepositoryAdapter(fakeWebDependencies([legacyStoredPackage()]));
  const repository = createThemePackageRepository({
    desktopCapability: {
      bootstrap: async () => {
        nativeCalls += 1;
        return themePackageRepositorySuccess({
          activeGuardReady: false,
          packages: [],
          recoveryWarnings: [],
          repositoryRevision: 0,
        });
      },
    },
    createWebRepository: () => web,
  });

  const result = await repository.bootstrap();
  expect(repository.kind).toBe("web");
  expect(nativeCalls).toBe(0);
  expect(result.ok && result.value.packages).toHaveLength(1);
  expect(result.ok && result.value.packages[0]).toMatchObject({
    health: "ready",
    manifest: { id: manifest.id },
  });
  expect(result.ok && "packageChecksumSha256" in result.value.packages[0]!).toBe(false);
});

test("Desktop adapter copies archive and preview bytes without exposing paths or object URLs", async () => {
  let receivedArchive: ArrayBuffer | undefined;
  const previewBytes = Uint8Array.from([9, 8, 7]).buffer;
  const capability = fakeDesktopCapability({
    install: async (request) => {
      receivedArchive = request.archiveBytes;
      return themePackageRepositorySuccess(descriptor);
    },
    read: async () => themePackageRepositorySuccess({
      descriptor: {
        ...descriptor,
        preview: {
          byteLength: 3,
          checksumSha256: "b".repeat(64),
          height: 1,
          mimeType: "image/png",
          path: "preview.png",
          width: 1,
        },
      },
      previewBytes,
    }),
  });
  const repository = new DesktopThemePackageRepositoryAdapter(capability);
  const source = Uint8Array.from([1, 2, 3]);
  const installResult = await repository.install(installRequest(source));
  source[0] = 99;

  expect(installResult.ok).toBe(true);
  expect(receivedArchive).toBeDefined();
  expect(receivedArchive).not.toBe(source.buffer);
  expect([...new Uint8Array(receivedArchive!)]).toEqual([1, 2, 3]);

  const readResult = await repository.read({ includePreviewBytes: true, themeId: manifest.id });
  new Uint8Array(previewBytes)[0] = 42;
  expect(readResult.ok).toBe(true);
  if (!readResult.ok) return;
  expect(readResult.value.preview).toBeDefined();
  expect([...new Uint8Array(await readResult.value.preview!.blob.arrayBuffer())]).toEqual([9, 8, 7]);
  expect(JSON.stringify(readResult.value)).not.toContain("file://");
  expect(JSON.stringify(readResult.value)).not.toContain("/Users/");
  expect("previewUrl" in readResult.value).toBe(false);
});

test("Desktop adapter maps every operation and preserves typed native errors", async () => {
  const calls: string[] = [];
  const capability = fakeDesktopCapability({
    bootstrap: async () => {
      calls.push("bootstrap");
      return themePackageRepositorySuccess({
        activeGuardReady: false,
        packages: [descriptor],
        recoveryWarnings: [],
        repositoryRevision: 1,
      });
    },
    delete: async () => {
      calls.push("delete");
      return themePackageRepositorySuccess({ repositoryRevision: 3 });
    },
    install: async () => {
      calls.push("install");
      return {
        ok: false,
        error: { code: "disk_full", operationId: "op-1", retryable: true, themeId: manifest.id },
      };
    },
    list: async () => {
      calls.push("list");
      return themePackageRepositorySuccess([descriptor]);
    },
    read: async () => {
      calls.push("read");
      return themePackageRepositorySuccess({ descriptor });
    },
    reimport: async () => {
      calls.push("reimport");
      return themePackageRepositorySuccess({ ...descriptor, recordRevision: 2 });
    },
    setActive: async ({ themeId }) => {
      calls.push(`active:${themeId}`);
      return themePackageRepositorySuccess({ activeThemeId: themeId });
    },
  });
  const repository = new DesktopThemePackageRepositoryAdapter(capability);
  const activeBridge = createDesktopThemeActiveBridge(repository);

  await repository.bootstrap();
  await repository.list();
  await repository.read({ includePreviewBytes: false, themeId: manifest.id });
  const installResult = await repository.install(installRequest());
  await repository.reimport({
    ...installRequest(),
    expectedCurrentChecksumSha256: descriptor.packageChecksumSha256,
    expectedRecordRevision: 1,
    themeId: manifest.id,
  });
  await repository.delete({
    expectedCurrentChecksumSha256: descriptor.packageChecksumSha256,
    expectedRecordRevision: 2,
    requestId: "delete-1",
    themeId: manifest.id,
  });
  await activeBridge.syncActiveTheme("ling-light");

  expect(installResult).toEqual({
    ok: false,
    error: { code: "disk_full", operationId: "op-1", retryable: true, themeId: manifest.id },
  });
  expect(calls).toEqual([
    "bootstrap",
    "list",
    "read",
    "install",
    "reimport",
    "delete",
    "active:ling-light",
  ]);
});

test("Web adapter keeps IndexedDB semantics for install, read, reimport, active, and delete", async () => {
  const stored = new Map<string, StoredWebThemePackage>();
  const dependencies = fakeWebDependencies([], stored);
  const repository = new WebThemePackageRepositoryAdapter(dependencies);

  const initial = await repository.bootstrap();
  expect(initial.ok && initial.value.packages).toEqual([]);
  const installed = await repository.install(installRequest());
  expect(installed.ok && installed.value.recordRevision).toBe(1);
  expect((await repository.list()).ok).toBe(true);
  const read = await repository.read({ includePreviewBytes: true, themeId: manifest.id });
  expect(read.ok && read.value.descriptor.manifest?.id).toBe(manifest.id);

  const replacement = {
    ...installRequest(),
    publication: { ...installRequest().publication, manifest: { ...manifest, name: "Adapter Theme Refined" } },
    expectedCurrentChecksumSha256: descriptor.packageChecksumSha256,
    expectedRecordRevision: 1,
    themeId: manifest.id,
  };
  const reimported = await repository.reimport(replacement);
  expect(reimported.ok && reimported.value.recordRevision).toBe(2);
  expect((await repository.setActive({ themeId: manifest.id })).ok).toBe(true);
  const deleted = await repository.delete({
    expectedCurrentChecksumSha256: descriptor.packageChecksumSha256,
    expectedRecordRevision: 2,
    requestId: "delete-web",
    themeId: manifest.id,
  });
  expect(deleted.ok).toBe(true);
  expect(stored.has(manifest.id)).toBe(false);
});

test("Web storage failures become typed results instead of leaking DOM exceptions", async () => {
  const dependencies: WebThemePackageRepositoryDependencies = {
    ...fakeWebDependencies(),
    putStoredPackage: async () => {
      throw new DOMException("private browser detail", "QuotaExceededError");
    },
  };
  const repository = new WebThemePackageRepositoryAdapter(dependencies);

  expect(await repository.install(installRequest())).toEqual({
    ok: false,
    error: { code: "disk_full", retryable: true, themeId: manifest.id },
  });
});

function installRequest(bytes = Uint8Array.from([1, 2, 3])): ThemePackageRepositoryInstallRequest {
  return {
    archiveBytes: bytes,
    originalFileName: "adapter-theme.ling-theme",
    publication: {
      manifest,
      packageChecksumSha256: descriptor.packageChecksumSha256!,
    },
    requestId: "install-1",
  };
}

function fakeDesktopCapability(
  overrides: Partial<DesktopThemePackageCapabilities> = {},
): DesktopThemePackageCapabilities {
  return {
    bootstrap: async () => themePackageRepositorySuccess({
      activeGuardReady: false,
      packages: [],
      recoveryWarnings: [],
      repositoryRevision: 1,
    }),
    delete: async () => themePackageRepositorySuccess({ repositoryRevision: 2 }),
    install: async () => themePackageRepositorySuccess(descriptor),
    list: async () => themePackageRepositorySuccess([descriptor]),
    read: async () => themePackageRepositorySuccess({ descriptor }),
    reimport: async () => themePackageRepositorySuccess(descriptor),
    setActive: async ({ themeId }) => themePackageRepositorySuccess({ activeThemeId: themeId }),
    ...overrides,
  };
}

function fakeWebDependencies(
  initial: readonly StoredWebThemePackage[] = [],
  stored = new Map(initial.map((value) => [value.manifest.id, value])),
): WebThemePackageRepositoryDependencies {
  return {
    deleteStoredManifest: async (themeId) => {
      stored.delete(themeId);
    },
    deleteStoredPackage: async (themeId) => {
      stored.delete(themeId);
    },
    listStoredManifests: async () => [...stored.values()].map((value) => value.manifest),
    putStoredPackage: async (publication, installedAt) => {
      const value: StoredWebThemePackage = Object.freeze({
        installedAt: installedAt ?? "2026-07-26T00:00:00.000Z",
        manifest: publication.manifest,
        packageChecksumSha256: publication.packageChecksumSha256,
        updatedAt: "2026-07-26T00:01:00.000Z",
        ...(publication.licenseText !== undefined ? { licenseText: publication.licenseText } : {}),
        ...(publication.preview !== undefined ? { preview: publication.preview } : {}),
      });
      stored.set(value.manifest.id, value);
      return value;
    },
    readStoredPackage: async (themeId) => stored.get(themeId),
  };
}

function legacyStoredPackage(): StoredWebThemePackage {
  return {
    installedAt: new Date(0).toISOString(),
    manifest,
    updatedAt: new Date(0).toISOString(),
  };
}

function fakeWebPort(): ThemePackageRepositoryPort {
  return new WebThemePackageRepositoryAdapter(fakeWebDependencies());
}
