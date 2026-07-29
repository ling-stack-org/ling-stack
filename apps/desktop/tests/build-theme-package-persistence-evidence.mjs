#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const runRoot = resolve(options.runDirectory);
const outputRoot = resolve(options.outputDirectory);
const report = JSON.parse(await readFile(join(runRoot, "report.json"), "utf8"));
assert(report?.schemaVersion === 1, "Smoke report schemaVersion must be 1");
assert(report?.mode === "all", "Evidence bundle requires a complete mode=all smoke report");
assert(["passed", "failed", "uncovered"].includes(report?.status), "Smoke report status is invalid");
assert(Array.isArray(report?.steps) && report.steps.length > 0, "Smoke report steps are missing");
assert(Array.isArray(report?.launches) && report.launches.length > 0, "Smoke report launches are missing");
await assertNewOutputDirectory(outputRoot);

const candidateDirectory = join(outputRoot, "candidate");
const screenshotDirectory = join(outputRoot, "screenshots");
const logDirectory = join(outputRoot, "logs");
await Promise.all([
  mkdir(candidateDirectory, { recursive: true, mode: 0o700 }),
  mkdir(screenshotDirectory, { recursive: true, mode: 0o700 }),
  mkdir(logDirectory, { recursive: true, mode: 0o700 }),
]);

const artifact = await copyAndDescribe(report.app.artifact, join(candidateDirectory, "artifact.zip"));
const executable = await copyAndDescribe(report.app.executable, join(candidateDirectory, "ling-stack-executable"));
const appAsar = await copyAndDescribe(
  join(report.app.appRoot, "Contents", "Resources", "app.asar"),
  join(candidateDirectory, "app.asar"),
);
assert(artifact.sha256 === report.app.artifactSha256, "Candidate artifact changed after the smoke run");
assert(executable.sha256 === report.app.executableSha256, "Candidate executable changed after the smoke run");
assert(appAsar.sha256 === report.app.appAsarSha256, "Candidate app.asar changed after the smoke run");

const reportReference = await copyAndDescribe(join(runRoot, "report.json"), join(outputRoot, "report.json"));
const screenshotRegistrations = collectScreenshotRegistrations(report.steps);
const screenshotEntries = [];
for (const entry of await sortedRegularFiles(join(runRoot, "screenshots"), ".png")) {
  const sourcePath = join(runRoot, "screenshots", entry.name);
  const copied = await copyAndDescribe(sourcePath, join(screenshotDirectory, entry.name));
  const registered = screenshotRegistrations.get(sourcePath);
  if (registered?.sha256) {
    assert(copied.sha256 === registered.sha256, `Screenshot changed after the smoke run: ${entry.name}`);
  }
  screenshotEntries.push({
    path: `screenshots/${entry.name}`,
    sha256: copied.sha256,
    ...(registered?.stepId ? { stepId: registered.stepId } : {}),
    phase: registered?.phase ?? inferScreenshotPhase(entry.name),
    capture: entry.name.endsWith("-window.png") ? "window" : "content",
  });
}

const logEntries = [];
for (const launch of report.launches) {
  for (const stream of ["stdout", "stderr"]) {
    const sourcePath = launch[`${stream}Path`];
    assert(typeof sourcePath === "string" && sourcePath.length > 0, `${launch.launchId} ${stream} path is missing`);
    const fileName = `${launch.launchId}.${stream}.log`;
    const copied = await copyAndDescribe(sourcePath, join(logDirectory, fileName));
    logEntries.push({
      path: `logs/${fileName}`,
      sha256: copied.sha256,
      launchId: launch.launchId,
      stream,
    });
  }
}

const firstFrameTransitions = report.steps.flatMap((step) => {
  const launchEvidence = step?.details?.launchEvidence;
  return launchEvidence?.expectedThemeId
    ? [{ stepId: step.id, expectedThemeId: launchEvidence.expectedThemeId }]
    : [];
});
const metadata = {
  schemaVersion: 1,
  functionId: "DESKTOP-THEME-PACK-PERSISTENCE-001",
  harness: report.harness,
  status: report.status,
  platform: report.host.platform,
  arch: report.host.architecture,
  candidate: {
    version: report.app.version,
    commit: report.app.commit,
    applicationId: report.app.applicationId ?? report.app.bundleId,
    artifact: { path: "candidate/artifact.zip", sha256: artifact.sha256 },
    executable: { path: "candidate/ling-stack-executable", sha256: executable.sha256 },
    appAsar: { path: "candidate/app.asar", sha256: appAsar.sha256 },
  },
  report: { path: "report.json", sha256: reportReference.sha256 },
  screenshots: screenshotEntries,
  logs: logEntries,
  requiredStepIds: report.steps.map((step) => step.id),
  firstFrameTransitions,
  generatedAt: new Date().toISOString(),
  notes: [
    `Source smoke run: ${runRoot}`,
    `Candidate worktree dirty: ${Boolean(report.app.worktreeDirty)}`,
    `Candidate worktree change count: ${Number(report.app.worktreeChangeCount ?? 0)}`,
    "Large candidate files stay in the Git-ignored Desktop release evidence directory.",
  ],
};
await writeFile(join(outputRoot, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  status: "built",
  evidenceDirectory: outputRoot,
  reportStatus: report.status,
  screenshotCount: screenshotEntries.length,
  logCount: logEntries.length,
  requiredStepCount: metadata.requiredStepIds.length,
  firstFrameTransitionCount: firstFrameTransitions.length,
  artifactSha256: artifact.sha256,
}, null, 2)}\n`);

function collectScreenshotRegistrations(steps) {
  const registrations = new Map();
  for (const step of steps) {
    const launchEvidence = step?.details?.launchEvidence;
    registerScreenshotPair(registrations, launchEvidence?.screenshot, step.id, "first-observed");
    registerScreenshotPair(registrations, launchEvidence?.reactReadyScreenshot, step.id, "react-ready");
    registerScreenshotPair(registrations, step?.details?.preview?.screenshot, step.id, "preview");
  }
  return registrations;
}

function registerScreenshotPair(registrations, screenshot, stepId, phase) {
  if (!screenshot || typeof screenshot !== "object") return;
  if (typeof screenshot.contentPath === "string") {
    registrations.set(screenshot.contentPath, { stepId, phase, sha256: screenshot.contentSha256 });
  }
  if (typeof screenshot.windowPath === "string") {
    registrations.set(screenshot.windowPath, { stepId, phase, sha256: screenshot.windowSha256 });
  }
}

function inferScreenshotPhase(fileName) {
  if (fileName.includes("-first-observed-")) return "first-observed";
  if (fileName.includes("-react-ready-")) return "react-ready";
  if (fileName.startsWith("installed-primary-")) return "preview";
  return "other";
}

async function copyAndDescribe(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const info = await lstat(source);
  assert(info.isFile() && !info.isSymbolicLink(), `Evidence source must be a regular non-symlink file: ${source}`);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await copyFile(source, destinationPath, constants.COPYFILE_FICLONE);
  return { path: destinationPath, sha256: await sha256File(destinationPath) };
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function sortedRegularFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

async function assertNewOutputDirectory(directory) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  assert(!info, `Evidence output already exists: ${directory}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

function parseArguments(args) {
  const parsed = { help: false, outputDirectory: undefined, runDirectory: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inlineValue] = args[index].split("=", 2);
    const value = () => inlineValue ?? args[++index];
    if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (flag === "--run") parsed.runDirectory = requiredValue(flag, value());
    else if (flag === "--output") parsed.outputDirectory = requiredValue(flag, value());
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!parsed.help) {
    assert(parsed.runDirectory, "--run <directory> is required");
    assert(parsed.outputDirectory, "--output <directory> is required");
  }
  return parsed;
}

function requiredValue(flag, value) {
  assert(value && !value.startsWith("--"), `${flag} requires a value`);
  return value;
}

function helpText() {
  return `Build a self-contained P7CD Theme Package persistence evidence bundle.\n\nUsage:\n  node apps/desktop/tests/build-theme-package-persistence-evidence.mjs --run <smoke-run> --output <new-directory>\n`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
