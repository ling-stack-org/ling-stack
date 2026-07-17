import { app, BrowserWindow, nativeImage, nativeTheme } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    await mkdir(baselineDirectory, { recursive: true });
    const manifest = [];
    for (const theme of computerUseScreenshotThemes) {
      nativeTheme.themeSource = theme;
      await delay(50);
      for (const screenshotCase of computerUseScreenshotCases) {
        const image = await captureScreenshot({ ...screenshotCase, theme });
        const filename = `${screenshotCase.id}-${theme}.png`;
        const baselinePath = join(baselineDirectory, filename);
        const png = image.toPNG();
        if (update) {
          await writeFile(baselinePath, png);
        } else {
          const baseline = nativeImage.createFromBuffer(await readFile(baselinePath));
          assertSameImageSize(filename, baseline, image);
          const comparison = compareImages(baseline, image);
          if (comparison.changedPixelRatio > 0.005) {
            throw new Error(
              `${filename} changed ${(comparison.changedPixelRatio * 100).toFixed(3)}% ` +
              `(allowed 0.5%, maximum channel delta ${comparison.maximumChannelDelta})`,
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
    nativeTheme.themeSource = "system";
    app.quit();
  }
}

async function captureScreenshot({ width, height, scenario = "live" }) {
  const reducedMotion = scenario === "reduced-motion";
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
      sandbox: true,
      ...(scenario === "stop-failed" ? { preload: rendererHarnessPreloadPath } : {}),
    },
  });
  let debuggerAttached = false;
  try {
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
      features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }],
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
    const reducedMotionMatches = await window.webContents.executeJavaScript(
      "window.matchMedia('(prefers-reduced-motion: reduce)').matches",
    );
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

function assertSameImageSize(filename, expected, actual) {
  const expectedSize = expected.getSize();
  const actualSize = actual.getSize();
  if (expectedSize.width !== actualSize.width || expectedSize.height !== actualSize.height) {
    throw new Error(
      `${filename} dimensions differ: baseline ${expectedSize.width}x${expectedSize.height}, ` +
      `capture ${actualSize.width}x${actualSize.height}`,
    );
  }
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
