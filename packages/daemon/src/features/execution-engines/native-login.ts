import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEngineLoginChallenge, ExecutionEngineLoginMethod, ExecutionEngineProfile,
  ExecutionEngineProfileConfiguration } from "@ling-stack/contracts";
import type { LingStackUserConfigPaths, SecretResolver } from "@ling-stack/core";
import { NativeConnectionError } from "./codex-connection.js";
import { loginCodexAccount } from "./codex-login.js";
import { captureCodexAccountOperation, captureKimiAccountOperation, executableDigest } from "./connection-probe.js";
import { probeEngineInstallation } from "./installation-probe.js";
import { prepareNativeAuthHome } from "./native-auth-home.js";
import { EngineCredentialError, resolveEngineSecret } from "./native-secrets.js";
import { assertKimiApiKey, writeKimiApiKey } from "./kimi-auth-state.js";
import { prepareKimiNativeExecutable, verifyKimiNativeExecutable } from "./kimi-native-executable.js";
import { runKimiTerminalLogin } from "./kimi-terminal-login.js";
import { claudeCliRuntimeVersion } from "./claude-environment.js";
import { prepareOwnedNativeSpawn } from "./windows-supervisor.js";

export class EngineLoginError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function assertNativeLoginSupported(profile: ExecutionEngineProfile, method: ExecutionEngineLoginMethod, platform = process.platform): void {
  const isKimi = profile.configuration.engineId === "kimi-acp";
  const isClaude = profile.configuration.engineId === "claude-agent-sdk";
  if (profile.configuration.engineId !== "codex-app-server" && !isKimi && !isClaude) throw new EngineLoginError("engine_login_unsupported_engine");
  if (platform === "win32") throw new EngineLoginError("engine_login_unsupported_platform");
  if (isClaude) {
    if (method !== "apiKey") throw new EngineLoginError("engine_login_method_unavailable");
    if (!profile.configuration.secretRef) throw new EngineLoginError("engine_login_unsupported_auth");
    return;
  }
  if (isKimi) {
    if (method === "terminal") {
      if (profile.configuration.secretRef) throw new EngineLoginError("engine_login_unsupported_auth");
      if (!profile.configuration.kimiLoginRegion) throw new EngineLoginError("engine_login_configuration_required");
      return;
    }
    if (method !== "apiKey") throw new EngineLoginError("engine_login_method_unavailable");
    if (!profile.configuration.secretRef) throw new EngineLoginError("engine_login_unsupported_auth");
    if (!profile.configuration.kimi) throw new EngineLoginError("engine_login_configuration_required");
    return;
  }
  // Pinned browser startup can cancel another process's callback listener. Device code does not bind that port.
  if (method !== "chatgptDeviceCode" && method !== "apiKey") throw new EngineLoginError("engine_login_method_unavailable");
  if ((method === "apiKey") !== Boolean(profile.configuration.secretRef)) throw new EngineLoginError("engine_login_unsupported_auth");
}

export async function runEngineLogin(profile: ExecutionEngineProfile, paths: LingStackUserConfigPaths, options: {
  readonly method: ExecutionEngineLoginMethod;
  readonly signal: AbortSignal;
  readonly onChallenge: (challenge: ExecutionEngineLoginChallenge) => void;
  /** Must synchronously recheck authority/revision/references before adopting the completed generation. */
  readonly adopt: (configuration: ExecutionEngineProfileConfiguration) => ExecutionEngineProfile;
  readonly spawn?: typeof spawn;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly secretResolver?: SecretResolver;
}): Promise<ExecutionEngineProfile> {
  if (options.signal.aborted) throw new EngineLoginError("engine_login_cancelled");
  assertNativeLoginSupported(profile, options.method, options.platform);
  const isKimi = profile.configuration.engineId === "kimi-acp";
  const isClaude = profile.configuration.engineId === "claude-agent-sdk";
  const deadline = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  const began = performance.now();
  let started = false;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const startupTimer = setTimeout(() => deadline.abort(), startupTimeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const updateDeadline = (): void => {
    const elapsed = performance.now() - began;
    if (elapsed >= timeoutMs || (!started && elapsed >= startupTimeoutMs)) deadline.abort();
  };
  const assertLive = (): void => { updateDeadline(); signal.throwIfAborted(); };
  let root: string | undefined;
  let home: string | undefined;
  let adopted = false;
  try {
    const apiKey = options.method === "apiKey" ? resolveEngineSecret(profile.configuration.secretRef!, options.secretResolver) : undefined;
    assertLive();
    const installation = await probeEngineInstallation(profile, { signal, timeoutMs: 3000, spawn: options.spawn });
    assertLive();
    if (installation.status !== "installed") throw new EngineLoginError(`engine_installation_${installation.status}`);
    if (isClaude && installation.runtimeVersion !== claudeCliRuntimeVersion) throw new EngineLoginError("engine_installation_unexpected_runtime");
    const executable = await realpath(profile.configuration.executablePath);
    if (await executableDigest(executable, signal) !== installation.executableDigest) throw new EngineLoginError("engine_executable_changed");
    const configuration = { ...profile.configuration, authProfileId: `login-${randomUUID()}` };
    home = await prepareNativeAuthHome(paths, configuration);
    root = await mkdtemp(join(tmpdir(), "ling-native-login-"));
    assertLive();
    const launchPath = isKimi ? await prepareKimiNativeExecutable(executable, root, installation.executableDigest!, signal) : executable;
    const launch = await prepareOwnedNativeSpawn(launchPath, installation.executableDigest!, options.spawn);
    assertLive();
    if (isClaude) {
      const { captureClaudeAccountOperation } = await import("./claude-connection.js");
      assertLive();
      await captureClaudeAccountOperation(executable, root, apiKey!, signal, launch);
      assertLive();
      started = true;
      clearTimeout(startupTimer);
    } else if (isKimi) {
      if (apiKey !== undefined) await writeKimiApiKey(home, configuration.kimi!, apiKey);
      assertLive();
      if (options.method === "terminal") {
        await runKimiTerminalLogin(launchPath, root, home, {
          region: configuration.kimiLoginRegion!, signal, spawn: launch,
          onStarted: () => { assertLive(); started = true; clearTimeout(startupTimer); },
          onOutput: (text) => { assertLive(); options.onChallenge({ type: "terminal", text }); },
        });
        assertLive();
        await verifyKimiNativeExecutable(launchPath, installation.executableDigest!, signal);
      }
      const state = await captureKimiAccountOperation(launchPath, root, home, installation.runtimeVersion!, signal, launch);
      assertLive();
      if (state.authentication !== "configured_unverified") throw new EngineCredentialError("engine_native_auth_mismatch");
      await verifyKimiNativeExecutable(launchPath, installation.executableDigest!, signal);
      started = true;
      clearTimeout(startupTimer);
    } else {
      const method = options.method;
      if (method === "terminal") throw new EngineLoginError("engine_login_method_unavailable");
      await captureCodexAccountOperation(executable, root, home, signal, launch, (streams) => loginCodexAccount({
        ...streams, method, apiKey, onStarted: () => { assertLive(); started = true; clearTimeout(startupTimer); }, onChallenge: (challenge) => {
          assertLive();
          options.onChallenge(challenge);
        },
      }));
    }
    assertLive();
    if (await realpath(profile.configuration.executablePath) !== executable
      || await executableDigest(executable, signal) !== installation.executableDigest) throw new EngineLoginError("engine_executable_changed");
    await rm(root, { recursive: true, force: true });
    root = undefined;
    assertLive();
    if (isKimi && apiKey !== undefined) await assertKimiApiKey(home, configuration.kimi!, apiKey);
    if (apiKey !== undefined && resolveEngineSecret(profile.configuration.secretRef!, options.secretResolver) !== apiKey) {
      throw new EngineLoginError("engine_secret_changed");
    }
    assertLive();
    const result = options.adopt(configuration);
    adopted = true;
    return result;
  } catch (error) {
    if (error instanceof NativeConnectionError && error.code === "cleanup_failed") throw new EngineLoginError("engine_login_cleanup_failed");
    updateDeadline();
    if (signal.aborted) throw new EngineLoginError(options.signal.aborted ? "engine_login_cancelled" : "engine_login_timed_out");
    if (error instanceof EngineCredentialError) throw new EngineLoginError(error.code);
    if (error instanceof NativeConnectionError) throw new EngineLoginError(`engine_login_${error.code}`);
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(startupTimer);
    let cleanupFailed = false;
    // Attempt both owned directories even if one fails; never downgrade cleanup failure to cancellation.
    for (const path of [root, adopted ? undefined : home]) {
      if (path) try { await rm(path, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new EngineLoginError("engine_login_cleanup_failed");
  }
}
