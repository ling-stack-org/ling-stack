import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ExecutionEngineConnectionProbe, ExecutionEngineProfile } from "@ling-stack/contracts";
import type { ExecutionEngineProfileStore, LingStackUserConfigPaths, SecretResolver } from "@ling-stack/core";
import { inspectCodexConnection, NativeConnectionError } from "./codex-connection.js";
import { probeEngineInstallation } from "./installation-probe.js";
import { withOwnedNativeProcess, type OwnedNativeStreams } from "./owned-native-process.js";
import { prepareNativeAuthHome } from "./native-auth-home.js";
import { assertCodexApiKey } from "./codex-auth-state.js";
import { assertKimiApiKey } from "./kimi-auth-state.js";
import { EngineCredentialError, resolveEngineSecret } from "./native-secrets.js";
import { inspectKimiConnection } from "./kimi-connection.js";
import { kimiNativeEnvironment, prepareKimiNativeExecutable, verifyKimiNativeExecutable } from "./kimi-native-executable.js";
import { inspectAcpConnection } from "./acp-connection.js";
import { openclawProcessEnvironment, writeOpenClawProbeCredential } from "./openclaw-environment.js";
import { claudeCliRuntimeVersion } from "./claude-environment.js";
import { prepareOwnedNativeSpawn } from "./windows-supervisor.js";
import { prepareKimiConnectionProbe } from "./kimi-probe-isolation.js";

type Status = ExecutionEngineConnectionProbe["status"];

export async function probeEngineConnection(profile: ExecutionEngineProfile, paths: LingStackUserConfigPaths, options: {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly spawn?: typeof spawn;
  readonly platform?: NodeJS.Platform;
  readonly secretResolver?: SecretResolver;
  readonly store?: ExecutionEngineProfileStore;
} = {}): Promise<ExecutionEngineConnectionProbe> {
  const result = (status: Status, extra: Partial<ExecutionEngineConnectionProbe> = {}): ExecutionEngineConnectionProbe => ({
    mode: "connection", profileId: profile.id, profileRevision: profile.revision,
    configurationFingerprint: profile.configurationFingerprint, checkedAt: new Date().toISOString(),
    status, authentication: "not_checked", connection: "not_checked", ...extra,
  });
  if (options.signal?.aborted) return result("cancelled");
  const isKimi = profile.configuration.engineId === "kimi-acp";
  const isOpenClaw = profile.configuration.engineId === "openclaw-acp";
  const isClaude = profile.configuration.engineId === "claude-agent-sdk";
  if (profile.configuration.engineId !== "codex-app-server" && !isKimi && !isOpenClaw && !isClaude) return result("unsupported_engine");
  // Windows must have verified child-tree supervision before a long-lived native process starts.
  if ((options.platform ?? process.platform) === "win32") return result("unsupported_platform");
  if (isKimi && (options.platform ?? process.platform) !== "darwin") return result("unsupported_platform");
  if (isKimi && profile.configuration.secretRef && !profile.configuration.kimi) return result("unsupported_auth");
  if (isOpenClaw && (!profile.configuration.openclaw || !profile.configuration.secretRef)) return result("unsupported_auth");
  if (isClaude && !profile.configuration.secretRef) return result("unsupported_auth");
  const deadline = new AbortController();
  const timeoutMs = options.timeoutMs ?? 7000;
  const began = performance.now();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])]);
  const cancelled = (): Status => options.signal?.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "probe_failed";
  const updateDeadline = (): void => { if (performance.now() - began >= timeoutMs) deadline.abort(); };
  const assertLive = (): void => { updateDeadline(); signal.throwIfAborted(); };
  let root: string | undefined;
  let kimiProbe: Awaited<ReturnType<typeof prepareKimiConnectionProbe>> | undefined;
  let identity: { runtimeVersion?: string; executableDigest?: string } = {};
  const cleanup = async (): Promise<void> => {
    const prepared = kimiProbe, directory = root;
    kimiProbe = undefined;
    root = undefined;
    try {
      if (prepared) await prepared.dispose();
      else if (directory) await rm(directory, { recursive: true, force: true });
    } catch { throw new NativeConnectionError("cleanup_failed"); }
  };
  try {
    const ref = profile.configuration.secretRef;
    const credential = ref ? resolveEngineSecret(ref, options.secretResolver) : undefined;
    assertLive();
    const installation = await probeEngineInstallation(profile, { signal, timeoutMs: 3000, spawn: options.spawn });
    assertLive();
    if (installation.status !== "installed") return result(installation.status);
    identity = { runtimeVersion: installation.runtimeVersion, executableDigest: installation.executableDigest };
    if (isClaude && installation.runtimeVersion !== claudeCliRuntimeVersion) return result("unexpected_runtime", identity);
    const executable = await realpath(profile.configuration.executablePath);
    if (await executableDigest(executable, signal) !== installation.executableDigest) return result("probe_failed", identity);
    const home = await prepareNativeAuthHome(paths, profile.configuration);
    if (isKimi && (!options.store || options.store.getAuthProfileDirectory(profile) !== home)) throw new EngineCredentialError("engine_native_auth_invalid");
    if (credential !== undefined && !isOpenClaw && !isClaude) {
      if (isKimi) await assertKimiApiKey(home, profile.configuration.kimi!, credential);
      else await assertCodexApiKey(home, credential);
    }
    assertLive();
    root = await mkdtemp(join(tmpdir(), "ling-native-connection-"));
    if (isKimi) root = await realpath(root);
    assertLive();
    const launchPath = isKimi ? await prepareKimiNativeExecutable(executable, root, installation.executableDigest!, signal) : executable;
    const launch = await prepareOwnedNativeSpawn(launchPath, installation.executableDigest!, options.spawn);
    assertLive();
    let state: Pick<ExecutionEngineConnectionProbe, "authentication" | "connection">;
    if (isClaude) {
      const { captureClaudeAccountOperation } = await import("./claude-connection.js");
      assertLive();
      state = await captureClaudeAccountOperation(executable, root, credential!, signal, launch);
    } else if (isOpenClaw) {
      const credentialFile = await writeOpenClawProbeCredential(root, credential!);
      assertLive();
      const authOption = profile.configuration.openclaw!.credentialType === "password" ? "--password-file" : "--token-file";
      state = await captureNativeAccountOperation(executable,
        ["acp", "--url", profile.configuration.openclaw!.gatewayUrl, authOption, credentialFile],
        openclawProcessEnvironment(root, home), root, signal, launch,
        (streams) => inspectAcpConnection({ ...streams, engineId: "openclaw-acp", expectedVersion: installation.runtimeVersion! }));
    } else {
      if (isKimi) kimiProbe = await prepareKimiConnectionProbe({ store: options.store!, profile, operationRoot: root,
        executable: launchPath, signal, launch });
      state = isKimi
        ? await captureKimiAccountOperation(launchPath, root, kimiProbe!.home, installation.runtimeVersion!, signal, kimiProbe!.launch)
        : await captureCodexAccountOperation(executable, root, home, signal, launch,
          (streams) => inspectCodexConnection({ ...streams, ...(credential === undefined ? {} : { expectedAuthentication: "apiKey" }) }));
    }
    assertLive();
    kimiProbe?.assertCurrent();
    if (credential !== undefined && isKimi && state.authentication !== "configured_unverified") throw new EngineCredentialError("engine_native_auth_mismatch");
    if (isKimi) await verifyKimiNativeExecutable(launchPath, installation.executableDigest!, signal);
    if (await realpath(profile.configuration.executablePath) !== executable
      || await executableDigest(executable, signal) !== installation.executableDigest) throw new NativeConnectionError("process_failed");
    const source = kimiProbe;
    await cleanup();
    assertLive();
    if (credential !== undefined) {
      if (isKimi) await assertKimiApiKey(home, profile.configuration.kimi!, credential);
      else if (!isOpenClaw && !isClaude) await assertCodexApiKey(home, credential);
      if (resolveEngineSecret(ref!, options.secretResolver) !== credential) throw new EngineCredentialError("engine_secret_changed");
    }
    assertLive();
    source?.assertSourceCurrent();
    return result("connected", { ...identity, ...state });
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { error = cleanupError; }
    updateDeadline();
    if (error instanceof NativeConnectionError && error.code === "cleanup_failed") return result("probe_failed", identity);
    if (!signal.aborted && error instanceof EngineCredentialError) {
      return result("auth_required", { ...identity, authentication: "required", errorCode: error.code });
    }
    if (!signal.aborted && error instanceof NativeConnectionError && error.code === "auth_required") {
      return result("auth_required", { ...identity, authentication: "required", errorCode: "engine_native_auth_mismatch" });
    }
    const status = signal.aborted ? cancelled() : error instanceof NativeConnectionError
      && (error.code === "protocol_error" || error.code === "output_limit") ? error.code : "probe_failed";
    return result(status, identity);
  } finally {
    clearTimeout(timer);
  }
}

export async function executableDigest(executable: string, signal: AbortSignal): Promise<string> {
  const before = await stat(executable);
  if (!before.isFile() || before.size > 512 * 1024 * 1024) throw new Error("engine_executable_invalid");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable, { signal })) hash.update(chunk);
  const after = await stat(executable);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("engine_executable_changed");
  }
  return hash.digest("hex");
}

export async function captureCodexAccountOperation<T>(executable: string, root: string, home: string, signal: AbortSignal, launch: typeof spawn,
  operation: (streams: { readonly input: Writable; readonly output: Readable; readonly codexHome: string; readonly signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  return captureNativeAccountOperation(executable, ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"',
    "-c", "check_for_update_on_startup=false"], { CODEX_HOME: home }, root, signal, launch,
    (streams) => operation({ ...streams, codexHome: home }));
}

export function captureKimiAccountOperation(executable: string, root: string, home: string, expectedVersion: string, signal: AbortSignal, launch: typeof spawn) {
  return captureNativeAccountOperation(executable, ["acp"], kimiNativeEnvironment(root, home), root, signal, launch,
    (streams) => inspectKimiConnection({ ...streams, expectedVersion }));
}

async function captureNativeAccountOperation<T>(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv,
  root: string, signal: AbortSignal, launch: typeof spawn,
  operation: (streams: OwnedNativeStreams) => Promise<T>,
): Promise<T> {
  return withOwnedNativeProcess({ executable, args, environment, root, signal, launch }, operation);
}
