import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGstackShellCallSites } from "./inspect-shell-call-sites.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

export const PINNED_SHELL_COMMAND_REVIEW_CHECKSUM = "sha256:ce6d9b4db29766e9a4fe4ca56ff13e6983104f07fb38b533cda309fc5c13e947";
const reviewFile = fileURLToPath(new URL("./reviewed-shell-commands.json", import.meta.url));
const scriptFile = fileURLToPath(import.meta.url);
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const validChecksum = value => /^sha256:[a-f0-9]{64}$/.test(value ?? "");
const fail = reason => { throw new Error(`gstack_shell_command_${reason}`); };
const readRecord = (path, options = {}) => readGstackClosureFileRecord(path, { ...options, errorPrefix: "gstack_shell_command" });
const canonicalPath = path => typeof path === "string" && path.length > 0 && !posix.isAbsolute(path) && !win32.isAbsolute(path) &&
  !/[\\:\0]/.test(path) && !path.split("/").some(part => !part || part === "." || part === "..");
const alias = path => path.normalize("NFKC").toLowerCase();
const policies = new Map([
  ["bundled-command", { control: "frozen-bundle-command", resources: true, prerequisites: [] }],
  ["bun-runtime", { control: "verified-owned-bun", prerequisites: ["verified-packaged-bun"] }],
  ["timeout-wrapper", { control: "owned-process-deadline", prerequisites: ["owned-process-supervision"] }],
  ["forwarded-command", { control: "approved-exact-command", prerequisites: ["explicit-command-and-external-effects-approval"] }],
  ["configured-engine", { control: "configured-engine-identity", prerequisites: ["configured-claude-engine", "owned-process-supervision"] }],
  ["python-runtime", { control: "verified-owned-python", prerequisites: ["verified-python-runtime"] }],
  ["shell-runtime", { control: "verified-owned-shell", prerequisites: ["verified-shell-runtime", "owned-hook-inputs"] }],
  ["launch-probe", { control: "verified-owned-launch-target", prerequisites: ["verified-launch-target", "owned-process-supervision"] }],
  ["boolean-command", { control: "structured-boolean-state", prerequisites: ["owned-typed-state"], choices: true }],
  ["service-command", { control: "approved-owned-service-command", prerequisites: ["configured-gbrain-service", "explicit-service-sync-approval"] }],
  ["native-compiler", { control: "verified-owned-native-compiler", resources: true, prerequisites: ["verified-native-build-toolchain"] }],
  ["powershell-build", { control: "verified-owned-powershell-build", resources: true, prerequisites: ["verified-windows-build-toolchain"] }],
  ["generated-program", { control: "verified-owned-program", resources: true, products: true,
    prerequisites: ["verified-generated-program", "native-platform-acceptance"] }],
  ["font-cache-command", { control: "approved-font-cache-operation", prerequisites: ["explicit-system-font-operation-approval"] }],
  ["function-dispatch", { control: "bounded-owned-function-dispatch", resources: true, choices: true,
    prerequisites: ["owned-runtime-root-transaction"] }],
]);

// Review original call bytes and dependencies, never evaluate variable paths or
// confuse a generated program's source provenance with its executable identity.
export async function verifyReviewedGstackShellCommands(options) {
  const reviewPath = resolve(options.commandReviewPath ?? reviewFile);
  const expectedReviewChecksum = options.expectedCommandReviewChecksum ??
    (reviewPath === reviewFile ? PINNED_SHELL_COMMAND_REVIEW_CHECKSUM : undefined);
  if (!validChecksum(expectedReviewChecksum)) fail("review_checksum_required");
  const ownInput = await readRecord(scriptFile);
  const reviewInput = await readRecord(reviewPath, { retain: true, maximumBytes: 2 * 1024 * 1024 });
  if (reviewInput.checksum !== expectedReviewChecksum) fail("review_mismatch");
  let catalog;
  try { catalog = JSON.parse(reviewInput.bytes.toString("utf8")); }
  catch { fail("review_identity_invalid"); }
  const calls = await inspectGstackShellCallSites(options);
  const commandSiteGraphChecksum = checksum(JSON.stringify(calls.unresolvedCommandSites));
  if (catalog?.schemaVersion !== 1 || catalog.reviewStatus !== "reviewed-command-expression-mappings" || catalog.releaseEligible !== false ||
    catalog.upstreamRevision !== calls.upstreamRevision || catalog.sourceManifestChecksum !== calls.sourceManifestChecksum ||
    catalog.callGraphChecksum !== calls.callGraphChecksum || catalog.commandSiteGraphChecksum !== commandSiteGraphChecksum ||
    !Array.isArray(catalog.entries)) fail("review_identity_invalid");
  const root = await realpath(resolve(options.runtimeRoot)), manifestPath = join(dirname(root), "source-manifest.json");
  const manifestInput = await readRecord(manifestPath, { retain: true, maximumBytes: 16 * 1024 * 1024 });
  if (manifestInput.checksum !== calls.sourceManifestChecksum) fail("source_manifest_changed");
  const manifest = JSON.parse(manifestInput.bytes.toString("utf8")), files = new Map(), fileAliases = new Set();
  if (!Array.isArray(manifest.files)) fail("source_manifest_invalid");
  for (const file of manifest.files) {
    if (!canonicalPath(file.path) || !validChecksum(file.checksum) || !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 || fileAliases.has(alias(file.path))) fail("source_manifest_invalid");
    fileAliases.add(alias(file.path));
    if (file.path.startsWith("runtime/")) files.set(file.path.slice(8), file);
  }
  const groups = new Map();
  for (const site of calls.unresolvedCommandSites) {
    const raw = site.arguments[0].raw;
    groups.set(raw, [...(groups.get(raw) ?? []), site]);
  }
  if (catalog.entries.length !== groups.size) fail("review_coverage_invalid");
  const resources = new Map(), entries = [], seen = new Set();
  for (const entry of catalog.entries) {
    const sites = groups.get(entry?.commandRaw);
    if (!sites || seen.has(entry.commandRaw) || entry.siteCount !== sites.length ||
      entry.siteGraphChecksum !== checksum(JSON.stringify(sites))) fail("review_binding_invalid");
    seen.add(entry.commandRaw);
    const policy = policies.get(entry.classification);
    if (!policy || entry.requiredRuntimeControl !== policy.control ||
      !Array.isArray(entry.prerequisites) || JSON.stringify(entry.prerequisites) !== JSON.stringify(policy.prerequisites) ||
      !Array.isArray(entry.targets) || entry.targets.length > 1_000 || policy.resources && !entry.targets.length ||
      !Array.isArray(entry.products) || entry.products.length > 100 ||
      (policy.products ? !entry.products.length : Boolean(entry.products.length)) ||
      entry.products.some(path => !canonicalPath(path)) || new Set(entry.products.map(alias)).size !== entry.products.length ||
      !Array.isArray(entry.choices) || entry.choices.length > 100 ||
      (policy.choices ? !entry.choices.length : Boolean(entry.choices.length)) ||
      entry.choices.some(value => typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) ||
      new Set(entry.choices).size !== entry.choices.length ||
      entry.classification === "boolean-command" && JSON.stringify(entry.choices) !== '["true","false"]' ||
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
    entries.push({ ...entry, targets, runtimeControlAcceptance: "pending" });
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
    { path: "verify-reviewed-shell-commands.mjs", checksum: ownInput.checksum, sizeBytes: ownInput.sizeBytes },
    { path: "reviewed-shell-commands.json", checksum: reviewInput.checksum, sizeBytes: reviewInput.sizeBytes }];
  const sortedResources = [...resources.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { schemaVersion: 1, deliveryStage: "resource-prerequisites", validationMode: "static-review-only",
    commandExpressionReview: "classified", commandExpressionCount: calls.unresolvedCommandSites.length,
    commandGroupCount: entries.length, dependencyClosure: "pending", hostAcceptance: "pending", packageAcceptance: "pending", releaseEligible: false,
    upstreamRevision: calls.upstreamRevision, sourceManifestChecksum: calls.sourceManifestChecksum,
    reviewChecksum: reviewInput.checksum, callGraphChecksum: calls.callGraphChecksum, commandSiteGraphChecksum,
    entries, reviewGraphChecksum: checksum(JSON.stringify(entries)), resources: sortedResources,
    resourceGraphChecksum: checksum(JSON.stringify(sortedResources)),
    toolInputs, toolInputGraphChecksum: checksum(JSON.stringify(toolInputs)),
    pendingGates: ["literal-wrapper-and-interpreter-resource-closure", "runtime-expression-and-owned-root-adaptation",
      "real-runtime-policy-enforcement", "generated-program-identity-and-native-acceptance", "redistribution-review",
      "native-windows-validation", "real-skill-execution", "installed-client-acceptance"] };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  const [runtimeRoot, parserPath, expectedParserChecksum, reportPath, shellPath = "/bin/bash"] = process.argv.slice(2);
  if (!runtimeRoot || !parserPath || !reportPath) throw new Error("Usage: node verify-reviewed-shell-commands.mjs <runtime-root> <parser-path> <parser-sha256> <report-path> [bash-path]");
  const catalog = JSON.parse((await readRecord(reviewFile, { retain: true })).bytes);
  const interpreter = await realpath(shellPath);
  const report = await verifyReviewedGstackShellCommands({ runtimeRoot, parserPath, expectedParserChecksum,
    expectedSourceManifestChecksum: catalog.sourceManifestChecksum, expectedUpstreamRevision: catalog.upstreamRevision,
    shellPath: interpreter, expectedShellChecksum: (await readRecord(interpreter)).checksum });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ receiptChecksum: checksum(bytes), expressions: report.commandExpressionCount,
    groups: report.commandGroupCount, resources: report.resources.length, reviewGraphChecksum: report.reviewGraphChecksum, releaseEligible: false }));
}
