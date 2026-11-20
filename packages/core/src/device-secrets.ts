import type { DeviceSecretUseV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";

export interface DeviceSecretResolver {
  resolve(input: { readonly targetDeviceId: string; readonly secretRef: string }): Promise<string | Uint8Array | undefined>;
}

export interface DeviceSecretUseRecorder {
  recordSecretUse(use: DeviceSecretUseV1): void;
}

export interface DeviceSecretBrokerOptions {
  readonly resolver: DeviceSecretResolver;
  readonly recorder?: DeviceSecretUseRecorder;
  readonly now?: () => string;
}

export class DeviceSecretBroker {
  readonly #resolver: DeviceSecretResolver;
  readonly #recorder?: DeviceSecretUseRecorder;
  readonly #now: () => string;
  readonly #allowed = new Map<string, Set<string>>();
  readonly #uses: DeviceSecretUseV1[] = [];

  constructor(options: DeviceSecretBrokerOptions) {
    this.#resolver = options.resolver;
    this.#recorder = options.recorder;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  allowReference(targetDeviceId: string, secretRef: string): void {
    if (!targetDeviceId.trim() || !secretRef.trim()) throw new DeviceFabricError("safety_denied", "target-scoped secret reference is invalid");
    const references = this.#allowed.get(targetDeviceId) ?? new Set<string>();
    references.add(secretRef);
    this.#allowed.set(targetDeviceId, references);
  }

  revokeReference(targetDeviceId: string, secretRef: string): void {
    this.#allowed.get(targetDeviceId)?.delete(secretRef);
  }

  async resolve(input: {
    readonly useId: string;
    readonly taskId: string;
    readonly attemptId?: string;
    readonly targetDeviceId: string;
    readonly secretRef: string;
    readonly purpose: string;
    readonly policyRevision: string;
  }): Promise<string | Uint8Array> {
    if (!this.#allowed.get(input.targetDeviceId)?.has(input.secretRef)) throw new DeviceFabricError("safety_denied", "secret reference is not authorized for this target");
    if (!input.useId.trim() || !input.taskId.trim() || !input.purpose.trim() || !input.policyRevision.trim()) throw new DeviceFabricError("safety_denied", "secret use identity is invalid");
    let secret: string | Uint8Array | undefined;
    try {
      secret = await this.#resolver.resolve({ targetDeviceId: input.targetDeviceId, secretRef: input.secretRef });
    } catch {
      throw new DeviceFabricError("safety_denied", "secret reference could not be resolved");
    }
    if (secret === undefined) throw new DeviceFabricError("safety_denied", "secret reference could not be resolved");
    const use: DeviceSecretUseV1 = {
      useId: input.useId,
      taskId: input.taskId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      targetDeviceId: input.targetDeviceId,
      secretRef: input.secretRef,
      purpose: input.purpose,
      policyRevision: input.policyRevision,
      usedAt: this.#now(),
    };
    this.#uses.push(use);
    this.#recorder?.recordSecretUse(use);
    return secret;
  }

  listUses(): readonly DeviceSecretUseV1[] { return [...this.#uses]; }
}
