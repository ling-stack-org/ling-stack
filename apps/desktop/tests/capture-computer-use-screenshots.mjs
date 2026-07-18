import { app, BrowserWindow, nativeImage } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease, version as osVersion } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computerUseScreenshotCases,
  computerUseScreenshotThemes,
} from "./computer-use-screenshot-cases.mjs";

const update = process.argv.includes("--update");
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const previewIndexPath = join(desktopRoot, "dist", "renderer", "computer-use-preview", "index.html");
const rendererHarnessPreloadPath = join(
  desktopRoot,
  "tests",
  "computer-use-preview-renderer-harness",
  "preload.cjs",
);
const platformKey = `${process.platform}-${process.arch}`;
const baselineDirectory = join(desktopRoot, "tests", "screenshots", "computer-use-preview", platformKey);
const diagnosticDirectory = join(
  desktopRoot,
  "test-results",
  "computer-use-screenshot-baselines",
  platformKey,
);

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setName("Ling Computer Use Screenshot Harness");
app.on("window-all-closed", () => {
  // The harness creates one short-lived BrowserWindow per baseline. Keep the
  // Electron main process alive until the full matrix has been captured.
});

void app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});

async function run() {
  try {
    await rm(diagnosticDirectory, { recursive: true, force: true });
    await mkdir(baselineDirectory, { recursive: true });
    const manifest = [];
    for (const theme of computerUseScreenshotThemes) {
      for (const screenshotCase of computerUseScreenshotCases) {
        const image = await captureScreenshot({ ...screenshotCase, theme });
        const filename = `${screenshotCase.id}-${theme}.png`;
        const baselinePath = join(baselineDirectory, filename);
        const png = image.toPNG();
        if (update) {
          await writeFile(baselinePath, png);
        } else {
          const baselinePng = await readFile(baselinePath);
          const baseline = nativeImage.createFromBuffer(baselinePng);
          const expectedSize = baseline.getSize();
          const actualSize = image.getSize();
          if (expectedSize.width !== actualSize.width || expectedSize.height !== actualSize.height) {
            await writeMismatchDiagnostics({
              actualPng: png,
              baselinePng,
              comparison: {
                changedPixelRatio: 1,
                maximumChannelDelta: 255,
                expectedSize,
                actualSize,
              },
              filename,
              theme,
            });
            throw new Error(
              `${filename} dimensions differ: baseline ${expectedSize.width}x${expectedSize.height}, ` +
              `capture ${actualSize.width}x${actualSize.height}; diagnostics: ${diagnosticDirectory}`,
            );
          }
          const comparison = compareImages(baseline, image);
          if (comparison.changedPixelRatio > 0.005) {
            await writeMismatchDiagnostics({
              actualPng: png,
              baselinePng,
              comparison,
              filename,
              theme,
            });
            throw new Error(
              `${filename} changed ${(comparison.changedPixelRatio * 100).toFixed(3)}% ` +
              `(allowed 0.5%, maximum channel delta ${comparison.maximumChannelDelta}); ` +
              `diagnostics: ${diagnosticDirectory}`,
            );
          }
        }
        manifest.push({
          filename,
          theme,
          width: screenshotCase.width,
          height: screenshotCase.height,
          reducedMotion: screenshotCase.scenario === "reduced-motion",
          sha256: createHash("sha256").update(png).digest("hex"),
        });
      }
    }
    if (update) {
      await writeFile(
        join(baselineDirectory, "manifest.json"),
        `${JSON.stringify({ platform: process.platform, arch: process.arch, cases: manifest }, null, 2)}\n`,
        "utf8",
      );
      process.stdout.write(`Updated ${manifest.length} Computer Use screenshot baselines in ${baselineDirectory}\n`);
    } else {
      process.stdout.write(`Verified ${manifest.length} Computer Use screenshot baselines for ${platformKey}\n`);
    }
  } finally {
    app.quit();
  }
}

async function writeMismatchDiagnostics({ actualPng, baselinePng, comparison, filename, theme }) {
  await mkdir(diagnosticDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(diagnosticDirectory, `actual-${filename}`), actualPng),
    writeFile(join(diagnosticDirectory, `expected-${filename}`), baselinePng),
    writeFile(
      join(diagnosticDirectory, "environment.json"),
      `${JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        osRelease: osRelease(),
        osVersion: osVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        filename,
        theme,
        comparison,
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);
}

async function captureScreenshot({ width, height, scenario = "live", theme }) {
  const reducedMotion = scenario === "reduced-motion";
  const usesRendererHarness = scenario === "stop-failed" || scenario.startsWith("deck-");
  const window = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: {
        deviceScaleFactor: 1,
        useSharedTexture: false,
      },
      sandbox: true,
      ...(usesRendererHarness ? { preload: rendererHarnessPreloadPath } : {}),
    },
  });
  let debuggerAttached = false;
  try {
    if (!window.webContents.isOffscreen()) {
      throw new Error("computer_use_screenshot_offscreen_surface_not_enabled");
    }
    await window.loadFile(previewIndexPath);
    window.webContents.debugger.attach("1.3");
    debuggerAttached = true;
    await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: theme },
        { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
      ],
    });
    if (scenario === "stop-failed") {
      await window.webContents.executeJavaScript(`
        window.lingPreviewTestHarness.setCommandResult("requestStop", {
          accepted: false,
          reason: "private reason must not be rendered",
        });
        document.querySelector(".more-button")?.click();
        document.querySelector('[data-action-id="stop"]')?.click();
        new Promise((resolve, reject) => {
          const startedAt = performance.now();
          const poll = () => {
            if (document.querySelector('.preview-shell')?.getAttribute('data-stop-command') === 'failed') {
              resolve(true);
            } else if (performance.now() - startedAt > 2_000) {
              reject(new Error('stop_failed_screenshot_state_timeout'));
            } else {
              setTimeout(poll, 10);
            }
          };
          poll();
        });
      `);
    }
    if (scenario.startsWith("deck-")) {
      await configureDeckScreenshot(window, scenario);
    }
    const mediaMatches = await window.webContents.executeJavaScript(`({
      dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    })`);
    const expectedDark = theme === "dark";
    if (mediaMatches.dark !== expectedDark) {
      throw new Error(`color_scheme_media_query_mismatch:${theme}:${String(mediaMatches.dark)}`);
    }
    const reducedMotionMatches = mediaMatches.reducedMotion;
    if (reducedMotion !== reducedMotionMatches) {
      throw new Error(`reduced_motion_media_query_mismatch:${String(reducedMotionMatches)}`);
    }
    await window.webContents.insertCSS(reducedMotion
      ? `*, *::before, *::after { caret-color: transparent !important; }`
      : `
        *, *::before, *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
      `);
    const loadedInterFaces = await window.webContents.executeJavaScript(
      `document.fonts.load('12px "Inter Variable"', 'Example Browser').then((faces) => faces.length)`,
    );
    if (loadedInterFaces < 1) {
      throw new Error("computer_use_screenshot_font_not_loaded:Inter Variable");
    }
    await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    await delay(50);
    const contentBounds = window.getContentBounds();
    if (contentBounds.width !== width || contentBounds.height !== height) {
      throw new Error(
        `Screenshot window content size ${contentBounds.width}x${contentBounds.height} ` +
        `does not match requested logical size ${width}x${height}`,
      );
    }
    const rendererMetrics = await window.webContents.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })",
    );
    if (
      rendererMetrics.width !== width ||
      rendererMetrics.height !== height ||
      rendererMetrics.devicePixelRatio !== 1
    ) {
      throw new Error(
        `Screenshot renderer metrics ${rendererMetrics.width}x${rendererMetrics.height} ` +
        `at ${rendererMetrics.devicePixelRatio}x do not match ${width}x${height} at 1x`,
      );
    }
    const screenshot = await window.webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const image = nativeImage.createFromBuffer(Buffer.from(screenshot.data, "base64"));
    const imageSize = image.getSize();
    if (imageSize.width !== width || imageSize.height !== height) {
      throw new Error(
        `Canonical screenshot size ${imageSize.width}x${imageSize.height} ` +
        `does not match requested logical size ${width}x${height}`,
      );
    }
    return image;
  } finally {
    if (debuggerAttached && !window.isDestroyed()) {
      window.webContents.debugger.detach();
    }
    window.destroy();
  }
}

const deckScreenshotPages = Object.freeze([
  Object.freeze({ pageId: "deck-page-api", targetLabel: "API Console", runtimeStatus: "running" }),
  Object.freeze({ pageId: "deck-page-docs", targetLabel: "Docs Portal", runtimeStatus: "running" }),
  Object.freeze({ pageId: "deck-page-billing", targetLabel: "Billing", runtimeStatus: "waiting_for_approval" }),
  Object.freeze({ pageId: "deck-page-analytics", targetLabel: "Analytics", runtimeStatus: "running" }),
  Object.freeze({ pageId: "deck-page-workspace", targetLabel: "Workspace", runtimeStatus: "paused" }),
  Object.freeze({ pageId: "deck-page-pdf", targetLabel: "Product brief.pdf", runtimeStatus: "succeeded" }),
]);

async function configureDeckScreenshot(window, scenario) {
  const residentCount = scenario === "deck-tabs" ? 3 : scenario === "deck-view-all" ? 5 : 4;
  const availableCount = scenario === "deck-view-all" ? 6 : residentCount;
  const residentPages = deckScreenshotPages.slice(0, residentCount);
  const availablePages = deckScreenshotPages.slice(0, availableCount);
  const sequence = [];
  let sourceGeneration = 10;

  const snapshotFor = (activePageId, requestedPageId) => {
    const activePage = residentPages.find((page) => page.pageId === activePageId);
    const orderedPages = [
      activePage,
      ...residentPages.filter((page) => page.pageId !== activePageId),
    ].filter(Boolean);
    return {
      sessionId: activePage.pageId,
      conversationId: `conversation-${activePage.pageId}`,
      targetLabel: activePage.targetLabel,
      runtimeStatus: activePage.runtimeStatus,
      sourceStatus: "live",
      sourceKind: "fake",
      sourceRevision: 1,
      sourceGeneration: sourceGeneration++,
      visibilityIntent: "auto",
      frameReady: true,
      aspectRatio: 1.6,
      canStop: true,
      canOpenSettings: false,
      deck: {
        activePageId,
        ...(requestedPageId ? { requestedPageId } : {}),
        availablePageCount: availablePages.length,
        pages: orderedPages.map((page) => ({
          ...page,
          presentationState: page.pageId === activePageId
            ? "active"
            : page.pageId === requestedPageId
              ? "activating"
              : "inactive",
        })),
        availablePages: availablePages.map((page) => ({
          ...page,
          resident: residentPages.some((resident) => resident.pageId === page.pageId),
        })),
      },
    };
  };

  let activePageId = residentPages.at(-1).pageId;
  sequence.push(snapshotFor(activePageId));
  for (let index = residentPages.length - 2; index >= 0; index -= 1) {
    const requestedPageId = residentPages[index].pageId;
    sequence.push(snapshotFor(activePageId, requestedPageId));
    activePageId = requestedPageId;
    sequence.push(snapshotFor(activePageId));
  }

  await window.webContents.executeJavaScript(`(() => {
    const sequence = ${JSON.stringify(sequence)};
    for (const next of sequence) {
      window.lingPreviewTestHarness.pushSnapshot(next);
    }
  })()`);
  if (scenario === "deck-view-all") {
    await window.webContents.executeJavaScript(`document.querySelector('.page-deck-view-all')?.click()`);
  }
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const expectedThumbnails = ${Math.max(0, residentCount - 1)};
    const startedAt = performance.now();
    const poll = () => {
      const shell = document.querySelector('.preview-shell');
      const viewAllReady = ${JSON.stringify(scenario !== "deck-view-all")} || Boolean(document.querySelector('.page-deck-view-all-panel'));
      if (
        shell?.getAttribute('data-page-deck') === 'visible'
        && Number(shell.getAttribute('data-page-thumbnail-count')) === expectedThumbnails
        && viewAllReady
      ) {
        resolve(true);
      } else if (performance.now() - startedAt > 2_000) {
        reject(new Error('deck_screenshot_state_timeout'));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  })`);
}

function compareImages(expected, actual) {
  const expectedSize = expected.getSize();
  const left = expected.toBitmap();
  const right = actual.toBitmap();
  let changedPixels = 0;
  let maximumChannelDelta = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left[offset + channel] - right[offset + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta > 8) {
        pixelChanged = true;
      }
    }
    if (pixelChanged) {
      changedPixels += 1;
    }
  }
  return {
    changedPixelRatio: changedPixels / Math.max(1, expectedSize.width * expectedSize.height),
    maximumChannelDelta,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
