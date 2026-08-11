import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMainWindowOptions,
  createMainWindow,
} from "../dist/main/window-factory.js";
import {
  parseDesktopThemePackageFirstPaintArgument,
} from "../dist/shared/theme-package-first-paint.js";

const daemonBaseUrl = "http://127.0.0.1:17891";
const themePackageFirstPaint = Object.freeze({
  repositoryRevision: 7,
  authorityComplete: true,
  readyThemes: Object.freeze([
    Object.freeze({ themeId: "calm-focus", packageChecksumSha256: "a".repeat(64) }),
    Object.freeze({ themeId: "quiet-code", packageChecksumSha256: "b".repeat(64) }),
  ]),
});

test("main window options freeze the shared geometry and platform chrome contract", () => {
  const macOptions = buildMainWindowOptions({ daemonBaseUrl, themePackageFirstPaint }, "darwin");
  const windowsOptions = buildMainWindowOptions({ daemonBaseUrl, themePackageFirstPaint }, "win32");
  const commonOptions = {
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#111315",
    show: false,
    webPreferences: {
      preload: macOptions.webPreferences?.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--ling-daemon-base-url=${daemonBaseUrl}`,
        macOptions.webPreferences?.additionalArguments?.[1],
      ],
    },
  };

  assert.match(commonOptions.webPreferences.preload ?? "", /main-window\.cjs$/u);
  assert.deepEqual(
    parseDesktopThemePackageFirstPaintArgument(macOptions.webPreferences?.additionalArguments ?? []),
    themePackageFirstPaint,
  );
  assert.deepEqual(macOptions, { ...commonOptions, titleBarStyle: "hiddenInset" });
  assert.deepEqual(windowsOptions, { ...commonOptions, titleBarStyle: "default" });
  assert.equal(
    buildMainWindowOptions({ backgroundColor: "#f6f7f8", daemonBaseUrl, themePackageFirstPaint }, "win32").backgroundColor,
    "#f6f7f8",
  );
});

test("main window forwards Computer Control authority only when the packaged runtime supplies it", () => {
  const macOptions = buildMainWindowOptions({
    daemonBaseUrl,
    themePackageFirstPaint,
    computerControlPlatform: "macos",
  }, "darwin");
  const windowsOptions = buildMainWindowOptions({
    daemonBaseUrl,
    themePackageFirstPaint,
    computerControlPlatform: "windows",
  }, "win32");

  assert.equal(
    macOptions.webPreferences?.additionalArguments?.at(-1),
    "--ling-computer-control-platform=macos",
  );
  assert.equal(
    windowsOptions.webPreferences?.additionalArguments?.at(-1),
    "--ling-computer-control-platform=windows",
  );
  assert.equal(
    buildMainWindowOptions({ daemonBaseUrl, themePackageFirstPaint }, "darwin")
      .webPreferences?.additionalArguments?.some((argument) =>
        argument.startsWith("--ling-computer-control-platform=")),
    false,
  );
});

test("main window stays hidden until ready and denies all renderer navigation", async () => {
  const harness = createWindowHarness();
  const created = [];

  const window = await createMainWindow({
    daemonBaseUrl,
    themePackageFirstPaint,
    webIndexPath: "/safe/web/index.html",
    createWindow: harness.createWindow,
    openExternal: harness.openExternal,
    onWindowCreated: (createdWindow) => created.push(createdWindow),
  });

  assert.equal(window, harness.window);
  assert.deepEqual(created, [harness.window]);
  assert.equal(harness.capturedOptions.width, 1440);
  assert.equal(harness.capturedOptions.height, 920);
  assert.equal(harness.capturedOptions.show, false);
  assert.deepEqual(harness.loadedFiles, ["/safe/web/index.html"]);
  assert.equal(harness.showCount, 0);
  assert.equal(typeof harness.windowEvents.get("ready-to-show"), "function");

  harness.windowEvents.get("ready-to-show")();
  assert.equal(harness.showCount, 1);

  let navigationPrevented = false;
  harness.webContentsEvents.get("will-navigate")({
    preventDefault: () => {
      navigationPrevented = true;
    },
  });
  assert.equal(navigationPrevented, true);
});

test("main window removes the default application menu only on Windows", async () => {
  const windowsHarness = createWindowHarness();
  await createMainWindow({
    daemonBaseUrl,
    themePackageFirstPaint,
    platform: "win32",
    webIndexPath: "/safe/web/index.html",
    createWindow: windowsHarness.createWindow,
    openExternal: windowsHarness.openExternal,
  });

  assert.equal(windowsHarness.removeMenuCount, 1);
  assert.equal(windowsHarness.capturedOptions.titleBarStyle, "default");

  const macHarness = createWindowHarness();
  await createMainWindow({
    daemonBaseUrl,
    themePackageFirstPaint,
    platform: "darwin",
    webIndexPath: "/safe/web/index.html",
    createWindow: macHarness.createWindow,
    openExternal: macHarness.openExternal,
  });

  assert.equal(macHarness.removeMenuCount, 0);
  assert.equal(macHarness.capturedOptions.titleBarStyle, "hiddenInset");
});

test("main window denies every popup and opens only HTTP(S) URLs externally", async () => {
  const harness = createWindowHarness();

  await createMainWindow({
    daemonBaseUrl,
    themePackageFirstPaint,
    webIndexPath: "/safe/web/index.html",
    createWindow: harness.createWindow,
    openExternal: harness.openExternal,
  });

  const open = harness.windowOpenHandler;
  assert.equal(typeof open, "function");

  for (const url of ["https://ling.example/docs", "http://127.0.0.1:17891/health"]) {
    assert.deepEqual(open({ url }), { action: "deny" });
  }
  for (const url of [
    "file:///tmp/private.txt",
    "javascript:alert(1)",
    "data:text/plain,hello",
    "mailto:hello@example.com",
    "ling://settings",
  ]) {
    assert.deepEqual(open({ url }), { action: "deny" });
  }

  assert.deepEqual(harness.externalUrls, [
    "https://ling.example/docs",
    "http://127.0.0.1:17891/health",
  ]);
});

test("headless main window keeps the ready-to-show listener disabled", async () => {
  const harness = createWindowHarness();

  await createMainWindow({
    daemonBaseUrl,
    themePackageFirstPaint,
    webIndexPath: "/safe/web/index.html",
    createWindow: harness.createWindow,
    openExternal: harness.openExternal,
    showWhenReady: false,
  });

  assert.equal(harness.windowEvents.has("ready-to-show"), false);
  assert.equal(harness.showCount, 0);
});

function createWindowHarness() {
  const externalUrls = [];
  const loadedFiles = [];
  const webContentsEvents = new Map();
  const windowEvents = new Map();
  let capturedOptions;
  let removeMenuCount = 0;
  let showCount = 0;
  let windowOpenHandler;

  const window = {
    loadFile: async (path) => {
      loadedFiles.push(path);
    },
    once: (event, listener) => {
      windowEvents.set(event, listener);
    },
    removeMenu: () => {
      removeMenuCount += 1;
    },
    show: () => {
      showCount += 1;
    },
    webContents: {
      on: (event, listener) => {
        webContentsEvents.set(event, listener);
      },
      setWindowOpenHandler: (handler) => {
        windowOpenHandler = handler;
      },
    },
  };

  return {
    createWindow: (options) => {
      capturedOptions = options;
      return window;
    },
    externalUrls,
    get capturedOptions() {
      return capturedOptions;
    },
    loadedFiles,
    openExternal: (url) => {
      externalUrls.push(url);
    },
    get showCount() {
      return showCount;
    },
    get removeMenuCount() {
      return removeMenuCount;
    },
    webContentsEvents,
    window,
    windowEvents,
    get windowOpenHandler() {
      return windowOpenHandler;
    },
  };
}
