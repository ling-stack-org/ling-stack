import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExecutionEngineProfile, ExecutionEngineProbe, ExecutionEngineProbeMode, ExternalExecutionEngineId } from "@ling-stack/contracts";
import { ExecutionEngineProfileStore, type LingStackUserConfigPaths, type SecretResolver } from "@ling-stack/core";
import { EngineManagementAuthority, engineManagementCsrf } from "./authority.js";
import { EngineManagementController } from "./controller.js";
import { EngineProbeBusyError, probeEngineInstallation } from "./installation-probe.js";
import { probeEngineConnection } from "./connection-probe.js";
import { EngineLoginManager, type NativeLoginProcessOptions } from "./login-manager.js";
import { createEngineSecretStore, withEngineSecretResolver, type EngineSecretStore } from "./engine-secret-store.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import { RunnerAcceptanceStore } from "../../runtime/runner-acceptance-store.js";
import {
  createExecutionEngineRunTargetDispatcher,
  type ExecutionEngineRunTargetDispatcherOptions,
} from "./run-target-dispatcher.js";

export type NativeProbeProcessOptions = Pick<NonNullable<Parameters<typeof probeEngineConnection>[2]>, "spawn" | "platform" | "timeoutMs">;

export interface EngineManagementFeatureOptions {
  readonly userPaths: LingStackUserConfigPaths;
  readonly allowedOrigins: readonly string[];
  /** Trusted embedding/launch input only; never sourced from workspace configuration. */
  readonly capability?: string;
  /** Trusted embedding/test process policy; never parsed from HTTP or workspace settings. */
  readonly login?: NativeLoginProcessOptions;
  readonly probe?: NativeProbeProcessOptions;
  readonly secretResolver?: SecretResolver;
  readonly secretStore?: EngineSecretStore;
  readonly runnerRegistry?: RunnerRegistry;
}

export class EngineManagementFeature {
  readonly credentials: { readonly capability: string; readonly csrfToken: string };
  readonly runTargetDispatcher: ReturnType<typeof createExecutionEngineRunTargetDispatcher>;
  private readonly authority: EngineManagementAuthority;
  private readonly controller: EngineManagementController;
  private store?: ExecutionEngineProfileStore;
  private readonly probes = new Map<ExternalExecutionEngineId, { readonly controller: AbortController; readonly result: Promise<ExecutionEngineProbe> }>();
  private readonly logins: EngineLoginManager;
  private closing?: Promise<void>;
  private readonly secretResolver: SecretResolver;

  constructor(private readonly options: EngineManagementFeatureOptions) {
    const capability = options.capability ?? randomBytes(32).toString("base64url");
    this.credentials = { capability, csrfToken: engineManagementCsrf(capability) };
    this.authority = new EngineManagementAuthority({ capability, allowedOrigins: options.allowedOrigins });
    const secretStore = options.secretStore ?? createEngineSecretStore();
    this.secretResolver = withEngineSecretResolver(secretStore, options.secretResolver);
    const getStore = (): ExecutionEngineProfileStore => this.store ??= new ExecutionEngineProfileStore(options.userPaths);
    const acceptance = new RunnerAcceptanceStore(options.userPaths);
    this.runTargetDispatcher = createExecutionEngineRunTargetDispatcher({
      getProfileStore: getStore,
      secretResolver: this.secretResolver,
      readWorkspaceSettings: options.runnerRegistry ? store => loadWorkspaceRuntimeSettings(store, options.runnerRegistry!) : undefined,
      readAcceptanceEvidence: identity => acceptance.read(identity),
    } satisfies ExecutionEngineRunTargetDispatcherOptions);
    this.logins = new EngineLoginManager({ authority: this.authority, getStore, userPaths: options.userPaths,
      isProbing: (engineId) => this.probes.has(engineId), process: options.login, secretResolver: this.secretResolver });
    this.controller = new EngineManagementController({
      authority: this.authority,
      getStore,
      logins: this.logins,
      secretStore,
      probe: (profile, signal, mode) => this.probe(profile, signal, mode),
      beforeProfileChange: (engineId) => this.logins.assertIdle(engineId),
      onProfileChanged: (engineId) => { this.probes.get(engineId)?.controller.abort(); this.logins.invalidate(engineId); },
    });
  }

  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    return this.controller.handle(request, response);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.authority.close();
    for (const probe of this.probes.values()) probe.controller.abort();
    this.closing = Promise.allSettled([this.logins.close(), ...[...this.probes.values()].map((probe) => probe.result)]).then((results) => {
      this.store?.close();
      this.store = undefined;
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    });
    return this.closing;
  }

  private probe(profile: ExecutionEngineProfile, signal: AbortSignal, mode: ExecutionEngineProbeMode): Promise<ExecutionEngineProbe> {
    const id = profile.configuration.engineId;
    this.logins.assertIdle(id);
    if (this.probes.has(id)) throw new EngineProbeBusyError();
    const controller = new AbortController();
    const cancellation = AbortSignal.any([signal, controller.signal]);
    const result = (mode === "connection"
      ? probeEngineConnection(profile, this.options.userPaths, { ...this.options.probe, signal: cancellation, secretResolver: this.secretResolver, store: this.store })
      : probeEngineInstallation(profile, { ...this.options.probe, signal: cancellation })).finally(() => this.probes.delete(id));
    this.probes.set(id, { controller, result });
    return result;
  }
}
