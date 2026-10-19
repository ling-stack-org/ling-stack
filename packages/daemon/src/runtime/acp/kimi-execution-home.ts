import { lstatSync, realpathSync, type Stats } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { readNativeAuthFile } from "../../features/execution-engines/native-auth-file.js";
import type { KimiActionPreparationOptions } from "./kimi-action-preparation.js";
import { openKimiModelTransport, type KimiModelAuthentication } from "./kimi-model-transport.js";
import type { NativeSecretRegistry } from "../adapters/native-stream-redaction.js";
import { normalizeKimiModelConfiguration } from "./kimi-model-configuration.js";

const stateDirectories = ["sessions", "store", "cache", "logs", "blobs"] as const;
const tools = { Bash: "bash", Read: "read", Write: "write", Edit: "edit" } as const;
const invalid = (): Error => new Error("kimi_execution_configuration_invalid");
type RecordValue = Record<string, unknown>;
type ProjectedConfiguration = RecordValue & { readonly tools: { readonly enabled: string[]; readonly disabled: string[] } };

/** Project a host-owned profile without changing its config or native session identity. */
export async function prepareKimiExecutionHome(sourceHome: string,
  policy: Pick<KimiActionPreparationOptions, "policy" | "effectivePolicySnapshot">, readOnly: boolean, signal: AbortSignal,
  options: { readonly modelId?: string; readonly assertCurrent?: () => void; readonly modelSignal?: AbortSignal;
    readonly assertPreparationCurrent?: () => void; readonly authentication?: KimiModelAuthentication;
    readonly secretRegistry?: NativeSecretRegistry } = {}) {
  let home: string | undefined;
  let transport: Awaited<ReturnType<typeof openKimiModelTransport>> | undefined;
  try {
    signal.throwIfAborted();
    options = { ...options, authentication: options.authentication ? { ...options.authentication,
      profile: structuredClone(options.authentication.profile) } : undefined };
    if (options.authentication && sourceHome !== options.authentication.store.getAuthProfileDirectory(options.authentication.profile)) throw invalid();
    const source = identity(sourceHome, true);
    const configPath = join(sourceHome, "config.toml"), configIdentity = identity(configPath, false);
    const original = await readNativeAuthFile(configPath);
    assertCurrent(configIdentity);
    const config = projectConfiguration(parse(original), policy, readOnly);
    const bindings: Identity[] = [];
    for (const name of stateDirectories) {
      const path = join(sourceHome, name);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
      bindings.push(identity(path, true));
    }
    assertCurrent(source);
    home = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-home-")));
    const projected = identity(home, true);
    const assertPreparationCurrent = (): void => {
      signal.throwIfAborted();
      if (options.authentication && sourceHome !== options.authentication.store.getAuthProfileDirectory(options.authentication.profile)) throw invalid();
      for (const target of [source, configIdentity, projected, ...bindings]) assertCurrent(target);
      options.assertPreparationCurrent?.();
    };
    transport = await openKimiModelTransport(config, { modelId: options.modelId, signal: options.modelSignal ?? signal,
      authentication: options.authentication, secretRegistry: options.secretRegistry, assertPreparationCurrent,
      assertCurrent: () => { assertUnchanged(); options.assertCurrent?.(); } });
    await writeFile(join(home, "config.toml"), stringify(transport.configuration), { mode: 0o400, flag: "wx" });
    const projectedConfig = identity(join(home, "config.toml"), false);
    for (const [index, binding] of bindings.entries()) await symlink(binding.path, join(home, stateDirectories[index]!), "junction");
    const assertUnchanged = (): void => {
      signal.throwIfAborted();
      if (options.authentication && sourceHome !== options.authentication.store.getAuthProfileDirectory(options.authentication.profile)) throw invalid();
      for (const target of [source, configIdentity, projected, projectedConfig, ...bindings]) assertCurrent(target);
      for (const [index, name] of stateDirectories.entries()) {
        const path = join(projected.path, name);
        if (!lstatSync(path).isSymbolicLink() || realpathSync(path) !== bindings[index]!.path) throw invalid();
      }
    };
    assertUnchanged();
    const model = transport;
    return { home, readOnly: config.default_plan_mode === true, modelRelayPort: model.relay.port, modelSecrets: model.secrets,
      secretRegistry: model.secretRegistry,
      enabledTools: config.tools.enabled.filter(tool => !config.tools.disabled.includes(tool)), assertUnchanged,
      dispose: async () => { try { await model.relay.close(); } finally { await rm(projected.path, { recursive: true, force: true }); } } };
  } catch {
    try { await transport?.relay.close(); } finally { if (home) await rm(home, { recursive: true, force: true }); }
    signal.throwIfAborted();
    throw invalid();
  }
}

function projectConfiguration(value: unknown, policy: Pick<KimiActionPreparationOptions, "policy" | "effectivePolicySnapshot">,
  readOnly: boolean): ProjectedConfiguration {
  if (!record(value) || !keys(value, ["default_model", "default_permission_mode", "default_plan_mode", "telemetry",
    "merge_all_available_skills", "providers", "models", "thinking", "tools", "services"])) throw invalid();
  if (!text(value.default_model) || !record(value.models) || !record(value.providers)
    || !Object.hasOwn(value.models, value.default_model)) throw invalid();
  for (const key of ["default_plan_mode", "telemetry", "merge_all_available_skills"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw invalid();
  }
  if (value.default_permission_mode !== undefined && !["manual", "auto", "yolo"].includes(String(value.default_permission_mode))) throw invalid();
  const catalog = normalizeKimiModelConfiguration(value);
  const thinking = value.thinking, nativeTools = value.tools;
  if (thinking !== undefined && (!record(thinking) || !keys(thinking, ["enabled", "effort", "keep"])
    || (thinking.enabled !== undefined && typeof thinking.enabled !== "boolean")
    || ["effort", "keep"].some(key => thinking[key] !== undefined && typeof thinking[key] !== "string"))) throw invalid();
  if (nativeTools !== undefined && (!record(nativeTools) || !keys(nativeTools, ["enabled", "disabled"])
    || ["enabled", "disabled"].some(key => nativeTools[key] !== undefined && !strings(nativeTools[key])))) throw invalid();
  const enabled = record(value.tools) && strings(value.tools.enabled) ? value.tools.enabled : [];
  const disabled = record(value.tools) && strings(value.tools.disabled) ? value.tools.disabled : [];
  const denied = Object.entries(tools).filter(([native, host]) => disabled.includes(native)
    || (enabled.length > 0 && !enabled.includes(native)) || policy.policy.toolDecisions[host] === "deny"
    || policy.effectivePolicySnapshot?.toolDecisions?.[host] === "deny"
    || ((readOnly || value.default_plan_mode === true) && ["write", "edit"].includes(host))
    || ((policy.effectivePolicySnapshot?.allowedWritePaths ?? policy.policy.allowedWritePaths).length === 0 && ["write", "edit"].includes(host)))
    .map(([native]) => native);
  const { services: _services, ...native } = value;
  return { ...native, ...catalog, default_permission_mode: "manual", default_plan_mode: readOnly || value.default_plan_mode === true,
    telemetry: false, merge_all_available_skills: false, tools: { enabled: Object.keys(tools), disabled: denied } };
}

interface Identity { readonly path: string; readonly directory: boolean; readonly info: Stats }
function identity(path: string, directory: boolean): Identity {
  const info = lstatSync(path);
  if (realpathSync(path) !== path || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1)) throw invalid();
  return { path, directory, info };
}
function assertCurrent(target: Identity): void {
  const next = identity(target.path, target.directory).info, before = target.info;
  if (next.dev !== before.dev || next.ino !== before.ino || (!target.directory
    && (next.size !== before.size || next.mtimeMs !== before.mtimeMs || next.ctimeMs !== before.ctimeMs))) throw invalid();
}
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 256 && value.every(text); }
function keys(value: RecordValue, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
