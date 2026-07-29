import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DESKTOP_THEME_PACKAGE_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";
import { encodeDesktopThemePackageFirstPaintArgument } from "../dist/shared/theme-package-first-paint.js";

const firstPaintState = Object.freeze({
  repositoryRevision: 3,
  authorityComplete: true,
  readyThemes: Object.freeze([
    Object.freeze({ themeId: "quiet-focus", packageChecksumSha256: "a".repeat(64) }),
  ]),
});

test("main-window preload exposes the complete Theme Package capability with cloned allowlist payloads", async () => {
  const calls = [];
  let exposed;
  let nextRejection;
  const ipcRenderer = {
    invoke: (channel, ...args) => {
      calls.push({ channel, args });
      if (nextRejection) {
        const rejection = nextRejection;
        nextRejection = undefined;
        return Promise.reject(rejection);
      }
      return Promise.resolve({ ok: true, value: {}, warnings: [] });
    },
    send: () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
  const contextBridge = {
    exposeInMainWorld: (name, value) => {
      assert.equal(name, "lingDesktop");
      exposed = value;
    },
  };
  await executePreload({ contextBridge, ipcRenderer });

  assert.ok(exposed);
  assert.deepEqual(Object.keys(exposed.themePackages).sort(), [
    "bootstrap",
    "delete",
    "firstPaint",
    "install",
    "list",
    "read",
    "reimport",
    "setActive",
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(exposed.themePackages.firstPaint)),
    firstPaintState,
  );

  const checksum = "a".repeat(64);
  const archiveBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer;
  await exposed.themePackages.bootstrap();
  await exposed.themePackages.list();
  await exposed.themePackages.read({
    themeId: "quiet-focus",
    includePreviewBytes: true,
    destinationPath: "/Users/private/themes",
  });
  await exposed.themePackages.install({
    requestId: "install_01",
    originalFileName: "quiet-focus.ling-theme",
    archiveBytes,
    rendererPackageChecksumSha256: checksum,
    destinationPath: "/Users/private/themes",
    stack: "private stack",
  });
  await exposed.themePackages.reimport({
    requestId: "reimport_01",
    originalFileName: "quiet-focus.ling-theme",
    archiveBytes,
    rendererPackageChecksumSha256: checksum,
    themeId: "quiet-focus",
    expectedRecordRevision: 1,
    expectedCurrentChecksumSha256: checksum,
    stagingName: "private-stage",
  });
  await exposed.themePackages.delete({
    requestId: "delete_01",
    themeId: "quiet-focus",
    expectedRecordRevision: 1,
    expectedCurrentChecksumSha256: checksum,
    absolutePath: "/Users/private/themes/quiet-focus",
  });
  await exposed.themePackages.setActive({
    themeId: "ling-dark",
    filePath: "C:\\private\\theme.json",
  });

  assert.deepEqual(calls.map(({ channel }) => channel), [
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesBootstrap,
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList,
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesRead,
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesInstall,
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport,
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesDelete,
    DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesActiveSet,
  ]);
  assert.equal(calls[0].args.length, 0);
  assert.equal(calls[1].args.length, 0);
  assert.deepEqual(Object.keys(calls[2].args[0]).sort(), ["includePreviewBytes", "themeId"]);
  assert.deepEqual(Object.keys(calls[3].args[0]).sort(), [
    "archiveBytes",
    "originalFileName",
    "rendererPackageChecksumSha256",
    "requestId",
  ]);
  assert.notEqual(calls[3].args[0].archiveBytes, archiveBytes);
  assert.deepEqual(new Uint8Array(calls[3].args[0].archiveBytes), new Uint8Array(archiveBytes));
  assert.notEqual(calls[4].args[0].archiveBytes, archiveBytes);
  assert.deepEqual(Object.keys(calls[4].args[0]).sort(), [
    "archiveBytes",
    "expectedCurrentChecksumSha256",
    "expectedRecordRevision",
    "originalFileName",
    "rendererPackageChecksumSha256",
    "requestId",
    "themeId",
  ]);
  assert.deepEqual(Object.keys(calls[5].args[0]).sort(), [
    "expectedCurrentChecksumSha256",
    "expectedRecordRevision",
    "requestId",
    "themeId",
  ]);
  assert.deepEqual(Object.keys(calls[6].args[0]), ["themeId"]);

  const invokeFailure = new Error("invoke failed without fallback");
  nextRejection = invokeFailure;
  await assert.rejects(exposed.themePackages.list(), (error) => error === invokeFailure);
  assert.equal(
    calls.filter(({ channel }) => channel === DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList).length,
    2,
    "a failed native invoke must not trigger a fallback call",
  );
});

test("main-window preload drops malformed Theme Package first-paint arguments", async () => {
  let exposed;
  await executePreload({
    contextBridge: {
      exposeInMainWorld: (_name, value) => {
        exposed = value;
      },
    },
    ipcRenderer: {
      invoke: async () => ({ ok: true, value: {}, warnings: [] }),
      send: () => undefined,
      on: () => undefined,
      off: () => undefined,
    },
  }, [
    "electron",
    "app",
    "--ling-daemon-base-url=http://127.0.0.1:17891",
    "--ling-theme-package-first-paint=%7B%22repositoryRevision%22%3A0%7D",
  ]);
  assert.equal("firstPaint" in exposed.themePackages, false);
});

async function executePreload(electronMock, argv = [
  "electron",
  "app",
  "--ling-daemon-base-url=http://127.0.0.1:17891",
  encodeDesktopThemePackageFirstPaintArgument(firstPaintState),
]) {
  const preloadUrl = new URL("../dist/preload/main-window.cjs", import.meta.url);
  const source = await readFile(preloadUrl, "utf8");
  const preloadPath = fileURLToPath(preloadUrl);
  const requireFromTest = createRequire(import.meta.url);
  const module = { exports: {} };
  const processMock = new Proxy(process, {
    get: (target, property, receiver) => property === "argv"
      ? argv
      : Reflect.get(target, property, receiver),
  });
  const sandbox = {
    Buffer,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process: processMock,
    require: (specifier) => specifier === "electron" ? electronMock : requireFromTest(specifier),
    setTimeout,
    __dirname: dirname(preloadPath),
    __filename: preloadPath,
  };
  vm.runInNewContext(source, sandbox, { filename: resolve(preloadPath) });
}
