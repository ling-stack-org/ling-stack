import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const UI2_P9EF_BATCH_ID = "T13-P.9EF";
export const UI2_P9EF_P9D_TAG = "ui2-web-p9d-checkpoint-20260727";
export const UI2_P9EF_CAPTURE_COMMAND =
  "LING_CAPTURE_UI2_P9EF_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4284 corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-p9ef-final-evidence.spec.ts --workers=1";
export const UI2_P9EF_SERVED_ARTIFACT = "Vite source via Playwright webServer";
export const UI2_P9EF_EVIDENCE_RELATIVE_DIRECTORY =
  "docs/design/ui2.0\u5347\u7ea7/evidence/release/web/p9ef-final-error-ownership";
export const UI2_P9EF_EXPECTED_SCENARIO_IDS = [
  "p9ef-conversation-beta-clean-after-late-alpha",
  "p9ef-conversation-alpha-failure-restored",
  "p9ef-conversation-new-draft-clean-after-stale-upload",
  "p9ef-teammate-designer-clean-after-late-engineer",
  "p9ef-teammate-engineer-error-after-designer-success",
  "p9ef-plugin-row-failure-after-unrelated-success",
  "p9ef-shell-settings-error-restored",
  "p9ef-channel-teammate-add-failure-restored",
] as const;

export type Ui2P9efScenarioId = typeof UI2_P9EF_EXPECTED_SCENARIO_IDS[number];
export type Ui2P9efTheme = "ling-light" | "ling-dark";
export type Ui2P9efLocale = "en-US" | "zh-CN";
export type Ui2P9efMotion = "no-preference" | "reduce";

export interface Ui2P9efExpectedHttpFailure {
  readonly method: "GET" | "PATCH" | "POST" | "PUT";
  readonly status: 503;
  readonly urlPattern: string;
  readonly count: number;
}

export interface Ui2P9efScenarioDefinition {
  readonly stableId: Ui2P9efScenarioId;
  readonly label: string;
  readonly functionIds: readonly string[];
  readonly fixture: string;
  readonly trigger: {
    readonly summary: string;
    readonly steps: readonly string[];
  };
  readonly owner: {
    readonly surface: string;
    readonly scope: string;
    readonly key: string;
  };
  readonly assertions: {
    readonly visible: readonly string[];
    readonly absent: readonly string[];
  };
  readonly expectedHttpFailures: readonly Ui2P9efExpectedHttpFailure[];
  readonly overflowOwners: readonly {
    readonly label: string;
    readonly selector: string;
  }[];
  readonly viewport: {
    readonly width: 1280 | 1440;
    readonly height: 800 | 960;
  };
  readonly theme: Ui2P9efTheme;
  readonly locale: Ui2P9efLocale;
  readonly keyboard: {
    readonly exercised: true;
    readonly checks: readonly string[];
  };
  readonly reducedMotion: Ui2P9efMotion;
}

interface Ui2P9efConsoleError {
  readonly text: string;
  readonly locationUrl: string;
}

interface Ui2P9efHttpFailure {
  readonly method: string;
  readonly status: number;
  readonly url: string;
}

export interface Ui2P9efRuntimeMonitor {
  readonly consoleErrors: Ui2P9efConsoleError[];
  readonly pageErrors: string[];
  readonly httpFailures: Ui2P9efHttpFailure[];
}

interface Ui2P9efOverflowRecord {
  readonly document: number;
  readonly body: number;
  readonly owners: readonly {
    readonly label: string;
    readonly selector: string;
    readonly found: boolean;
    readonly overflow: number | null;
    readonly clientWidth: number | null;
    readonly scrollWidth: number | null;
  }[];
}

export interface Ui2P9efRuntimeObservation {
  readonly consoleErrors: readonly Ui2P9efConsoleError[];
  readonly pageErrors: readonly string[];
  readonly httpFailures: readonly Ui2P9efHttpFailure[];
  readonly expectedConsole503Pattern: string;
  readonly expectedConsole503Count: number;
  readonly unexpectedConsoleErrors: readonly Ui2P9efConsoleError[];
  readonly unexpectedHttpFailures: readonly Ui2P9efHttpFailure[];
  readonly overflow: Ui2P9efOverflowRecord;
}

interface Ui2P9efSourceIdentity {
  readonly commit: string;
  readonly branch: string;
  readonly dirty: false;
  readonly worktreeStatusSha256: string;
  readonly identifier: string;
}

interface Ui2P9efScenarioRecord extends Ui2P9efScenarioDefinition {
  readonly status: "captured";
  readonly url: string;
  readonly runtime: Ui2P9efRuntimeObservation;
  readonly png: {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
  };
  readonly sidecarFile: string;
  readonly servedArtifact: string;
  readonly captureCommand: string;
  readonly source: Ui2P9efSourceIdentity;
  readonly capturedAt: string;
}

interface Ui2P9efManifest {
  readonly schemaVersion: 1;
  readonly batchId: typeof UI2_P9EF_BATCH_ID;
  readonly status: "partial" | "captured";
  readonly expectedScenarioIds: readonly Ui2P9efScenarioId[];
  readonly servedArtifact: string;
  readonly baseUrl: string;
  readonly captureCommand: string;
  readonly protectedEvidence: {
    readonly tag: typeof UI2_P9EF_P9D_TAG;
    readonly tagCommit: string;
  };
  readonly closeout: {
    readonly focusedGate: "pending-final-ledger";
    readonly finalNonDesktopGate: "pending-final-ledger";
    readonly feedbackGuard: {
      readonly status: "pending-final-ledger";
      readonly expected: "writer=0 compatibility=0 consumer=0 released-contracts=22";
    };
    readonly visualReview: "pending";
    readonly excluded: readonly [
      "Desktop cross-platform release acceptance",
      "Quick Theme Studio D3",
      "First Run new entry",
      "Teammate MCP A/A/A",
      "Skill Source Sync",
      "Council Runtime",
    ];
  };
  readonly generatedAt: string;
  readonly source: Ui2P9efSourceIdentity;
  readonly scenarios: readonly Ui2P9efScenarioRecord[];
}

const EXPECTED_CONSOLE_503_PATTERN =
  "^Failed to load resource: the server responded with a status of 503 \\(Service Unavailable\\)$";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceDirectory = path.join(repositoryRoot, UI2_P9EF_EVIDENCE_RELATIVE_DIRECTORY);
const manifestPath = path.join(evidenceDirectory, "manifest.json");
const metadataPath = path.join(evidenceDirectory, "metadata.md");
let captureSourceIdentity: Ui2P9efSourceIdentity | undefined;

export function isUi2P9efCaptureEnabled(): boolean {
  return process.env.LING_CAPTURE_UI2_P9EF_EVIDENCE === "1";
}

export function watchUi2P9efRuntime(page: Page): Ui2P9efRuntimeMonitor {
  const monitor: Ui2P9efRuntimeMonitor = {
    consoleErrors: [],
    pageErrors: [],
    httpFailures: [],
  };
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    monitor.consoleErrors.push({
      text: message.text(),
      locationUrl: message.location().url,
    });
  });
  page.on("pageerror", (error) => monitor.pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    monitor.httpFailures.push({
      method: response.request().method(),
      status: response.status(),
      url: `${url.pathname}${url.search}`,
    });
  });
  return monitor;
}

export async function prepareUi2P9efSurface(
  page: Page,
  scenario: Ui2P9efScenarioDefinition,
): Promise<void> {
  await page.setViewportSize(scenario.viewport);
  await page.emulateMedia({
    colorScheme: scenario.theme === "ling-dark" ? "dark" : "light",
    reducedMotion: scenario.reducedMotion,
  });
  await page.addInitScript(({ locale, theme }) => {
    const selection = { mode: "fixed", themeId: theme };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme === "ling-dark" ? "dark" : "light");
  }, { locale: scenario.locale, theme: scenario.theme });
}

export async function observeUi2P9efScenario(input: {
  readonly page: Page;
  readonly scenario: Ui2P9efScenarioDefinition;
  readonly runtime: Ui2P9efRuntimeMonitor;
}): Promise<Ui2P9efRuntimeObservation> {
  await input.page.waitForTimeout(100);
  const expectedConsole503Count = input.scenario.expectedHttpFailures.reduce(
    (total, failure) => total + failure.count,
    0,
  );
  const console503Pattern = new RegExp(EXPECTED_CONSOLE_503_PATTERN, "u");
  const unexpectedConsoleErrors = input.runtime.consoleErrors.filter(
    (error) => !console503Pattern.test(error.text),
  );
  const unexpectedHttpFailures = findUnexpectedHttpFailures(
    input.runtime.httpFailures,
    input.scenario.expectedHttpFailures,
  );
  return {
    consoleErrors: [...input.runtime.consoleErrors],
    pageErrors: [...input.runtime.pageErrors],
    httpFailures: [...input.runtime.httpFailures],
    expectedConsole503Pattern: EXPECTED_CONSOLE_503_PATTERN,
    expectedConsole503Count,
    unexpectedConsoleErrors,
    unexpectedHttpFailures,
    overflow: await collectOverflow(input.page, input.scenario),
  };
}

export function assertUi2P9efObservation(
  scenario: Ui2P9efScenarioDefinition,
  observation: Ui2P9efRuntimeObservation,
): void {
  const problems: string[] = [];
  const console503Pattern = new RegExp(observation.expectedConsole503Pattern, "u");
  const console503Count = observation.consoleErrors.filter((error) => console503Pattern.test(error.text)).length;
  if (console503Count !== observation.expectedConsole503Count) {
    problems.push(`console 503 count ${console503Count} != ${observation.expectedConsole503Count}`);
  }
  if (observation.unexpectedConsoleErrors.length > 0) {
    problems.push(...observation.unexpectedConsoleErrors.map((error) => `unexpected console: ${error.text}`));
  }
  if (observation.pageErrors.length > 0) {
    problems.push(...observation.pageErrors.map((error) => `pageerror: ${error}`));
  }
  if (observation.unexpectedHttpFailures.length > 0) {
    problems.push(...observation.unexpectedHttpFailures.map(
      (failure) => `unexpected HTTP ${failure.method} ${failure.status} ${failure.url}`,
    ));
  }
  for (const expected of scenario.expectedHttpFailures) {
    const count = observation.httpFailures.filter((actual) => matchesHttpFailure(actual, expected)).length;
    if (count !== expected.count) {
      problems.push(`${expected.method} ${expected.status} ${expected.urlPattern} count ${count} != ${expected.count}`);
    }
  }
  if (observation.overflow.document > 1) problems.push(`document overflow +${Math.ceil(observation.overflow.document)}px`);
  if (observation.overflow.body > 1) problems.push(`body overflow +${Math.ceil(observation.overflow.body)}px`);
  for (const owner of observation.overflow.owners) {
    if (!owner.found) problems.push(`overflow owner is missing: ${owner.label} (${owner.selector})`);
    else if ((owner.overflow ?? 0) > 1) problems.push(`${owner.label} overflow +${Math.ceil(owner.overflow ?? 0)}px`);
  }
  if (problems.length > 0) {
    throw new Error(`P9-EF evidence observation failed for ${scenario.stableId}:\n${problems.map((item) => `- ${item}`).join("\n")}`);
  }
}

export async function captureUi2P9efScenario(input: {
  readonly page: Page;
  readonly scenario: Ui2P9efScenarioDefinition;
  readonly observation: Ui2P9efRuntimeObservation;
}): Promise<{ readonly captured: boolean }> {
  if (!isUi2P9efCaptureEnabled()) return { captured: false };
  assertUi2P9efObservation(input.scenario, input.observation);
  const source = readCaptureSourceIdentity();
  await mkdir(evidenceDirectory, { recursive: true });
  const current = await readManifestIfPresent();
  if (current && stableJson(current.source) !== stableJson(source)) {
    throw new Error("P9-EF evidence directory contains a different source identity. Remove the partial batch before recapturing.");
  }
  const baseUrl = new URL(input.page.url()).origin;
  if (current && current.baseUrl !== baseUrl) {
    throw new Error(`P9-EF evidence directory belongs to ${current.baseUrl}, not ${baseUrl}.`);
  }

  const pngFile = `${input.scenario.stableId}.png`;
  const sidecarFile = `${input.scenario.stableId}.json`;
  const pngPath = path.join(evidenceDirectory, pngFile);
  const temporaryPngPath = `${pngPath}.${process.pid}.tmp`;
  let pngBytes: Buffer;
  let dimensions: { readonly width: number; readonly height: number };
  try {
    await input.page.screenshot({ animations: "disabled", fullPage: false, path: temporaryPngPath, type: "png" });
    pngBytes = await readFile(temporaryPngPath);
    dimensions = readPngDimensions(pngBytes);
  } catch (error) {
    await rm(temporaryPngPath, { force: true });
    throw error;
  }
  if (dimensions.width !== input.scenario.viewport.width || dimensions.height !== input.scenario.viewport.height) {
    await rm(temporaryPngPath, { force: true });
    throw new Error(`Captured PNG ${dimensions.width}x${dimensions.height} does not match ${input.scenario.viewport.width}x${input.scenario.viewport.height}.`);
  }
  await rename(temporaryPngPath, pngPath);
  const capturedAt = new Date().toISOString();
  const record: Ui2P9efScenarioRecord = {
    ...input.scenario,
    status: "captured",
    url: input.page.url(),
    runtime: input.observation,
    png: {
      file: pngFile,
      width: dimensions.width,
      height: dimensions.height,
      sha256: createHash("sha256").update(pngBytes).digest("hex"),
    },
    sidecarFile,
    servedArtifact: UI2_P9EF_SERVED_ARTIFACT,
    captureCommand: UI2_P9EF_CAPTURE_COMMAND,
    source,
    capturedAt,
  };
  await writeJsonAtomically(path.join(evidenceDirectory, sidecarFile), record);

  const scenarios = [
    ...(current?.scenarios ?? []).filter((item) => item.stableId !== record.stableId),
    record,
  ].sort((left, right) => (
    UI2_P9EF_EXPECTED_SCENARIO_IDS.indexOf(left.stableId) -
    UI2_P9EF_EXPECTED_SCENARIO_IDS.indexOf(right.stableId)
  ));
  const manifest: Ui2P9efManifest = {
    schemaVersion: 1,
    batchId: UI2_P9EF_BATCH_ID,
    status: scenarios.length === UI2_P9EF_EXPECTED_SCENARIO_IDS.length ? "captured" : "partial",
    expectedScenarioIds: UI2_P9EF_EXPECTED_SCENARIO_IDS,
    servedArtifact: UI2_P9EF_SERVED_ARTIFACT,
    baseUrl,
    captureCommand: UI2_P9EF_CAPTURE_COMMAND,
    protectedEvidence: {
      tag: UI2_P9EF_P9D_TAG,
      tagCommit: runGit(["rev-parse", `${UI2_P9EF_P9D_TAG}^{commit}`]),
    },
    closeout: {
      focusedGate: "pending-final-ledger",
      finalNonDesktopGate: "pending-final-ledger",
      feedbackGuard: {
        status: "pending-final-ledger",
        expected: "writer=0 compatibility=0 consumer=0 released-contracts=22",
      },
      visualReview: "pending",
      excluded: [
        "Desktop cross-platform release acceptance",
        "Quick Theme Studio D3",
        "First Run new entry",
        "Teammate MCP A/A/A",
        "Skill Source Sync",
        "Council Runtime",
      ],
    },
    generatedAt: capturedAt,
    source,
    scenarios,
  };
  await writeJsonAtomically(manifestPath, manifest);
  await writeTextAtomically(metadataPath, renderMetadata(manifest));
  return { captured: true };
}

export async function snapshotUi2P9efEvidenceDirectory(): Promise<string> {
  try {
    const entries = await readdir(evidenceDirectory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file);
      hash.update("\0");
      hash.update(await readFile(path.join(evidenceDirectory, file)));
      hash.update("\0");
    }
    return `${files.length}:${hash.digest("hex")}`;
  } catch (error) {
    if (isMissingPath(error)) return "missing";
    throw error;
  }
}

async function collectOverflow(
  page: Page,
  scenario: Ui2P9efScenarioDefinition,
): Promise<Ui2P9efOverflowRecord> {
  return page.evaluate((owners) => ({
    document: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    body: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
    owners: owners.map((owner) => {
      const element = document.querySelector<HTMLElement>(owner.selector);
      return {
        ...owner,
        found: Boolean(element),
        overflow: element ? Math.max(0, element.scrollWidth - element.clientWidth) : null,
        clientWidth: element?.clientWidth ?? null,
        scrollWidth: element?.scrollWidth ?? null,
      };
    }),
  }), scenario.overflowOwners);
}

function findUnexpectedHttpFailures(
  actual: readonly Ui2P9efHttpFailure[],
  expected: readonly Ui2P9efExpectedHttpFailure[],
): Ui2P9efHttpFailure[] {
  return actual.filter((failure) => !expected.some((candidate) => matchesHttpFailure(failure, candidate)));
}

function matchesHttpFailure(actual: Ui2P9efHttpFailure, expected: Ui2P9efExpectedHttpFailure): boolean {
  return actual.method === expected.method && actual.status === expected.status && new RegExp(expected.urlPattern, "u").test(actual.url);
}

function readCaptureSourceIdentity(): Ui2P9efSourceIdentity {
  if (captureSourceIdentity) return captureSourceIdentity;
  const commit = runGit(["rev-parse", "HEAD"]);
  const branch = runGit(["branch", "--show-current"]) || "detached";
  const worktreeStatus = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  const worktreeStatusSha256 = createHash("sha256").update(worktreeStatus).digest("hex");
  if (worktreeStatus.length > 0) {
    throw new Error("P9-EF evidence capture requires a clean source worktree before the first scenario.");
  }
  captureSourceIdentity = {
    commit,
    branch,
    dirty: false,
    worktreeStatusSha256,
    identifier: commit,
  };
  return captureSourceIdentity;
}

function runGit(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

async function readManifestIfPresent(): Promise<Ui2P9efManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as Ui2P9efManifest;
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(filePath: string, value: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, value, "utf8");
  await rename(temporaryPath, filePath);
}

function renderMetadata(manifest: Ui2P9efManifest): string {
  return [
    "# T13-P.9EF Final Error Ownership Evidence",
    "",
    `- Batch: \`${manifest.batchId}\``,
    `- Status: \`${manifest.status}\``,
    `- Capture state: \`${manifest.scenarios.length}-of-${manifest.expectedScenarioIds.length}\``,
    "- Structural verifier state: `pending`",
    `- Visual review state: \`${manifest.closeout.visualReview}\``,
    `- Served artifact: ${manifest.servedArtifact}`,
    `- Base URL: \`${manifest.baseUrl}\``,
    `- Generated at: \`${manifest.generatedAt}\``,
    `- Source commit: \`${manifest.source.commit}\``,
    `- Source branch: \`${manifest.source.branch}\``,
    `- Source dirty: \`${manifest.source.dirty}\``,
    `- Worktree status SHA-256: \`${manifest.source.worktreeStatusSha256}\``,
    `- Source identifier: \`${manifest.source.identifier}\``,
    `- Protected P9-D tag: \`${manifest.protectedEvidence.tag}\` (\`${manifest.protectedEvidence.tagCommit}\`)`,
    `- Focused gate: \`${manifest.closeout.focusedGate}\``,
    `- Final non-Desktop gate: \`${manifest.closeout.finalNonDesktopGate}\``,
    `- Feedback guard: \`${manifest.closeout.feedbackGuard.status}\` (expected ${manifest.closeout.feedbackGuard.expected})`,
    "",
    "Capture command:",
    "",
    "```bash",
    manifest.captureCommand,
    "```",
    "",
    "This capture ledger contains only the eight P9-EF changed states. It does not rewrite the existing Web release ledger or older evidence. Focused/full gate results and visual review are finalized in the UI 2.0 closeout documents after this read-only verifier passes.",
    "",
    `Excluded from this Web evidence batch: ${manifest.closeout.excluded.join(", ")}.`,
    "",
  ].join("\n");
}

function readPngDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Captured P9-EF artifact is not a valid PNG with an IHDR chunk.");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
