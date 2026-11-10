#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import {
  LOCALE_DESCRIPTORS,
  SUPPORTED_LOCALES,
  loadCatalog,
} from "@ling-stack/localization";

import { computeAppBundleTreeSha256 } from "./verify-macos-signed-candidate.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultAppBundle = join(repositoryRoot, "apps/desktop/release/mac-arm64/Ling Stack.app");
const defaultOutputRoot = join(
  repositoryRoot,
  "apps/desktop/test-results/packaged-language-parity",
);
const representativeLocales = new Set([
  "de-DE",
  "es-419",
  "hi-IN",
  "ja-JP",
  "ko-KR",
  "pt-BR",
  "th-TH",
  "zh-TW",
]);
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

if (platform() !== "darwin" || arch() !== "arm64") {
  throw new Error("Packaged language acceptance requires Apple Silicon macOS");
}

const runId = `${timestampSlug()}-${randomUUID().slice(0, 8)}`;
const runRoot = options.output
  ? resolve(options.output)
  : join(defaultOutputRoot, `run-${runId}`);
const appBundle = resolve(options.app);
const appExecutable = join(appBundle, "Contents/MacOS/Ling Stack");
const appAsar = join(appBundle, "Contents/Resources/app.asar");
const userData = join(runRoot, "user-data");
const lingHome = join(runRoot, "ling-home");
const isolatedHome = join(runRoot, "home");
const workspace = join(runRoot, "workspace");
const logs = join(runRoot, "logs");
const screenshots = join(runRoot, "screenshots");
const reportPath = join(runRoot, "report.json");

await Promise.all([
  mkdir(userData, { recursive: true, mode: 0o700 }),
  mkdir(lingHome, { recursive: true, mode: 0o700 }),
  mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
  mkdir(workspace, { recursive: true, mode: 0o700 }),
  mkdir(logs, { recursive: true, mode: 0o700 }),
  mkdir(screenshots, { recursive: true, mode: 0o700 }),
]);

await Promise.all([assertPath(appExecutable), assertPath(appAsar)]);

const sourceCommit = gitValue(["rev-parse", "HEAD"]);
const sourceDirty = gitValue(["status", "--porcelain"]) !== "";
const englishCatalog = await loadCatalog("en-US");
const catalogs = new Map();
for (const locale of SUPPORTED_LOCALES) {
  const catalog = await loadCatalog(locale);
  assert(catalog.locale === locale, `Catalog ${locale} reports ${catalog.locale}`);
  assert(
    catalog.sourceRevision === englishCatalog.sourceRevision,
    `Catalog ${locale} has a different source revision`,
  );
  catalogs.set(locale, catalog);
}

const report = {
  schemaVersion: 1,
  kind: "ling-desktop-packaged-language-parity-ui",
  status: "running",
  startedAt: new Date().toISOString(),
  completedAt: undefined,
  runRoot: relative(repositoryRoot, runRoot),
  source: {
    commit: sourceCommit,
    dirty: sourceDirty,
    releaseCandidateBound: !sourceDirty,
    catalogSourceRevision: englishCatalog.sourceRevision,
    localeCount: SUPPORTED_LOCALES.length,
    messageKeyCount: Object.keys(englishCatalog.messages).length,
  },
  package: {
    appBundle: relative(repositoryRoot, appBundle),
    appAsarSha256: await sha256File(appAsar),
    appBundleTreeSha256: await computeAppBundleTreeSha256(appBundle),
    codesign: verifyCodeSignature(appBundle),
  },
  host: {
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    nodeVersion: process.version,
  },
  launches: [],
  locales: [],
  summary: {},
};

assert(SUPPORTED_LOCALES.length === 55, `Expected 55 locales, found ${SUPPORTED_LOCALES.length}`);
assert(report.package.codesign.verified, report.package.codesign.message);
await persistReport();

let activeSession;
try {
  activeSession = await launchApplication("bootstrap");
  await initializeProfile(activeSession);

  for (const locale of SUPPORTED_LOCALES) {
    const result = {
      locale,
      catalogSha256: sha256Json(catalogs.get(locale)),
      selected: undefined,
      restarted: undefined,
      screenshot: undefined,
      status: "running",
    };
    report.locales.push(result);
    await persistReport();

    const responseLanguageBefore = await currentResponseLanguage(activeSession.page);
    await selectProductLanguage(activeSession, locale);
    const responseLanguageAfterProductChange = await currentResponseLanguage(activeSession.page);
    assert(
      responseLanguageAfterProductChange === responseLanguageBefore,
      `Product locale ${locale} changed response language from ${responseLanguageBefore} to ${responseLanguageAfterProductChange}`,
    );
    await selectResponseLanguage(activeSession, locale);
    result.selected = await verifyLocale(activeSession, locale, {
      phase: "selected",
      responseLanguageBefore,
      responseLanguageAfterProductChange,
    });

    const closed = await closeApplication(activeSession);
    activeSession = undefined;
    assert(closed.graceful, `Packaged app did not close gracefully after selecting ${locale}`);

    activeSession = await launchApplication(`restart-${locale}`);
    result.restarted = await verifyLocale(activeSession, locale, { phase: "restarted" });
    if (representativeLocales.has(locale)) {
      const path = join(screenshots, `${locale}-restart.png`);
      await activeSession.page.screenshot({
        path,
        fullPage: true,
        animations: "disabled",
      });
      result.screenshot = relative(repositoryRoot, path);
    }
    result.status = "passed";
    await persistReport();
    process.stdout.write(`[packaged-language-parity] ${locale} PASS (${report.locales.length}/${SUPPORTED_LOCALES.length})\n`);
  }

  const closed = await closeApplication(activeSession);
  activeSession = undefined;
  assert(closed.graceful, "Packaged app did not close gracefully after final locale verification");

  report.status = "passed";
  report.completedAt = new Date().toISOString();
  report.summary = {
    status: "PASS",
    localesPassed: report.locales.filter((entry) => entry.status === "passed").length,
    localesExpected: SUPPORTED_LOCALES.length,
    launches: report.launches.length,
    screenshots: report.locales.filter((entry) => entry.screenshot).length,
    releaseCandidateBound: !sourceDirty,
  };
  await persistReport();
  process.stdout.write(`${JSON.stringify({ reportPath, summary: report.summary }, null, 2)}\n`);
} catch (error) {
  const runningLocale = report.locales.findLast((entry) => entry.status === "running");
  if (runningLocale) {
    runningLocale.status = "failed";
    runningLocale.error = serializeError(error);
  }
  report.status = "failed";
  report.completedAt = new Date().toISOString();
  report.error = serializeError(error);
  report.summary = {
    status: "FAIL",
    localesPassed: report.locales.filter((entry) => entry.status === "passed").length,
    localesExpected: SUPPORTED_LOCALES.length,
    launches: report.launches.length,
  };
  await persistReport();
  throw error;
} finally {
  if (activeSession) {
    await closeApplication(activeSession, { allowForced: true }).catch(() => undefined);
  }
}

async function initializeProfile(session) {
  await waitForDaemonHealth(session.daemonUrl);
  await updateWorkspaceSettings(session.daemonUrl, {
    locale: "zh-CN",
    responseLanguage: "follow_user",
  });
  await session.page.evaluate(({ workspaceIdentity }) => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
    localStorage.setItem("ling-stack.themeBootstrapPreference", "light");
    localStorage.setItem("ling-first-run:v1", JSON.stringify({
      status: "skipped",
      updatedAt: new Date().toISOString(),
      version: 1,
      workspaceIdentity,
    }));
  }, { workspaceIdentity: workspace });
  await session.page.reload({ waitUntil: "domcontentloaded" });
  await waitForApplicationReady(session.page, "zh-CN");
  await openInterfacePreferences(session.page);
}

async function launchApplication(label) {
  const launchIndex = report.launches.length + 1;
  const cdpPort = await availablePort();
  const daemonPort = await availablePort();
  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  const safeLabel = label.replace(/[^a-z0-9-]+/giu, "-");
  const stdoutPath = join(logs, `${String(launchIndex).padStart(2, "0")}-${safeLabel}.stdout.log`);
  const stderrPath = join(logs, `${String(launchIndex).padStart(2, "0")}-${safeLabel}.stderr.log`);
  const stdoutStream = createWriteStream(stdoutPath, { flags: "w", mode: 0o600 });
  const stderrStream = createWriteStream(stderrPath, { flags: "w", mode: 0o600 });
  const args = [
    `--user-data-dir=${userData}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*",
    "--no-first-run",
  ];
  const child = spawn(appExecutable, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: isolatedHome,
      LING_STACK_HOME: lingHome,
      LING_STACK_DAEMON_URL: daemonUrl,
      LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdoutStream);
  child.stderr.pipe(stderrStream);
  const exit = deferred();
  child.once("error", exit.reject);
  child.once("close", (code, signal) => exit.resolve({ code, signal }));
  const launchRecord = {
    index: launchIndex,
    label,
    pid: child.pid,
    cdpPort,
    daemonPort,
    startedAt: new Date().toISOString(),
    stdoutPath: relative(repositoryRoot, stdoutPath),
    stderrPath: relative(repositoryRoot, stderrPath),
    runtimeErrors: [],
    exit: undefined,
  };
  report.launches.push(launchRecord);
  await persistReport();

  let browser;
  try {
    await Promise.all([
      waitForCdp(cdpPort, child, exit.promise),
      waitForDaemonHealth(daemonUrl),
    ]);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
      timeout: options.launchTimeoutMs,
    });
    const browserCdp = await browser.newBrowserCDPSession();
    const context = browser.contexts()[0];
    assert(context, `No Electron browser context for ${label}`);
    const page = context.pages().find((candidate) => candidate.url().startsWith("file:"))
      ?? context.pages()[0]
      ?? await context.waitForEvent("page", { timeout: options.launchTimeoutMs });
    page.on("pageerror", (runtimeError) => {
      launchRecord.runtimeErrors.push({ type: "pageerror", message: runtimeError.message });
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (isKnownUnrelatedPackagedAssetError(text)) return;
      launchRecord.runtimeErrors.push({ type: "console", message: text });
    });
    await page.waitForLoadState("domcontentloaded", { timeout: options.launchTimeoutMs });
    return {
      browser,
      browserCdp,
      child,
      daemonUrl,
      exit,
      label,
      launchRecord,
      page,
      stderrPath,
      stderrStream,
      stdoutPath,
      stdoutStream,
    };
  } catch (error) {
    browser?.close().catch(() => undefined);
    if (!exit.settled) child.kill("SIGTERM");
    await Promise.race([exit.promise.catch(() => undefined), delay(3_000)]);
    stdoutStream.end();
    stderrStream.end();
    throw new Error(`Unable to launch packaged app for ${label}: ${serializeError(error).message}`);
  }
}

async function closeApplication(session, { allowForced = false } = {}) {
  if (session.exit.settled) {
    session.stdoutStream.end();
    session.stderrStream.end();
    return { graceful: session.exit.value?.code === 0, exit: session.exit.value };
  }
  let forcedSignal;
  try {
    await session.browserCdp.send("Browser.close");
  } catch (error) {
    if (!/closed|disconnected|Target page/u.test(serializeError(error).message)) throw error;
  }
  let exitResult = await Promise.race([
    session.exit.promise,
    delay(options.shutdownTimeoutMs).then(() => undefined),
  ]);
  if (!exitResult) {
    forcedSignal = "SIGTERM";
    session.child.kill("SIGTERM");
    exitResult = await Promise.race([
      session.exit.promise,
      delay(5_000).then(() => undefined),
    ]);
  }
  if (!exitResult) {
    forcedSignal = "SIGKILL";
    session.child.kill("SIGKILL");
    exitResult = await session.exit.promise;
  }
  await Promise.all([
    finishStream(session.stdoutStream),
    finishStream(session.stderrStream),
  ]);
  session.launchRecord.exit = { ...exitResult, forcedSignal };
  const fatalLogEvidence = await scanFatalLogEvidence(session);
  session.launchRecord.fatalLogEvidence = fatalLogEvidence;
  const graceful = !forcedSignal && exitResult?.code === 0;
  if (!allowForced) {
    assert(graceful, `Launch ${session.label} required ${forcedSignal ?? `exit-${exitResult?.code}`}`);
    assert(
      session.launchRecord.runtimeErrors.length === 0,
      `Launch ${session.label} reported renderer errors: ${JSON.stringify(session.launchRecord.runtimeErrors)}`,
    );
    assert(fatalLogEvidence.length === 0, `Launch ${session.label} reported fatal logs: ${fatalLogEvidence.join(" | ")}`);
  }
  await persistReport();
  return { graceful, exit: exitResult, forcedSignal, fatalLogEvidence };
}

async function selectProductLanguage(session, locale) {
  await openInterfacePreferences(session.page);
  const select = session.page.locator("select[data-product-language]");
  await select.selectOption(locale);
  await session.page.waitForFunction(
    (expected) => document.documentElement.lang === expected
      && document.querySelector("select[data-product-language]")?.value === expected
      && !document.querySelector("select[data-product-language]")?.disabled,
    locale,
    { timeout: options.operationTimeoutMs },
  );
  await waitForPersistedSettings(session.daemonUrl, locale, undefined);
}

async function selectResponseLanguage(session, locale) {
  const select = session.page.locator("select[data-response-language]");
  await select.selectOption(locale);
  await session.page.waitForFunction(
    (expected) => document.querySelector("select[data-response-language]")?.value === expected,
    locale,
    { timeout: options.operationTimeoutMs },
  );
  await waitForPersistedSettings(session.daemonUrl, undefined, locale);
}

async function verifyLocale(session, locale, context) {
  await waitForApplicationReady(session.page, locale);
  await openInterfacePreferences(session.page);
  const catalog = catalogs.get(locale);
  assert(catalog, `Catalog ${locale} was not loaded by the harness`);
  const panel = session.page.locator("[data-ui2-interface-preferences]");
  const productLanguage = panel.locator("select[data-product-language]");
  const responseLanguage = panel.locator("select[data-response-language]");

  await expectAttribute(productLanguage, "aria-label", catalog.messages["Product language"]);
  await expectAttribute(responseLanguage, "aria-label", catalog.messages["AI response language"]);
  assert(await productLanguage.inputValue() === locale, `${context.phase} product language is not ${locale}`);
  assert(await responseLanguage.inputValue() === locale, `${context.phase} response language is not ${locale}`);
  assert(
    await panel.locator("#settings-interface-language-title").textContent() === catalog.messages.Language,
    `${context.phase} language heading did not use the ${locale} catalog`,
  );
  const productValues = await productLanguage.locator("option").evaluateAll((options) => options.map((option) => option.value));
  const responseValues = await responseLanguage.locator("option").evaluateAll((options) => options.map((option) => option.value));
  assertEqual(productValues, [...SUPPORTED_LOCALES], `${context.phase} product locale options`);
  assertEqual(responseValues, ["follow_user", ...SUPPORTED_LOCALES], `${context.phase} response locale options`);
  const primarySurface = await verifyPrimarySurface(session.page, locale, catalog);
  await openInterfacePreferences(session.page);

  const domEvidence = await session.page.evaluate(() => ({
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    direction: document.documentElement.dir,
    htmlLang: document.documentElement.lang,
    i18nBootstrapVisible: Boolean(document.querySelector("[data-i18n-bootstrap]")),
    missingMarkerVisible: document.body.innerText.includes("settings.language.load_failed"),
    previewBridgeAvailable: typeof window.lingDesktop?.computerUse?.reportLocale === "function",
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }));
  assert(domEvidence.htmlLang === locale, `${context.phase} html lang is ${domEvidence.htmlLang}, expected ${locale}`);
  assert(
    domEvidence.direction === LOCALE_DESCRIPTORS[locale].direction,
    `${context.phase} html dir is ${domEvidence.direction}, expected ${LOCALE_DESCRIPTORS[locale].direction}`,
  );
  assert(domEvidence.bodyOverflow === 0, `${context.phase} body overflow is ${domEvidence.bodyOverflow}px for ${locale}`);
  assert(domEvidence.documentOverflow === 0, `${context.phase} document overflow is ${domEvidence.documentOverflow}px for ${locale}`);
  assert(!domEvidence.i18nBootstrapVisible, `${context.phase} i18n bootstrap remained visible for ${locale}`);
  assert(!domEvidence.missingMarkerVisible, `${context.phase} missing-key marker appeared for ${locale}`);
  assert(domEvidence.previewBridgeAvailable, `${context.phase} Desktop locale bridge is unavailable for ${locale}`);
  const clippedNavigation = await session.page.locator([
    "[data-settings-shell-navigation] [data-ling-button-slot='label']",
    "[data-settings-shell-navigation] [data-settings-shell-group-label]",
  ].join(",")).evaluateAll((elements) => elements.flatMap((element) => {
    if (!(element instanceof HTMLElement) || element.offsetParent === null) return [];
    return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight
      ? [element.textContent?.trim() ?? ""]
      : [];
  }));
  assert(clippedNavigation.length === 0, `${context.phase} clipped navigation for ${locale}: ${clippedNavigation.join(" | ")}`);
  const persisted = await waitForPersistedSettings(session.daemonUrl, locale, locale);
  assert(
    session.launchRecord.runtimeErrors.length === 0,
    `${context.phase} renderer errors for ${locale}: ${JSON.stringify(session.launchRecord.runtimeErrors)}`,
  );
  return {
    ...context,
    htmlLang: domEvidence.htmlLang,
    direction: domEvidence.direction,
    viewport: domEvidence.viewport,
    persisted: {
      locale: persisted.settings.locale,
      responseLanguage: persisted.settings.responseLanguage,
    },
    optionCounts: {
      productLanguage: productValues.length,
      responseLanguage: responseValues.length,
    },
    primarySurface,
    overflow: {
      body: domEvidence.bodyOverflow,
      document: domEvidence.documentOverflow,
      clippedNavigation,
    },
  };
}

async function verifyPrimarySurface(page, locale, catalog) {
  const returnButton = page.locator("button.settings-app-return-button");
  await returnButton.waitFor({ state: "visible", timeout: options.operationTimeoutMs });
  await returnButton.click();
  const settingsButton = page.locator("button.config-button");
  const conversationButton = page.locator("button.sidebar-command-button-top");
  const channelsHeading = page.locator('[data-sidebar-section="channels"] .sidebar-section-heading');
  await settingsButton.waitFor({ state: "visible", timeout: options.operationTimeoutMs });
  await conversationButton.waitFor({ state: "visible", timeout: options.operationTimeoutMs });
  await channelsHeading.waitFor({ state: "visible", timeout: options.operationTimeoutMs });
  const evidence = {
    settings: await settingsButton.getAttribute("aria-label"),
    newConversation: await conversationButton.getAttribute("aria-label"),
    channels: (await channelsHeading.textContent())?.trim(),
  };
  assert(evidence.settings === catalog.messages.Settings, `${locale} Settings navigation used ${evidence.settings}`);
  assert(
    evidence.newConversation === catalog.messages["New conversation"],
    `${locale} conversation navigation used ${evidence.newConversation}`,
  );
  assert(evidence.channels === catalog.messages.Channels, `${locale} channel navigation used ${evidence.channels}`);
  return evidence;
}

async function waitForApplicationReady(page, locale) {
  await page.waitForFunction(
    (expected) => document.readyState === "complete"
      && document.documentElement.lang === expected
      && !document.querySelector("[data-i18n-bootstrap]")
      && Boolean(document.querySelector("#root")?.childElementCount),
    locale,
    { timeout: options.operationTimeoutMs },
  );
}

async function openInterfacePreferences(page) {
  if (await page.locator("[data-ui2-interface-preferences]").isVisible().catch(() => false)) return;
  await page.locator("button.config-button").click();
  const section = page.locator('[data-settings-section="interface-preferences"]:not([hidden])');
  await section.waitFor({ state: "visible", timeout: options.operationTimeoutMs });
  await section.click();
  await page.locator("[data-ui2-interface-preferences]").waitFor({
    state: "visible",
    timeout: options.operationTimeoutMs,
  });
  await page.locator("select[data-product-language]").waitFor({
    state: "visible",
    timeout: options.operationTimeoutMs,
  });
}

async function currentResponseLanguage(page) {
  return page.locator("select[data-response-language]").inputValue();
}

async function expectAttribute(locator, name, expected) {
  const actual = await locator.getAttribute(name);
  assert(actual === expected, `Expected ${name}=${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

async function waitForPersistedSettings(daemonUrl, locale, responseLanguage) {
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt < options.operationTimeoutMs) {
    latest = await getWorkspaceSettings(daemonUrl).catch(() => undefined);
    const localeMatches = locale === undefined || latest?.settings?.locale === locale;
    const responseMatches = responseLanguage === undefined
      || latest?.settings?.responseLanguage === responseLanguage;
    if (localeMatches && responseMatches) return latest;
    await delay(100);
  }
  throw new Error(
    `Workspace settings did not persist locale=${locale ?? "*"}, responseLanguage=${responseLanguage ?? "*"}; latest=${JSON.stringify(latest)}`,
  );
}

async function getWorkspaceSettings(daemonUrl) {
  const response = await fetch(`${daemonUrl}/workspace-settings?cwd=${encodeURIComponent(workspace)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  });
  const body = await response.json();
  assert(response.ok, `GET workspace settings failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function updateWorkspaceSettings(daemonUrl, patch) {
  const response = await fetch(`${daemonUrl}/workspace-settings?cwd=${encodeURIComponent(workspace)}`, {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  assert(response.ok, `PATCH workspace settings failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForDaemonHealth(daemonUrl) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < options.launchTimeoutMs) {
    try {
      const response = await fetch(`${daemonUrl}/health`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(1_000),
      });
      const body = await response.json();
      if (response.ok && body.ok === true && body.readiness?.state !== "failed") return body;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Daemon health timed out at ${daemonUrl}: ${serializeError(lastError).message}`);
}

async function waitForCdp(port, child, exitPromise) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < options.launchTimeoutMs) {
    const exited = await Promise.race([
      exitPromise.then((value) => ({ exited: true, value })),
      delay(0).then(() => ({ exited: false })),
    ]);
    if (exited.exited) throw new Error(`Packaged app exited before CDP was ready: ${JSON.stringify(exited.value)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Packaged app exited before CDP was ready: ${child.exitCode ?? child.signalCode}`);
    }
    await delay(100);
  }
  throw new Error(`CDP endpoint timed out on ${port}: ${serializeError(lastError).message}`);
}

async function scanFatalLogEvidence(session) {
  const fatalPattern = /Code Signature Invalid|UnhandledPromiseRejection|uncaught exception|segmentation fault|fatal error/iu;
  const [stdout, stderr] = await Promise.all([
    readFile(session.stdoutPath, "utf8").catch(() => ""),
    readFile(session.stderrPath, "utf8").catch(() => ""),
  ]);
  return [...stdout.split(/\r?\n/u), ...stderr.split(/\r?\n/u)]
    .filter((line) => fatalPattern.test(line))
    .slice(0, 20);
}

function isKnownUnrelatedPackagedAssetError(message) {
  return /Failed to load resource: net::ERR_FILE_NOT_FOUND/iu.test(message)
    && /(?:avatars|icons)\//iu.test(message);
}

function verifyCodeSignature(path) {
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { verified: true, message: "codesign --verify --deep --strict passed" };
  } catch (error) {
    return {
      verified: false,
      message: `codesign verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (!port) rejectPort(new Error("Unable to allocate local port"));
        else resolvePort(port);
      });
    });
  });
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const state = { settled: false, value: undefined };
  const promise = new Promise((resolveDeferred, rejectDeferred) => {
    resolvePromise = (value) => {
      state.settled = true;
      state.value = value;
      resolveDeferred(value);
    };
    rejectPromise = (error) => {
      state.settled = true;
      rejectDeferred(error);
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() { return state.settled; },
    get value() { return state.value; },
  };
}

function finishStream(stream) {
  return new Promise((resolveFinished) => {
    if (stream.closed) {
      resolveFinished();
      return;
    }
    stream.once("close", resolveFinished);
    stream.end();
  });
}

async function persistReport() {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function assertPath(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Required packaged artifact is missing: ${path}`);
  }
}

function sha256File(path) {
  return readFile(path).then((value) => createHash("sha256").update(value).digest("hex"));
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function gitValue(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertEqual(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

function parseArguments(args) {
  const parsed = {
    app: defaultAppBundle,
    help: false,
    launchTimeoutMs: 60_000,
    operationTimeoutMs: 30_000,
    output: undefined,
    shutdownTimeoutMs: 20_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inlineValue] = args[index].split("=", 2);
    const nextValue = () => inlineValue ?? args[++index];
    if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (flag === "--app") parsed.app = resolve(requiredValue(flag, nextValue()));
    else if (flag === "--output") parsed.output = resolve(requiredValue(flag, nextValue()));
    else if (flag === "--launch-timeout-ms") parsed.launchTimeoutMs = positiveInteger(flag, nextValue());
    else if (flag === "--operation-timeout-ms") parsed.operationTimeoutMs = positiveInteger(flag, nextValue());
    else if (flag === "--shutdown-timeout-ms") parsed.shutdownTimeoutMs = positiveInteger(flag, nextValue());
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  return parsed;
}

function helpText() {
  return `Ling Stack packaged macOS language parity acceptance\n\nUsage:\n  node apps/desktop/tests/run-packaged-language-parity.mjs [options]\n\nOptions:\n  --app <Ling Stack.app>\n  --output <run directory>\n  --launch-timeout-ms <number>\n  --operation-timeout-ms <number>\n  --shutdown-timeout-ms <number>\n  --help\n\nThe harness always uses isolated HOME, userData, Ling home, workspace, daemon ports, and browser profile.\nIt derives the complete acceptance matrix from SUPPORTED_LOCALES and restarts the packaged app after every locale.\n`;
}

function requiredValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(flag, value) {
  const parsed = Number(requiredValue(flag, value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
