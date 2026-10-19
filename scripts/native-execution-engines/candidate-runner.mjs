import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSnapshot } from "./snapshot.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = code => Object.assign(new Error(code), { code });

function readCurrentFile(path, limit) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > limit) throw failure("candidate_identity_changed");
    const buffer = Buffer.alloc(limit + 1);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fstatSync(descriptor);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw failure("candidate_identity_changed");
    return buffer.subarray(0, length);
  } finally { closeSync(descriptor); }
}

/** Candidate reports cannot be imported by the production acceptance store. */
export async function runCandidate({ input, credential, output, configurationPath, configurationBytes }) {
  try { await lstat(output); throw failure("candidate_output_exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const parent = await realpath(dirname(output));
  const canonicalOutput = join(parent, basename(output));
  const outputRelative = relative(resolve(repository), canonicalOutput);
  if (!(outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative))) throw failure("candidate_output_invalid");
  await mkdir(canonicalOutput, { mode: 0o700 });
  const outputInfo = await lstat(canonicalOutput);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()
    || process.platform !== "win32" && ((outputInfo.mode & 0o077) !== 0 || outputInfo.uid !== process.getuid?.())) {
    throw failure("candidate_output_invalid");
  }
  const receipts = [];
  const record = async (name, value) => {
    if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(name)) throw failure("candidate_record_invalid");
    const filename = name.endsWith(".json") ? name : `${name}.json`;
    const redact = value => typeof value === "string" ? value.split(credential).join("[REDACTED]")
      : Array.isArray(value) ? value.map(redact) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)])) : value;
    const bytes = `${JSON.stringify(redact(value), null, 2)}\n`;
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw failure("candidate_record_too_large");
    await writeFile(join(canonicalOutput, filename), bytes, { flag: "wx", mode: 0o600 });
    receipts.push({ path: filename, sha256: hash(bytes) });
  };
  const report = {
    schemaVersion: 1, kind: "native-engine-candidate-report", startedAt: new Date().toISOString(),
    engine: "codex-app-server", surface: "normal_conversation", platform: process.platform, architecture: process.arch,
    productionCertification: false, published: false, status: "incomplete", receipts,
    sourceBuildCorrespondence: "not_established_by_this_tool", dependencyBytes: "lockfile_only",
    productionAdmission: "not_run", resourceAdmission: "not_run",
    release: Object.fromEntries(["protocol", "permissions", "workspace", "artifacts", "cancellation", "recovery", "real_runtime", "packaged"]
      .map(check => [check, { status: "not_run", reason: "required_scene_not_completed", evidence: [] }])),
    host: Object.fromEntries(["installation", "authentication", "connection", "workspace_binding"]
      .map(check => [check, { status: "not_run", reason: "required_scene_not_completed", evidence: [] }])),
    cleanup: { temporaryRootRemoved: false, allChildrenClosed: true, allLifetimesDrained: true },
  };
  let root, profiles, before, executablePath, digest, profile, home, expectedConfig, expectedAuth;
  let childrenConfirmed = true, executionDrained = true;
  let environmentRestorationDeferred = false;
  const abort = new AbortController();
  const stop = () => abort.abort();
  const deadline = setTimeout(stop, 8 * 60_000);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const oldHome = process.env.LING_STACK_HOME;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "ling-native-candidate-")));
    report.temporaryRoot = root;
    process.env.LING_STACK_HOME = join(root, "ling");
    await mkdir(join(root, "workspace"), { mode: 0o700 });
    const workspace = await realpath(join(root, "workspace"));
    executablePath = await realpath(input.executablePath);
    // Hash and execute the platform binary itself, never only an npm/shell launcher.
    const descriptor = await open(executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await descriptor.stat();
      if (!info.isFile() || info.size < 4 || info.size > 512 * 1024 * 1024) throw failure("candidate_native_binary_required");
      const header = Buffer.alloc(4);
      await descriptor.read(header, 0, header.length, 0);
      const allowed = process.platform === "darwin" ? ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"]
        : process.platform === "linux" ? ["7f454c46"] : [];
      if (!allowed.includes(header.toString("hex"))) throw failure("candidate_native_binary_required");
      const binaryHash = createHash("sha256");
      for await (const bytes of descriptor.createReadStream({ start: 0, autoClose: false, signal: abort.signal })) binaryHash.update(bytes);
      const after = await descriptor.stat(), current = await lstat(executablePath);
      if (info.dev !== after.dev || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs
        || !current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) {
        throw failure("candidate_identity_changed");
      }
      digest = binaryHash.digest("hex");
    } finally { await descriptor.close(); }
    before = await captureSnapshot(repository);
    await record("source-build-before", before);
    const { ExecutionEngineProfileStore, resolveUserConfigPaths } = await import("../../packages/core/dist/index.js");
    const { executableDigest } = await import("../../packages/daemon/dist/features/execution-engines/connection-probe.js");
    const { probeEngineInstallation } = await import("../../packages/daemon/dist/features/execution-engines/installation-probe.js");
    if (await executableDigest(executablePath, abort.signal) !== digest) throw failure("candidate_identity_changed");
    const paths = resolveUserConfigPaths({ userRootDir: join(root, "ling") });
    profiles = new ExecutionEngineProfileStore(paths);
    profile = profiles.save({ engineId: "codex-app-server", executablePath, authProfileId: "isolated-candidate" }, 0);
    home = profiles.getAuthProfileDirectory(profile);
    await mkdir(home, { recursive: true, mode: 0o700 });
    // Fixed provider auth mode was exercised by the isolated real-Codex harness.
    // Copy no user plugins, MCP servers, hooks, accounts or global configuration.
    expectedConfig = [
      `model = ${JSON.stringify(input.model)}`, `model_provider = ${JSON.stringify(input.provider)}`,
      'model_reasoning_effort = "low"', 'cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false',
      `[model_providers.${input.provider}]`,
      ...Object.entries(input.providerConfiguration).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
      "requires_openai_auth = true", "",
    ].join("\n");
    expectedAuth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: credential });
    await writeFile(join(home, "config.toml"), expectedConfig, { flag: "wx", mode: 0o600 });
    await writeFile(join(home, "auth.json"), expectedAuth, { flag: "wx", mode: 0o600 });
    const assertCurrentAuthority = () => {
      abort.signal.throwIfAborted();
      profiles.assertCurrentAuthProfile(profile);
      for (const [path, expected] of [[join(home, "config.toml"), expectedConfig], [join(home, "auth.json"), expectedAuth],
        [configurationPath, configurationBytes]]) {
        if (!readCurrentFile(path, 32 * 1024).equals(Buffer.from(expected))) throw failure("candidate_identity_changed");
      }
      if (process.env[input.credentialEnvironment] !== credential) throw failure("candidate_identity_changed");
    };
    report.identity = { executablePath, executableDigest: digest, model: input.model, provider: input.provider,
      providerConfigurationFingerprint: hash(JSON.stringify(input.providerConfiguration)), profileId: profile.id,
      profileRevision: profile.revision, profileFingerprint: profile.configurationFingerprint, workspace,
      sourceSnapshot: before.fingerprint, sdkVersion: "codex-app-server-schema-v2", adapterVersion: "codex-app-server:native-adapter-v1" };
    const installation = await probeEngineInstallation(profile, { signal: abort.signal });
    await record("installation", installation);
    report.host.installation = { status: installation.status === "installed" && installation.executableDigest === digest ? "passed" : "failed",
      reason: installation.status, evidence: ["installation.json"] };
    report.identity.runtimeVersion = installation.runtimeVersion;
    if (report.host.installation.status !== "passed") throw failure("candidate_installation_failed");
    const { runCodexScenarios } = await import("./codex-scenarios.mjs");
    childrenConfirmed = false; executionDrained = false;
    const scenarios = await runCodexScenarios({ root, workspace, paths, profiles, profile,
      executablePath, executableDigest: digest, model: input.model, provider: input.provider, signal: abort.signal, record,
      assertCurrentAuthority, extraSecrets: [credential] });
    childrenConfirmed = scenarios.allChildrenClosed === true && scenarios.allLifetimesDrained === true;
    await record("scenarios", scenarios);
    report.cleanup.allChildrenClosed = childrenConfirmed;
    report.cleanup.allLifetimesDrained = scenarios.allLifetimesDrained === true;
    report.unresolvedSubmissionCount = scenarios.unresolvedSubmissionCount;
    executionDrained = childrenConfirmed && scenarios.unresolvedSubmissionCount === 0;
    report.cleanup.executionDrained = executionDrained;
    const observations = scenarios.observations;
    if (observations.connection) report.host.connection = observations.connection;
    // Owned-execution scenes cover part of each release check. They do not run
    // production input preparation, concurrency/resource admission or packaged Main.
    report.candidateObservations = observations;
    if (Object.values(observations).some(check => check.status === "failed")) report.status = "failed";
    if (!childrenConfirmed || scenarios.unresolvedSubmissionCount !== 0) throw failure("candidate_execution_not_drained");
    const { runProductionRejection } = await import("./production-rejection.mjs");
    childrenConfirmed = false; executionDrained = false; environmentRestorationDeferred = true;
    const productionRejection = await runProductionRejection({ root, paths, profile, model: input.model, provider: input.provider,
      signal: abort.signal, record, assertCurrentAuthority });
    environmentRestorationDeferred = productionRejection.environmentRestorationDeferred === true;
    if (environmentRestorationDeferred && productionRejection.drainCompletion) {
      productionRejection.drainCompletion.then(clean => {
        if (!clean || process.env.LING_STACK_HOME !== join(root, "ling")) return;
        if (oldHome === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = oldHome;
      }, () => {});
    }
    childrenConfirmed = productionRejection.allChildrenClosed === true && productionRejection.allLifetimesDrained === true;
    executionDrained = childrenConfirmed && productionRejection.unresolvedSubmissionCount === 0;
    report.cleanup.allLifetimesDrained = productionRejection.allLifetimesDrained === true;
    report.cleanup.executionDrained = executionDrained;
    report.cleanup.environmentRestorationDeferred = environmentRestorationDeferred;
    report.unresolvedSubmissionCount = productionRejection.unresolvedSubmissionCount === null ? null
      : scenarios.unresolvedSubmissionCount + productionRejection.unresolvedSubmissionCount;
    report.candidateObservations.productionRejection = productionRejection.observation;
    if (productionRejection.observation.status === "failed") report.status = "failed";
    if (!executionDrained) throw failure("candidate_execution_not_drained");
    assertCurrentAuthority();
    if (await realpath(input.executablePath) !== executablePath || await executableDigest(executablePath, abort.signal) !== digest) {
      throw failure("candidate_identity_changed");
    }
  } catch (error) {
    report.status = "failed";
    const codes = ["candidate_installation_failed", "candidate_execution_not_drained", "candidate_identity_changed", "candidate_record_too_large", "candidate_native_binary_required"];
    report.failure = codes.includes(error.code) ? error.code : abort.signal.aborted ? "candidate_aborted" : "candidate_execution_failed";
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (before) {
      try {
        const after = await captureSnapshot(repository);
        await record("source-build-after", after);
        report.sourceAndBuildUnchanged = before.fingerprint === after.fingerprint;
        if (!report.sourceAndBuildUnchanged) { report.status = "failed"; report.failure = "candidate_source_build_changed"; }
      } catch { report.status = "failed"; report.failure = "candidate_snapshot_failed"; }
    }
    if (childrenConfirmed) { try { profiles?.close(); } catch { childrenConfirmed = false; } }
    report.cleanup.allChildrenClosed = childrenConfirmed;
    if (root && childrenConfirmed && executionDrained) {
      try { await rm(root, { recursive: true, force: true }); report.cleanup.temporaryRootRemoved = true; }
      catch { report.status = "failed"; report.failure = "candidate_cleanup_failed"; }
    } else if (root) { report.status = "failed"; report.failure = "candidate_cleanup_unconfirmed"; }
    if (!environmentRestorationDeferred) {
      if (oldHome === undefined) delete process.env.LING_STACK_HOME; else process.env.LING_STACK_HOME = oldHome;
    }
  }
  if (Object.values(report.release).concat(Object.values(report.host)).some(check => check.status === "failed")) report.status = "failed";
  report.release.packaged.reason = "signed_target_package_and_packaged_engine_scene_unavailable";
  report.host.authentication.reason = "connection_probe_is_not_authenticated_model_identity_proof";
  report.completedAt = new Date().toISOString();
  await record("report", { ...report, receipts: [...receipts] });
  return { status: report.status, productionCertification: false, published: false,
    report: join(canonicalOutput, "report.json"), temporaryRootRemoved: report.cleanup.temporaryRootRemoved };
}
