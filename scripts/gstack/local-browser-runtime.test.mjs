import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { materializeLocalBrowser, materializeLocalFfmpeg } from "./materialize-local-browser.mjs";

const stage = process.env.LING_GSTACK_RESOURCE_STAGE;
test("separately verified browser preserves signature and launches with sandbox, interaction, screenshot and packaged FFmpeg video", {
  skip: !stage && "requires retained inputs and managed execution", timeout: 120000,
}, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling-browser-admission-")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const runtimeRoot = join(stage, "runtime"), managedRoot = process.env.LING_GSTACK_RESOURCE_ROOT;
  const selection = await materializeLocalBrowser({ runtimeRoot, managedRoot,
    inspectionRoot: join(repo, ".ling-stack/build/gstack-ungoogled-inspection-darwin-arm64-v1"), outputRoot: join(work, "gstack-browser") });
  const ffmpeg = await materializeLocalFfmpeg({ runtimeRoot, managedRoot,
    archiveRoot: join(repo, ".ling-stack/build/gstack-browser-archives-darwin-arm64-v2"), cacheRoot: join(work, "browser-cache") });
  const require = createRequire(join(runtimeRoot, "package.json"));
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(work, "browser-cache");
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: join(work, "gstack-browser", selection.appEntry), headless: true,
    chromiumSandbox: true, env: { HOME: join(work, "home"), TMPDIR: tmpdir(), PATH: "/usr/bin:/bin" } });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, recordVideo: { dir: join(work, "videos") } });
  let externalRequests = 0;
  await context.route("**/*", route => { externalRequests++; return route.abort("internetdisconnected"); });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<!doctype html><title>Ling bundled browser</title><body style="background:white;color:black"><h1>Bundled gs browser</h1><button onclick="this.textContent=\'Verified\'">Run check</button></body>');
  await page.getByRole("button", { name: "Run check" }).click();
  assert.equal(await page.getByRole("button").textContent(), "Verified");
  const screenshot = await page.screenshot();
  assert.ok(screenshot.length > 5000);
  const video = page.video();
  await context.close();
  assert.ok((await readFile(await video.path())).length > 1000);
  assert.deepEqual(errors, []);
  assert.equal(externalRequests, 0);
  const codeSignature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(work, "gstack-browser/Chromium.app")],
    { encoding: "utf8", timeout: 15000 });
  await copyFile(await video.path(), join(managedRoot, "artifacts/report/bundled-browser-local.webm"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(managedRoot, "artifacts/report/bundled-browser-local.png"), screenshot);
  t.diagnostic(JSON.stringify({ selection, ffmpeg, interaction: true, screenshotBytes: screenshot.length,
    video: true, externalRequests, pageErrors: errors.length, originalSignatureValid: codeSignature.status === 0,
    signatureDiagnostic: codeSignature.stderr.trim(), scope: "standalone-component-not-gs-server-or-desktop" }));
});
