import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  DESKTOP_THEME_PACKAGE_ERROR_CODES,
  DESKTOP_THEME_PACKAGE_WARNING_CODES,
} from "../dist/shared/theme-package-capabilities.js";
import {
  createDesktopThemePackageFirstPaintState,
  encodeDesktopThemePackageFirstPaintArgument,
  parseDesktopThemePackageFirstPaintArgument,
} from "../dist/shared/theme-package-first-paint.js";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_THEME_PACKAGE_IPC_CHANNELS,
} from "../dist/shared/ipc-channels.js";

const expectedErrorCodes = [
  "unauthorized_sender",
  "invalid_request",
  "archive_empty",
  "archive_too_large",
  "invalid_archive",
  "unsupported_archive",
  "unsafe_path",
  "unsupported_entry",
  "unsupported_file",
  "invalid_entry_size",
  "invalid_entry_crc",
  "invalid_text",
  "invalid_manifest",
  "invalid_schema",
  "reserved_theme_id",
  "runtime_artwork_not_supported",
  "missing_preview",
  "invalid_preview_mime",
  "invalid_preview_image",
  "invalid_preview_dimensions",
  "checksum_mismatch",
  "theme_id_mismatch",
  "theme_already_installed",
  "theme_not_found",
  "built_in_theme_protected",
  "active_theme_protected",
  "active_theme_unknown",
  "stale_repository_revision",
  "operation_in_progress",
  "storage_unavailable",
  "permission_denied",
  "disk_full",
  "corrupt_installation",
  "publication_failed",
  "rollback_failed",
  "cleanup_failed",
  "unknown_io",
];

const expectedChannels = {
  themePackagesBootstrap: "ling-desktop:theme-packages:bootstrap",
  themePackagesList: "ling-desktop:theme-packages:list",
  themePackagesRead: "ling-desktop:theme-packages:read",
  themePackagesInstall: "ling-desktop:theme-packages:install",
  themePackagesReimport: "ling-desktop:theme-packages:reimport",
  themePackagesDelete: "ling-desktop:theme-packages:delete",
  themePackagesActiveSet: "ling-desktop:theme-packages:active-set",
};

test("Desktop Theme Package contract freezes stable codes and IPC channel names", () => {
  assert.deepEqual(DESKTOP_THEME_PACKAGE_ERROR_CODES, expectedErrorCodes);
  assert.deepEqual(DESKTOP_THEME_PACKAGE_WARNING_CODES, ["cleanup_pending"]);
  assert.deepEqual(DESKTOP_THEME_PACKAGE_IPC_CHANNELS, expectedChannels);

  for (const [key, channel] of Object.entries(expectedChannels)) {
    assert.equal(DESKTOP_IPC_CHANNELS[key], channel);
  }
  assert.equal(
    new Set(Object.values(DESKTOP_IPC_CHANNELS)).size,
    Object.values(DESKTOP_IPC_CHANNELS).length,
    "Desktop IPC channel values must remain unique",
  );
});

test("Desktop Theme Package transport values remain structural-clone safe", () => {
  const archiveBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer;
  const request = {
    requestId: "install_01",
    originalFileName: "quiet-focus.ling-theme",
    archiveBytes,
    rendererPackageChecksumSha256: "a".repeat(64),
  };
  const success = {
    ok: true,
    value: {
      themeId: "quiet-focus",
      health: "ready",
      recordRevision: 1,
    },
    warnings: [{ code: "cleanup_pending", retryable: true }],
  };
  const failure = {
    ok: false,
    error: {
      code: "permission_denied",
      operationId: "install_01",
      themeId: "quiet-focus",
      relativePath: "assets/preview.webp",
      retryable: true,
    },
  };

  const clonedRequest = structuredClone(request);
  assert.deepEqual(new Uint8Array(clonedRequest.archiveBytes), new Uint8Array(archiveBytes));
  assert.deepEqual(structuredClone(success), success);
  assert.deepEqual(structuredClone(failure), failure);
});

test("Desktop Theme Package first-paint authority is sorted, bounded, and round-trips safely", async () => {
  const state = createDesktopThemePackageFirstPaintState({
    repositoryRevision: 5,
    packages: [
      { themeId: "zeta-focus", health: "ready", recordRevision: 1, packageChecksumSha256: "b".repeat(64) },
      { themeId: "broken-focus", health: "corrupt", recordRevision: 2 },
      { themeId: "alpha-focus", health: "ready", recordRevision: 3, packageChecksumSha256: "a".repeat(64) },
    ],
    recoveryWarnings: [],
    activeGuardReady: false,
  });
  assert.deepEqual(state, {
    repositoryRevision: 5,
    authorityComplete: true,
    readyThemes: [
      { themeId: "alpha-focus", packageChecksumSha256: "a".repeat(64) },
      { themeId: "zeta-focus", packageChecksumSha256: "b".repeat(64) },
    ],
  });
  const argument = encodeDesktopThemePackageFirstPaintArgument(state);
  assert.deepEqual(parseDesktopThemePackageFirstPaintArgument(["electron", argument]), state);
  assert.equal(parseDesktopThemePackageFirstPaintArgument([
    "electron",
    "--ling-theme-package-first-paint=%7B%22repositoryRevision%22%3A1%2C%22authorityComplete%22%3Atrue%2C%22readyThemes%22%3A%5B%5D%7D",
    "--ling-theme-package-first-paint=%7B%22repositoryRevision%22%3A1%2C%22authorityComplete%22%3Atrue%2C%22readyThemes%22%3A%5B%5D%7D",
  ]), undefined);
  assert.equal(parseDesktopThemePackageFirstPaintArgument([
    "electron",
    "--ling-theme-package-first-paint=not-json",
  ]), undefined);

  const overflowState = createDesktopThemePackageFirstPaintState({
    repositoryRevision: 6,
    packages: Array.from({ length: 257 }, (_, index) => ({
      themeId: `theme-${String(index).padStart(3, "0")}`,
      health: "ready",
      recordRevision: 1,
      packageChecksumSha256: "c".repeat(64),
    })),
    recoveryWarnings: [],
    activeGuardReady: false,
  });
  assert.deepEqual(overflowState, {
    repositoryRevision: 6,
    authorityComplete: false,
    readyThemes: [],
  });
  assert.doesNotThrow(() => encodeDesktopThemePackageFirstPaintArgument(overflowState));

  const firstPaintSource = await readFile(
    new URL("../dist/shared/theme-package-first-paint.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(firstPaintSource, /localeCompare/u);
});

test("Desktop Theme Package declarations expose exhaustive safe transport types", async () => {
  const declarations = await readFile(
    new URL("../dist/shared/theme-package-capabilities.d.ts", import.meta.url),
    "utf8",
  );

  for (const exportedType of [
    "DesktopThemePackageReadRequest",
    "DesktopThemePackageArchiveRequest",
    "DesktopThemePackageReimportRequest",
    "DesktopThemePackageDeleteRequest",
    "DesktopThemePackageSetActiveRequest",
    "DesktopThemePackageResult",
    "DesktopThemePackageBootstrapResult",
    "DesktopThemePackageListResult",
    "DesktopThemePackageReadResult",
    "DesktopThemePackageInstallResult",
    "DesktopThemePackageReimportResult",
    "DesktopThemePackageDeleteResult",
    "DesktopThemePackageSetActiveResult",
    "DesktopThemePackageError",
    "DesktopThemePackageCapabilities",
    "DesktopThemePackageFirstPaintState",
  ]) {
    assert.match(declarations, new RegExp(`export (?:interface|type) ${exportedType}\\b`, "u"));
  }

  for (const forbiddenField of [
    "destination",
    "directory",
    "filePath",
    "absolutePath",
    "osError",
    "stack",
    "acl",
    "username",
    "stagingName",
  ]) {
    assert.doesNotMatch(declarations, new RegExp(`\\b${forbiddenField}\\??:`, "iu"));
  }
});

test("Desktop Theme Package static ownership keeps IPC, parsing and filesystem work in focused owners", async () => {
  const mainRoot = new URL("../main/", import.meta.url);
  const mainSources = await readTypeScriptSources(mainRoot);
  const ipcOwner = mainSources.find(({ path }) => path.endsWith("theme-packages/theme-package-ipc.ts"));
  const repositoryOwner = mainSources.find(({ path }) => path.endsWith("theme-packages/theme-package-repository.ts"));
  assert.ok(ipcOwner);
  assert.ok(repositoryOwner);

  const handlerOwners = mainSources.filter(({ source }) => (
    /DESKTOP_THEME_PACKAGE_IPC_CHANNELS\.themePackages/u.test(source)
    || /registerDesktopThemePackageIpc/u.test(source)
  ));
  assert.deepEqual(
    handlerOwners.map(({ path }) => path.replaceAll("\\", "/")).sort(),
    ["main.ts", "theme-packages/theme-package-ipc.ts"],
  );
  for (const key of Object.keys(expectedChannels)) {
    assert.equal(
      [...ipcOwner.source.matchAll(new RegExp(`DESKTOP_THEME_PACKAGE_IPC_CHANNELS\\.${key}\\b`, "gu"))].length,
      1,
      `${key} must have one IPC registration owner`,
    );
  }

  const mainEntry = mainSources.find(({ path }) => path === "main.ts");
  const legacyIpc = mainSources.find(({ path }) => path === "ipc.ts");
  assert.ok(mainEntry);
  assert.ok(legacyIpc);
  assert.doesNotMatch(mainEntry.source, /ipcMain\.(?:handle|on)\(|parseThemePackageBytes|archiveBytes|\.staging/u);
  assert.doesNotMatch(legacyIpc.source, /themePackages|theme-package|ling-theme/iu);
  assert.match(
    repositoryOwner.source,
    /parseThemePackageBytes\(bytes, \{ decodeImage: this\.#options\.decodeImage \?\? decodeDesktopThemeImage \}\)/u,
  );

  const preloadSource = await readFile(new URL("../preload/main-window.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    preloadSource,
    /parseThemePackageBytes|DesktopThemePackageRepository|node:fs|node:path|\.staging|\.rollback|\.trash/u,
  );

  const webParserSource = await readFile(
    new URL("../../web/src/shared/ui/theme/package/web-theme-package-parser.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    webParserSource,
    /parseThemePackageBytes\(archiveBytes, \{ decodeImage: decodeWebThemeImage \}\)/u,
  );
});

async function readTypeScriptSources(root) {
  const sources = [];
  await visit(root, "");
  return sources;

  async function visit(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) {
        await visit(url, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sources.push({ path: relativePath, source: await readFile(url, "utf8") });
      }
    }
  }
}
