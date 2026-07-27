import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const UI2_WEB_RELEASE_CAPTURE_COMMAND =
  "LING_CAPTURE_UI2_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4260 corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-web-release-gate.spec.ts --workers=1";
export const UI2_WEB_RELEASE_SERVED_ARTIFACT = "Vite source via Playwright webServer";
export const UI2_WEB_RELEASE_EXPECTED_SCENARIO_IDS = [
  "web-release-shell",
  "web-release-channel",
  "web-release-normal-conversation",
  "web-release-teammate-chat",
  "web-release-settings-imported-theme",
  "web-release-model-workbench",
  "web-release-plugin-manager",
  "web-release-automations",
  "web-release-media-jobs",
  "web-release-work-board",
  "web-release-runs",
  "web-release-approvals",
] as const;

export type Ui2ReleaseScenarioId = typeof UI2_WEB_RELEASE_EXPECTED_SCENARIO_IDS[number];
export type Ui2ReleaseTheme = "ling-light" | "ling-dark" | `imported:${string}`;
export type Ui2ReleaseLocale = "en-US" | "zh-CN";
export type Ui2ReleaseMotion = "no-preference" | "reduce";

export interface Ui2ReleaseScenarioDefinition {
  readonly stableId: Ui2ReleaseScenarioId;
  readonly label: string;
  readonly functionIds: readonly string[];
  readonly fixture: string;
  readonly trigger: {
    readonly summary: string;
    readonly steps: readonly string[];
  };
  readonly viewport: {
    readonly width: 1280 | 1440;
    readonly height: 800 | 960;
  };
  readonly theme: Ui2ReleaseTheme;
  readonly locale: Ui2ReleaseLocale;
  readonly keyboard: {
    readonly exercised: true;
    readonly checks: readonly string[];
  };
  readonly reducedMotion: Ui2ReleaseMotion;
}

export interface Ui2ReleaseRuntimeMonitor {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

interface Ui2ReleaseScenarioRecord {
  readonly status: "captured";
  readonly stableId: Ui2ReleaseScenarioId;
  readonly label: string;
  readonly functionIds: readonly string[];
  readonly fixture: string;
  readonly trigger: Ui2ReleaseScenarioDefinition["trigger"];
  readonly url: string;
  readonly viewport: Ui2ReleaseScenarioDefinition["viewport"];
  readonly theme: Ui2ReleaseTheme;
  readonly locale: Ui2ReleaseLocale;
  readonly keyboard: Ui2ReleaseScenarioDefinition["keyboard"];
  readonly reducedMotion: Ui2ReleaseMotion;
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly overflow: readonly string[];
  readonly png: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
  };
  readonly sidecarFile: string;
  readonly servedArtifact: string;
  readonly captureCommand: string;
  readonly source: Ui2ReleaseSourceIdentity;
  readonly capturedAt: string;
}

interface Ui2ReleaseSourceIdentity {
  readonly commit: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly worktreeStatusSha256: string;
  readonly identifier: string;
}

interface Ui2ReleaseManifest {
  readonly schemaVersion: 1;
  readonly release: string;
  readonly status: "pending" | "partial" | "captured";
  readonly expectedScenarioIds: readonly Ui2ReleaseScenarioId[];
  readonly servedArtifact: string;
  readonly captureCommand: string;
  readonly generatedAt: string | null;
  readonly source: Ui2ReleaseSourceIdentity | null;
  readonly scenarios: readonly Ui2ReleaseScenarioRecord[];
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const releaseDirectory = path.join(repositoryRoot, "docs/design/ui2.0升级/evidence/release/web");
const manifestPath = path.join(releaseDirectory, "manifest.json");
let releaseSourceIdentity: Ui2ReleaseSourceIdentity | undefined;

export function isUi2ReleaseCaptureEnabled(): boolean {
  return process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
}

export function watchUi2ReleaseRuntime(page: Page): Ui2ReleaseRuntimeMonitor {
  const monitor: Ui2ReleaseRuntimeMonitor = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") monitor.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => monitor.pageErrors.push(error.message));
  return monitor;
}

export async function prepareUi2ReleaseSurface(
  page: Page,
  scenario: Ui2ReleaseScenarioDefinition,
): Promise<void> {
  await page.setViewportSize(scenario.viewport);
  const colorScheme = scenario.theme === "ling-dark" ? "dark" : "light";
  await page.emulateMedia({ colorScheme, reducedMotion: scenario.reducedMotion });
  await page.addInitScript(({ locale, theme }) => {
    const resolvedTheme = theme.startsWith("imported:") ? "ling-light" : theme;
    const fixtureOverride = sessionStorage.getItem("ling-stack.e2eThemeSelection");
    const selection = fixtureOverride
      ? JSON.parse(fixtureOverride)
      : { mode: "fixed", themeId: resolvedTheme };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    const selectedThemeId = typeof selection.themeId === "string" ? selection.themeId : resolvedTheme;
    localStorage.setItem("ling-stack.themePreference", selectedThemeId === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", selectedThemeId === "ling-dark" ? "dark" : "light");
  }, { locale: scenario.locale, theme: scenario.theme });
}

export async function captureUi2ReleaseScenario(input: {
  readonly page: Page;
  readonly scenario: Ui2ReleaseScenarioDefinition;
  readonly runtime: Ui2ReleaseRuntimeMonitor;
}): Promise<{ readonly captured: boolean }> {
  if (!isUi2ReleaseCaptureEnabled()) return { captured: false };

  const overflow = await collectHorizontalOverflow(input.page);
  if (input.runtime.consoleErrors.length > 0 || input.runtime.pageErrors.length > 0 || overflow.length > 0) {
    throw new Error([
      `Release evidence for ${input.scenario.stableId} is not clean.`,
      ...input.runtime.consoleErrors.map((message) => `console: ${message}`),
      ...input.runtime.pageErrors.map((message) => `page: ${message}`),
      ...overflow.map((message) => `overflow: ${message}`),
    ].join("\n"));
  }

  const source = readReleaseSourceIdentity();
  await mkdir(releaseDirectory, { recursive: true });
  const pngFile = `${input.scenario.stableId}.png`;
  const sidecarFile = `${input.scenario.stableId}.json`;
  const pngPath = path.join(releaseDirectory, pngFile);
  await input.page.screenshot({ animations: "disabled", fullPage: false, path: pngPath });
  const pngBytes = await readFile(pngPath);
  const dimensions = readPngDimensions(pngBytes);
  const record: Ui2ReleaseScenarioRecord = {
    status: "captured",
    stableId: input.scenario.stableId,
    label: input.scenario.label,
    functionIds: [...input.scenario.functionIds],
    fixture: input.scenario.fixture,
    trigger: {
      summary: input.scenario.trigger.summary,
      steps: [...input.scenario.trigger.steps],
    },
    url: input.page.url(),
    viewport: input.scenario.viewport,
    theme: input.scenario.theme,
    locale: input.scenario.locale,
    keyboard: {
      exercised: true,
      checks: [...input.scenario.keyboard.checks],
    },
    reducedMotion: input.scenario.reducedMotion,
    consoleErrors: [],
    pageErrors: [],
    overflow: [],
    png: {
      file: pngFile,
      width: dimensions.width,
      height: dimensions.height,
      sha256: createHash("sha256").update(pngBytes).digest("hex"),
    },
    sidecarFile,
    servedArtifact: UI2_WEB_RELEASE_SERVED_ARTIFACT,
    captureCommand: UI2_WEB_RELEASE_CAPTURE_COMMAND,
    source,
    capturedAt: new Date().toISOString(),
  };

  await writeJsonAtomically(path.join(releaseDirectory, sidecarFile), record);
  const current = await readManifest();
  const scenarios = [...current.scenarios.filter((item) => item.stableId !== record.stableId), record]
    .sort((left, right) => UI2_WEB_RELEASE_EXPECTED_SCENARIO_IDS.indexOf(left.stableId) - UI2_WEB_RELEASE_EXPECTED_SCENARIO_IDS.indexOf(right.stableId));
  const manifest: Ui2ReleaseManifest = {
    ...current,
    status: scenarios.length === UI2_WEB_RELEASE_EXPECTED_SCENARIO_IDS.length ? "captured" : "partial",
    generatedAt: new Date().toISOString(),
    source,
    scenarios,
  };
  await writeJsonAtomically(manifestPath, manifest);
  return { captured: true };
}

async function collectHorizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const failures: string[] = [];
    const documentOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bodyOverflow = document.body.scrollWidth - document.body.clientWidth;
    if (documentOverflow > 1) failures.push(`document:+${Math.ceil(documentOverflow)}px`);
    if (bodyOverflow > 1) failures.push(`body:+${Math.ceil(bodyOverflow)}px`);
    return failures;
  });
}

function readPngDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Captured release artifact is not a valid PNG with an IHDR chunk.");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readSourceIdentity(): Ui2ReleaseSourceIdentity {
  const commit = runGit(["rev-parse", "HEAD"]);
  const branch = runGit(["branch", "--show-current"]) || "detached";
  const worktreeStatus = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  const worktreeStatusSha256 = createHash("sha256").update(worktreeStatus).digest("hex");
  const dirty = worktreeStatus.length > 0;
  return {
    commit,
    branch,
    dirty,
    worktreeStatusSha256,
    identifier: dirty
      ? `${commit.slice(0, 12)}+worktree-${worktreeStatusSha256.slice(0, 12)}`
      : commit,
  };
}

function readReleaseSourceIdentity(): Ui2ReleaseSourceIdentity {
  releaseSourceIdentity ??= readSourceIdentity();
  return releaseSourceIdentity;
}

function runGit(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

async function readManifest(): Promise<Ui2ReleaseManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as Ui2ReleaseManifest;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}
