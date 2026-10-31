import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGstackShellCallSites } from "./inspect-shell-call-sites.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

export const PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM = "sha256:58200ccce5aced2d24eea8ff7d14fd4636d8fcd7bbf22fc4de8bd578a80e8129";
const reviewFile = fileURLToPath(new URL("./reviewed-shell-dependencies.json", import.meta.url));
const scriptFile = fileURLToPath(import.meta.url);
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const fail = reason => { throw new Error(`gstack_shell_dependency_${reason}`); };
const readRecord = (path, options = {}) => readGstackClosureFileRecord(path, { ...options, errorPrefix: "gstack_shell_dependency" });
const canonicalPath = path => typeof path === "string" && path.length > 0 && !posix.isAbsolute(path) && !win32.isAbsolute(path) &&
  !/[\\:\0]/.test(path) && !path.split("/").some(part => !part || part === "." || part === "..");
const alias = path => path.normalize("NFKC").toLowerCase();
const policies = new Map([
  ["bundled-resource", { kind: "source", control: "frozen-bundle-root", resources: true, prerequisites: [] }],
  ["generated-state", { kind: "source", control: "structured-owned-state", resources: false,
    prerequisites: ["owned-cloud-state", "explicit-cloud-operation-approval"] }],
  ["bundled-command-output", { kind: "dynamic-evaluation", control: "structured-helper-output", resources: true, prerequisites: [] }],
  ["environment-indirection", { kind: "dynamic-evaluation", control: "bounded-environment-read", resources: false,
    prerequisites: ["owned-environment-inputs"] }],
  ["shell-introspection", { kind: "dynamic-evaluation", control: "owned-shell-introspection", resources: false,
    prerequisites: ["owned-shell-runtime"] }],
  ["user-command", { kind: "dynamic-evaluation", control: "approved-workspace-command", resources: false,
    prerequisites: ["explicit-user-command-approval"] }],
  ["host-probe", { kind: "dynamic-evaluation", control: "owned-browser-probe", resources: false,
    prerequisites: ["owned-playwright-browser", "packaged-node-or-bun"] }],
]);

// Reviewed counterparts are immutable source dependencies, not evaluated paths.
// Generated state and runtime controls remain explicit unfulfilled host gates.
export async function verifyReviewedGstackShellDependencies(options) {
  const reviewPath = resolve(options.reviewPath ?? reviewFile);
  const expectedReviewChecksum = options.expectedReviewChecksum ??
    (reviewPath === reviewFile ? PINNED_SHELL_DEPENDENCY_REVIEW_CHECKSUM : undefined);
  if (!validChecksum(expectedReviewChecksum)) fail("review_checksum_required");
  const ownInput = await readRecord(scriptFile);
  const reviewInput = await readRecord(reviewPath, { retain: true, maximumBytes: 2 * 1024 * 1024 });
  if (reviewInput.checksum !== expectedReviewChecksum) fail("review_mismatch");
  let catalog;
  try { catalog = JSON.parse(reviewInput.bytes.toString("utf8")); }
  catch { fail("review_identity_invalid"); }
  const calls = await inspectGstackShellCallSites(options);
  const dynamicSiteGraphChecksum = checksum(JSON.stringify(calls.dynamicEvaluationSites));
  if (catalog?.schemaVersion !== 1 || catalog.reviewStatus !== "reviewed-static-dependency-mappings" || catalog.releaseEligible !== false ||
    catalog.upstreamRevision !== calls.upstreamRevision || catalog.sourceManifestChecksum !== calls.sourceManifestChecksum ||
    catalog.callGraphChecksum !== calls.callGraphChecksum || catalog.sourceSiteGraphChecksum !== calls.sourceSiteGraphChecksum ||
    catalog.dynamicSiteGraphChecksum !== dynamicSiteGraphChecksum || !Array.isArray(catalog.entries)) fail("review_identity_invalid");
  const root = await realpath(resolve(options.runtimeRoot)), manifestPath = join(dirname(root), "source-manifest.json");
  const manifestInput = await readRecord(manifestPath, { retain: true, maximumBytes: 16 * 1024 * 1024 });
  if (manifestInput.checksum !== calls.sourceManifestChecksum) fail("source_manifest_changed");
  const manifest = JSON.parse(manifestInput.bytes.toString("utf8")), files = new Map(), fileAliases = new Set();
  for (const file of manifest.files) {
    if (!canonicalPath(file.path) || !validChecksum(file.checksum) || !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 || fileAliases.has(alias(file.path))) fail("source_manifest_invalid");
    fileAliases.add(alias(file.path));
    if (file.path.startsWith("runtime/")) files.set(file.path.slice(8), file);
  }
  const expectedSites = [
    ...calls.sourceSites.map(site => ({ kind: "source", site })),
    ...calls.dynamicEvaluationSites.map(site => ({ kind: "dynamic-evaluation", site })),
  ];
  if (catalog.entries.length !== expectedSites.length) fail("review_site_coverage_invalid");
  const resources = new Map(), reviewed = [];
  for (const [index, entry] of catalog.entries.entries()) {
    const { site, kind } = expectedSites[index];
    if (!entry || entry.kind !== kind || entry.consumerPath !== site.consumerPath || entry.consumerChecksum !== site.consumerChecksum ||
      entry.start !== site.start || entry.end !== site.end || entry.argumentsChecksum !== checksum(JSON.stringify(site.arguments))) fail("review_site_binding_invalid");
    const policy = policies.get(entry.classification);
    if (!policy || policy.kind !== kind || entry.requiredRuntimeControl !== policy.control ||
      !Array.isArray(entry.targets) || (policy.resources ? entry.targets.length < 1 : entry.targets.length !== 0) ||
      entry.targets.length > 1_000 || !Array.isArray(entry.prerequisites) ||
      JSON.stringify(entry.prerequisites) !== JSON.stringify(policy.prerequisites) ||
      typeof entry.reason !== "string" || entry.reason.length < 8 || entry.reason.length > 2_000) fail("review_policy_invalid");
    const targets = [], targetAliases = new Set();
    for (const path of entry.targets) {
      if (!canonicalPath(path) || targetAliases.has(alias(path)) || !files.has(path)) fail("review_target_invalid");
      targetAliases.add(alias(path));
      if (!resources.has(path)) {
        const actual = await readRecord(join(root, path)).catch(error => {
          if (error.code === "ENOENT") fail(`resource_missing:${path}`);
          throw error;
        });
        const expected = files.get(path);
        if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) fail(`resource_mismatch:${path}`);
        resources.set(path, { path, checksum: actual.checksum, sizeBytes: actual.sizeBytes });
      }
      targets.push(resources.get(path));
    }
    reviewed.push({ ...entry, targets, runtimeControlAcceptance: "pending" });
  }
  for (const expected of [...calls.scripts, ...resources.values()]) {
    const actual = await readRecord(join(root, expected.path));
    if (actual.checksum !== expected.checksum || actual.sizeBytes !== expected.sizeBytes) fail(`verified_input_changed:${expected.path}`);
  }
  for (const [path, expected] of [[reviewPath, reviewInput], [manifestPath, manifestInput], [scriptFile, ownInput],
    [resolve(options.parserPath), { checksum: calls.parser.checksum }],
    ...calls.toolInputs.map(input => [fileURLToPath(new URL(`./${input.path}`, import.meta.url)), input])]) {
    if ((await readRecord(path)).checksum !== expected.checksum) fail("verified_tool_changed");
  }
  const toolInputs = [...calls.toolInputs,
    { path: "verify-reviewed-shell-dependencies.mjs", checksum: ownInput.checksum, sizeBytes: ownInput.sizeBytes },
    { path: "reviewed-shell-dependencies.json", checksum: reviewInput.checksum, sizeBytes: reviewInput.sizeBytes }];
  const sourceSites = reviewed.filter(site => site.kind === "source");
  const dynamicEvaluationSites = reviewed.filter(site => site.kind === "dynamic-evaluation");
  const sortedResources = [...resources.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { schemaVersion: 1, deliveryStage: "resource-prerequisites", validationMode: "static-review-only",
    sourceSiteReview: "classified", dynamicSiteReview: "classified", dependencyClosure: "pending",
    hostAcceptance: "pending", packageAcceptance: "pending", releaseEligible: false,
    upstreamRevision: calls.upstreamRevision, sourceManifestChecksum: calls.sourceManifestChecksum,
    reviewChecksum: reviewInput.checksum, callGraphChecksum: calls.callGraphChecksum,
    sourceSiteGraphChecksum: calls.sourceSiteGraphChecksum, dynamicSiteGraphChecksum,
    sourceSites, dynamicEvaluationSites, reviewGraphChecksum: checksum(JSON.stringify(reviewed)),
    resources: sortedResources, resourceGraphChecksum: checksum(JSON.stringify(sortedResources)),
    unresolvedCommandExpressions: calls.unresolvedCommandSites.length,
    callSiteToolInputGraphChecksum: calls.toolInputGraphChecksum, toolInputs, toolInputGraphChecksum: checksum(JSON.stringify(toolInputs)),
    pendingGates: ["indirect-command-and-resource-closure", "runtime-expression-and-owned-root-adaptation",
      "generated-state-and-environment-adaptation", "real-runtime-policy-enforcement", "redistribution-review",
      "native-windows-validation", "real-skill-execution", "installed-client-acceptance"] };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  const [runtimeRoot, parserPath, expectedParserChecksum, reportPath, shellPath = "/bin/bash"] = process.argv.slice(2);
  if (!runtimeRoot || !parserPath || !reportPath) throw new Error("Usage: node verify-reviewed-shell-dependencies.mjs <runtime-root> <parser-path> <parser-sha256> <report-path> [bash-path]");
  const catalog = JSON.parse((await readRecord(reviewFile, { retain: true })).bytes);
  const interpreter = await realpath(shellPath);
  const report = await verifyReviewedGstackShellDependencies({ runtimeRoot, parserPath, expectedParserChecksum,
    expectedSourceManifestChecksum: catalog.sourceManifestChecksum, expectedUpstreamRevision: catalog.upstreamRevision,
    shellPath: interpreter, expectedShellChecksum: (await readRecord(interpreter)).checksum });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ receiptChecksum: checksum(bytes), sourceSites: report.sourceSites.length,
    dynamicEvaluationSites: report.dynamicEvaluationSites.length, resources: report.resources.length,
    unresolvedCommandExpressions: report.unresolvedCommandExpressions, reviewGraphChecksum: report.reviewGraphChecksum,
    releaseEligible: report.releaseEligible }));
}
