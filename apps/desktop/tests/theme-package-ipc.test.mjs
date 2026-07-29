import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { registerDesktopThemePackageIpc } from "../dist/main/theme-packages/theme-package-ipc.js";
import { DESKTOP_THEME_PACKAGE_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";
import { DESKTOP_THEME_PACKAGE_ERROR_CODES } from "../dist/shared/theme-package-capabilities.js";

const checksum = "a".repeat(64);
const descriptor = Object.freeze({
  themeId: "quiet-focus",
  health: "ready",
  recordRevision: 1,
  packageChecksumSha256: checksum,
});

test("Theme Package IPC authorizes the live main frame and normalizes every request", async () => {
  const ipc = new FakeIpcMain();
  const owner = createOwner();
  const calls = [];
  const repository = createRepository(calls);
  const unregister = registerDesktopThemePackageIpc({
    ipcMainImpl: ipc,
    repository,
    getMainWindow: () => owner.window,
  });

  assert.equal(ipc.handlers.size, 7);
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesBootstrap, owner.event),
    success({ repositoryRevision: 1, packages: [], recoveryWarnings: [], activeGuardReady: false }),
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList, owner.event),
    success([descriptor]),
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesRead, owner.event, {
      themeId: "quiet-focus",
      includePreviewBytes: true,
      harmlessFutureField: "ignored",
    }),
    success({ descriptor }),
  );

  const archiveBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer;
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesInstall, owner.event, {
      requestId: "install_01",
      originalFileName: "quiet-focus.ling-theme",
      archiveBytes,
      rendererPackageChecksumSha256: checksum,
      harmlessFutureField: true,
    }),
    success(descriptor),
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport, owner.event, {
      requestId: "reimport_01",
      originalFileName: "quiet-focus.ling-theme",
      archiveBytes,
      rendererPackageChecksumSha256: checksum,
      themeId: "quiet-focus",
      expectedCurrentChecksumSha256: checksum,
      expectedRecordRevision: 1,
    }),
    success(descriptor),
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesDelete, owner.event, {
      requestId: "delete_01",
      themeId: "quiet-focus",
      expectedCurrentChecksumSha256: checksum,
      expectedRecordRevision: 1,
    }),
    success({ repositoryRevision: 2 }),
  );
  assert.deepEqual(
    await ipc.invoke(DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesActiveSet, owner.event, {
      themeId: "ling-dark",
    }),
    success({ activeThemeId: "ling-dark" }),
  );

  assert.deepEqual(calls.map(([operation]) => operation), [
    "bootstrap",
    "list",
    "read",
    "install",
    "reimport",
    "delete",
    "setActive",
  ]);
  assert.deepEqual(calls[2][1], { themeId: "quiet-focus", includePreviewBytes: true });
  assert.notEqual(calls[3][1].archiveBytes, archiveBytes);
  assert.deepEqual(new Uint8Array(calls[3][1].archiveBytes), new Uint8Array(archiveBytes));
  assert.equal("harmlessFutureField" in calls[3][1], false);

  unregister();
  unregister();
  assert.equal(ipc.handlers.size, 0, "dispose must remove every handler and remain idempotent");
});

test("Theme Package IPC rejects foreign, PiP, stale, destroyed, subframe, and URL-mismatched senders", async () => {
  const ipc = new FakeIpcMain();
  const owner = createOwner();
  let currentWindow = owner.window;
  const calls = [];
  const unregister = registerDesktopThemePackageIpc({
    ipcMainImpl: ipc,
    repository: createRepository(calls),
    getMainWindow: () => currentWindow,
  });
  const listChannel = DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList;

  const foreign = createOwner({ id: 22 });
  for (const channel of Object.values(DESKTOP_THEME_PACKAGE_IPC_CHANNELS)) {
    assert.deepEqual(
      await ipc.invoke(channel, foreign.event, ...validArgsFor(channel)),
      failure("unauthorized_sender"),
    );
  }

  const sameIdDifferentWebContents = createOwner({ id: 11 });
  assert.deepEqual(
    await ipc.invoke(listChannel, sameIdDifferentWebContents.event),
    failure("unauthorized_sender"),
  );
  const pictureInPicture = createOwner({ id: 23 });
  assert.deepEqual(
    await ipc.invoke(listChannel, pictureInPicture.event),
    failure("unauthorized_sender"),
  );
  owner.state.senderDestroyed = true;
  assert.deepEqual(await ipc.invoke(listChannel, owner.event), failure("unauthorized_sender"));
  owner.state.senderDestroyed = false;
  owner.state.windowDestroyed = true;
  assert.deepEqual(await ipc.invoke(listChannel, owner.event), failure("unauthorized_sender"));
  owner.state.windowDestroyed = false;
  owner.state.webContentsDestroyed = true;
  assert.deepEqual(await ipc.invoke(listChannel, owner.event), failure("unauthorized_sender"));
  owner.state.webContentsDestroyed = false;

  const subframe = { url: owner.url };
  assert.deepEqual(
    await ipc.invoke(listChannel, { sender: owner.webContents, senderFrame: subframe }),
    failure("unauthorized_sender"),
  );
  owner.frame.url = "file:///tampered/index.html";
  assert.deepEqual(await ipc.invoke(listChannel, owner.event), failure("unauthorized_sender"));
  owner.frame.url = owner.url;
  currentWindow = undefined;
  assert.deepEqual(await ipc.invoke(listChannel, owner.event), failure("unauthorized_sender"));
  currentWindow = createOwner({ id: 33 }).window;
  assert.deepEqual(await ipc.invoke(listChannel, owner.event), failure("unauthorized_sender"));
  assert.equal(calls.length, 0, "unauthorized requests must not reach the repository");

  unregister();
});

test("Theme Package IPC preserves setActive results for built-in, ready, unknown and corrupt themes", async () => {
  const ipc = new FakeIpcMain();
  const owner = createOwner();
  const calls = [];
  const repository = createRepository(calls);
  repository.setActive = async (request) => {
    calls.push(["setActive", request]);
    return request.themeId === "ling-light" || request.themeId === "ready-theme"
      ? success({ activeThemeId: request.themeId })
      : failure("theme_not_found");
  };
  const unregister = registerDesktopThemePackageIpc({
    ipcMainImpl: ipc,
    repository,
    getMainWindow: () => owner.window,
  });
  const channel = DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesActiveSet;

  assert.deepEqual(
    await ipc.invoke(channel, owner.event, { themeId: "ling-light" }),
    success({ activeThemeId: "ling-light" }),
  );
  assert.deepEqual(
    await ipc.invoke(channel, owner.event, { themeId: "ready-theme" }),
    success({ activeThemeId: "ready-theme" }),
  );
  assert.deepEqual(
    await ipc.invoke(channel, owner.event, { themeId: "unknown-theme" }),
    failure("theme_not_found"),
  );
  assert.deepEqual(
    await ipc.invoke(channel, owner.event, { themeId: "corrupt-theme" }),
    failure("theme_not_found"),
  );
  assert.deepEqual(calls, [
    ["setActive", { themeId: "ling-light" }],
    ["setActive", { themeId: "ready-theme" }],
    ["setActive", { themeId: "unknown-theme" }],
    ["setActive", { themeId: "corrupt-theme" }],
  ]);
  unregister();
});

test("Theme Package IPC enforces request shape, byte budgets, and path exclusion", async () => {
  const ipc = new FakeIpcMain();
  const owner = createOwner();
  const calls = [];
  const unregister = registerDesktopThemePackageIpc({
    ipcMainImpl: ipc,
    repository: createRepository(calls),
    getMainWindow: () => owner.window,
  });
  const install = DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesInstall;
  const validInstall = validArgsFor(install)[0];
  const invalidCases = [
    [DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesBootstrap, [{ unexpected: true }], "invalid_request"],
    [DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesRead, [{ themeId: "quiet-focus", includePreviewBytes: "yes" }], "invalid_request"],
    [install, [{ ...validInstall, requestId: "bad request" }], "invalid_request"],
    [install, [{ ...validInstall, originalFileName: "../quiet-focus.ling-theme" }], "invalid_request"],
    [install, [{ ...validInstall, originalFileName: "quiet-focus.zip" }], "invalid_request"],
    [install, [{ ...validInstall, rendererPackageChecksumSha256: checksum.toUpperCase() }], "invalid_request"],
    [install, [{ ...validInstall, archiveBytes: new ArrayBuffer(0) }], "archive_empty"],
    [install, [{ ...validInstall, archiveBytes: new ArrayBuffer(20 * 1024 * 1024 + 1) }], "archive_too_large"],
    [install, [{ ...validInstall, archiveBytes: new SharedArrayBuffer(8) }], "invalid_request"],
    [install, [{ ...validInstall, destinationPath: "/Users/private/themes" }], "invalid_request"],
    [install, [validInstall, { extra: true }], "invalid_request"],
    [DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport, [{
      ...validInstall,
      themeId: "CON",
      expectedRecordRevision: 1,
    }], "invalid_request"],
    [DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport, [{
      ...validInstall,
      themeId: "quiet-focus",
      expectedRecordRevision: 0,
    }], "invalid_request"],
    [DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesDelete, [{
      requestId: "delete_01",
      themeId: "quiet-focus",
      expectedRecordRevision: 1,
      expectedCurrentChecksumSha256: "short",
    }], "invalid_request"],
    [DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesActiveSet, [{ themeId: "../quiet-focus" }], "invalid_request"],
  ];

  for (const [channel, args, code] of invalidCases) {
    assert.deepEqual(await ipc.invoke(channel, owner.event, ...args), failure(code));
  }
  for (const forbiddenField of ["destination", "directory", "filePath", "path", "URL", "manifest", "validated"]) {
    assert.deepEqual(
      await ipc.invoke(install, owner.event, { ...validInstall, [forbiddenField]: "private" }),
      failure("invalid_request"),
    );
  }
  assert.equal(calls.length, 0, "invalid requests must not reach the repository");
  unregister();
});

test("Theme Package IPC converts raw failures and strips unsafe diagnostic fields", async () => {
  const ipc = new FakeIpcMain();
  const owner = createOwner();
  let mode = "throw";
  const repository = createRepository([]);
  repository.list = async () => {
    if (mode === "throw") throw new Error("EACCES /Users/private/themes/.staging secret");
    return {
      ok: false,
      error: {
        code: "permission_denied",
        retryable: true,
        relativePath: "/Users/private/themes",
        stack: "secret stack",
        osError: "EACCES",
      },
    };
  };
  const unregister = registerDesktopThemePackageIpc({
    ipcMainImpl: ipc,
    repository,
    getMainWindow: () => owner.window,
  });
  const channel = DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList;

  assert.deepEqual(await ipc.invoke(channel, owner.event), failure("unknown_io", true));
  mode = "typed";
  assert.deepEqual(await ipc.invoke(channel, owner.event), failure("permission_denied", true));
  for (const code of DESKTOP_THEME_PACKAGE_ERROR_CODES) {
    repository.list = async () => ({ ok: false, error: { code, retryable: false } });
    assert.deepEqual(await ipc.invoke(channel, owner.event), failure(code));
  }
  unregister();
});

test("Theme Package main wiring stays thin and initializes before registration", async () => {
  const source = await readFile(new URL("../main/main.ts", import.meta.url), "utf8");
  const initializeAt = source.indexOf("await desktopThemePackageRepository.initialize()");
  const registerAt = source.indexOf("unregisterThemePackageIpc = registerDesktopThemePackageIpc");
  const createWindowAt = source.indexOf("const loadedWindow = await createMainWindow");
  const disposeAt = source.indexOf("activeUnregisterThemePackageIpc?.()");
  assert.ok(initializeAt > 0 && initializeAt < registerAt);
  assert.ok(registerAt < createWindowAt);
  assert.ok(disposeAt > createWindowAt);
  assert.doesNotMatch(source, /ipcMain\.(?:handle|on)\(/u);
  assert.doesNotMatch(source, /parseThemePackageBytes|archiveBytes|\.staging/u);
});

function validArgsFor(channel) {
  const archive = {
    requestId: "request_01",
    originalFileName: "quiet-focus.ling-theme",
    archiveBytes: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
    rendererPackageChecksumSha256: checksum,
  };
  switch (channel) {
    case DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesBootstrap:
    case DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList:
      return [];
    case DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesRead:
      return [{ themeId: "quiet-focus", includePreviewBytes: false }];
    case DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesInstall:
      return [archive];
    case DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport:
      return [{ ...archive, themeId: "quiet-focus", expectedRecordRevision: 1 }];
    case DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesDelete:
      return [{ requestId: "delete_01", themeId: "quiet-focus", expectedRecordRevision: 1 }];
    default:
      return [{ themeId: "ling-light" }];
  }
}

function createRepository(calls) {
  return {
    bootstrap: async () => {
      calls.push(["bootstrap"]);
      return success({ repositoryRevision: 1, packages: [], recoveryWarnings: [], activeGuardReady: false });
    },
    list: async () => {
      calls.push(["list"]);
      return success([descriptor]);
    },
    read: async (request) => {
      calls.push(["read", request]);
      return success({ descriptor });
    },
    install: async (request) => {
      calls.push(["install", request]);
      return success(descriptor);
    },
    reimport: async (request) => {
      calls.push(["reimport", request]);
      return success(descriptor);
    },
    delete: async (request) => {
      calls.push(["delete", request]);
      return success({ repositoryRevision: 2 });
    },
    setActive: async (request) => {
      calls.push(["setActive", request]);
      return success({ activeThemeId: request.themeId });
    },
  };
}

function createOwner({ id = 11, url = "file:///safe/web/index.html" } = {}) {
  const state = { senderDestroyed: false, webContentsDestroyed: false, windowDestroyed: false };
  const frame = { url };
  const webContents = {
    id,
    mainFrame: frame,
    getURL: () => url,
    isDestroyed: () => state.senderDestroyed || state.webContentsDestroyed,
  };
  return {
    url,
    state,
    frame,
    webContents,
    event: { sender: webContents, senderFrame: frame },
    window: {
      isDestroyed: () => state.windowDestroyed,
      webContents,
    },
  };
}

function success(value, warnings = []) {
  return { ok: true, value, warnings };
}

function failure(code, retryable = false) {
  return { ok: false, error: { code, retryable } };
}

class FakeIpcMain {
  handlers = new Map();

  handle(channel, handler) {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
    this.handlers.set(channel, handler);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, event, ...args) {
    const handler = this.handlers.get(channel);
    assert.ok(handler, `missing handler for ${channel}`);
    return handler(event, ...args);
  }
}
