import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCandidate } from "./desktop-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const evidenceRoot = join(repositoryRoot, ".codex-artifacts/desktop-release");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function officeReviewDrift() {
  try {
    const { readReviewedPackagedOfficeSource } = await import("../../apps/desktop/scripts/packaged-office-native-review.mjs");
    const { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } = await import(
      "../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts");
    const { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } = await import(
      "../../apps/desktop/scripts/packaged-office-native-review-inputs.mjs");
    const reviewBytes = await readFile(join(repositoryRoot, "native/office-local/reviewed-packaged-source-v1.json"));
    const review = JSON.parse(reviewBytes);
    const compare = async (root, paths, expected) => {
      const mismatches = [];
      for (const path of paths) {
        try {
          const actual = sha256(await readFile(join(root, path)));
          if (actual !== expected[path]) mismatches.push({ path, expected: expected[path], actual });
        } catch (error) {
          mismatches.push({ path, expected: expected[path], error: error.code ?? error.message });
        }
      }
      return { expectedCount: Object.keys(expected).length, pathCount: paths.length,
        mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 20) };
    };
    try {
      readReviewedPackagedOfficeSource();
      return { status: "passed" };
    } catch (error) {
      return { status: "blocked", reason: error.message,
        source: await compare(join(repositoryRoot, "native/office-local"), OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS,
          review.sourceSha256),
        packaging: await compare(repositoryRoot, PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS,
          review.packagingSha256) };
    }
  } catch (error) {
    return { status: "unavailable", reason: error.code ?? error.message };
  }
}

/** Inspection reports facts only; it never grants a native or resource approval. */
export async function inspectDesktopPrerequisites() {
  const candidate = await readCandidate({ sha: process.env.DESKTOP_SOURCE_SHA, tag: process.env.DESKTOP_RELEASE_TAG });
  const target = process.env.DESKTOP_TARGET;
  const expectedTarget = process.platform === "darwin" && process.arch === "arm64" ? "macos-arm64"
    : process.platform === "win32" && process.arch === "x64" ? "windows-x64" : undefined;
  if (!expectedTarget || expectedTarget !== target) throw new Error("Use a native host matching the selected Desktop target");
  await mkdir(evidenceRoot, { recursive: true });
  const checks = [];
  const check = async (name, operation) => {
    try { checks.push({ name, status: "passed", observation: await operation() }); }
    catch (error) {
      checks.push({ name, status: "blocked", reason: error.message,
        ...(name === "reviewed-native-source-and-toolchain" ? { diagnostic: await officeReviewDrift() } : {}) });
    }
  };
  await check("native-build-storage-observation", async () => {
    const directory = await realpath(process.env.RUNNER_TEMP ?? evidenceRoot);
    const volume = await statfs(directory);
    return { directory, availableBytes: volume.bavail * volume.bsize, totalBytes: volume.blocks * volume.bsize,
      approval: "not_granted" };
  });
  if (target === "macos-arm64") {
    let runtimeObservation;
    await check("dmg-attachment-inventory-observation", async () => {
      const bytes = execFileSync("/usr/bin/hdiutil", ["info", "-plist"],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
      await writeFile(join(evidenceRoot, "macos-dmg-inventory.plist"), bytes);
      return { approval: "not_granted", evidence: "macos-dmg-inventory.plist" };
    });
    await check("native-toolchain-observation", async () => {
      const headers = await realpath(process.env.LING_OFFICE_NODE_HEADERS ?? resolve(dirname(process.execPath), "../include/node"));
      process.env.LING_OFFICE_NODE_HEADERS = headers;
      if (process.env.GITHUB_ENV) {
        if (/[\r\n]/u.test(headers)) throw new Error("Invalid Node headers path");
        await appendFile(process.env.GITHUB_ENV, `LING_OFFICE_NODE_HEADERS=${headers}\n`);
      }
      const bytes = execFileSync(process.execPath, ["apps/desktop/scripts/packaged-office-native-toolchain.mjs"],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1024 * 1024, env: process.env });
      const observation = JSON.parse(bytes);
      await writeFile(join(evidenceRoot, "macos-toolchain-observation.json"), JSON.stringify(observation, null, 2) + "\n");
      return { approval: "not_granted", evidence: "macos-toolchain-observation.json" };
    });
    await check("reviewed-native-source-and-toolchain", async () => {
      const { readReviewedPackagedOfficeSource } = await import("../../apps/desktop/scripts/packaged-office-native-review.mjs");
      const { readReviewedCodesignSource } = await import("../../apps/desktop/scripts/packaged-codesign-review-publication.mjs");
      return { officeSourceReviewSha256: readReviewedPackagedOfficeSource().sourceReviewSha256,
        codesignSourceReviewSha256: readReviewedCodesignSource().sourceReviewSha256 };
    });
    await check("restricted-runtime-observation", async () => {
      const requireDesktop = createRequire(join(repositoryRoot, "apps/desktop/package.json"));
      const electron = requireDesktop("electron");
      const bytes = execFileSync(electron, ["apps/desktop/scripts/packaged-restricted-runtime-observation.mjs"],
        { cwd: repositoryRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
      const observation = JSON.parse(bytes);
      runtimeObservation = observation;
      await writeFile(join(evidenceRoot, "macos-restricted-runtime-observation.json"), JSON.stringify(observation, null, 2) + "\n");
      return { approval: "not_granted", evidence: "macos-restricted-runtime-observation.json" };
    });
    await check("reviewed-restricted-runtime", async () => {
      const { readReviewedCodesignSource } = await import("../../apps/desktop/scripts/packaged-codesign-review-publication.mjs");
      const { review } = readReviewedCodesignSource();
      if (!runtimeObservation || !isDeepStrictEqual(runtimeObservation.runtime, review.runtime)
        || !isDeepStrictEqual(runtimeObservation.os, review.os)) throw new Error("Restricted-command runtime/OS review does not match the observed Electron host");
      return { reviewId: review.reviewId };
    });
  }
  const report = { ...candidate, target, operation: "inspect", approval: "not_granted",
    buildPrerequisitesPass: checks.every(check => check.status === "passed"),
    artifactAcceptance: "not_run", distributionMaterials: "must_be_generated_and_verified_for_this_build", checks };
  await writeFile(join(evidenceRoot, "prerequisites.json"), JSON.stringify(report, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    `### Desktop ${target}: prerequisite inspection`, "",
    "This inspection creates no installer and grants no publication approval.", "",
    ...checks.map(check => `- **${check.status}**: ${check.name}${check.reason ? ` — ${check.reason}` : ""}`), "",
    "Use build only after blocked prerequisites have been resolved. Generated notices and actual package checks are still required.", "",
  ].join("\n"));
  return report;
}

async function main() {
  const [operation] = process.argv.slice(2);
  if (operation === "inspect") {
    console.log(JSON.stringify(await inspectDesktopPrerequisites(), null, 2));
  } else if (operation === "require") {
    const report = await inspectDesktopPrerequisites();
    if (!report.buildPrerequisitesPass) throw new Error("Desktop build prerequisites are blocked; see prerequisites.json. No native or resource checks were bypassed.");
  } else throw new Error("Use inspect or require");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
