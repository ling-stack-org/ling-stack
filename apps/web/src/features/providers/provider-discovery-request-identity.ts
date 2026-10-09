import { parseSecretHeaderRefsText } from "../../api/provider-payloads.js";
import type { ProviderFormState } from "../../types.js";

interface ProviderDiscoveryScopeInput {
  readonly cwd: string;
  readonly editingProviderId: string;
  readonly form: ProviderFormState;
}

/** An opaque receipt contains no credential, credential hash or request body. */
export interface ProviderDiscoveryScopeReceipt {
  readonly generation: number;
  readonly preserveResult: boolean;
}

export interface ProviderDiscoveryRequestReceipt {
  readonly scope: ProviderDiscoveryScopeReceipt;
  readonly generation: number;
}

type PrivateRequestIdentity = Pick<ProviderFormState,
  "kind" | "providerId" | "api" | "authHeader"
> & {
  readonly cwd: string;
  readonly providerPresetId?: string;
  readonly providerTransport?: ProviderFormState["providerTransport"];
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyRef?: string;
  readonly secretHeaderRefs?: Readonly<Record<string, string>>;
};

/**
 * Compare only the effective listProviderModels payload, plus workspace scope.
 * Sensitive comparison material stays in this ephemeral closure. Neither the
 * scope/request receipts nor React's result state receive it.
 */
export function createProviderDiscoveryRequestFence() {
  let identity: PrivateRequestIdentity | undefined;
  let retainedTarget: PrivateRequestIdentity | undefined;
  let scope: ProviderDiscoveryScopeReceipt = { generation: 0, preserveResult: false };
  let requestGeneration = 0;
  let active = true;

  return {
    /** Called during render so stale callbacks cannot beat passive reset effects. */
    reconcile(input: ProviderDiscoveryScopeInput): ProviderDiscoveryScopeReceipt {
      const next = captureIdentity(input);
      if (!identity || !identitiesEqual(identity, next)) {
        scope = {
          generation: scope.generation + 1,
          preserveResult: retainedTarget !== undefined && identitiesEqual(retainedTarget, next),
        };
        identity = next;
        retainedTarget = undefined;
        requestGeneration += 1;
      }
      return scope;
    },
    /** Model selection may retain proven rows for one exact derived connection. */
    retainNextScope(input: ProviderDiscoveryScopeInput): void {
      const next = captureIdentity(input);
      retainedTarget = identity && !identitiesEqual(identity, next) ? next : undefined;
    },
    begin(expectedScope: ProviderDiscoveryScopeReceipt): ProviderDiscoveryRequestReceipt | undefined {
      if (!active || expectedScope !== scope) return undefined;
      return { scope, generation: ++requestGeneration };
    },
    isCurrent(receipt: ProviderDiscoveryRequestReceipt): boolean {
      return active && receipt.scope === scope && receipt.generation === requestGeneration;
    },
    invalidate(): void {
      requestGeneration += 1;
      retainedTarget = undefined;
    },
    activate(): void {
      active = true;
    },
    deactivate(): void {
      active = false;
      requestGeneration += 1;
      retainedTarget = undefined;
    },
  };
}

function captureIdentity(input: ProviderDiscoveryScopeInput): PrivateRequestIdentity {
  const { form } = input;
  return {
    cwd: input.cwd.trim(),
    providerPresetId: input.editingProviderId || undefined,
    kind: form.kind,
    providerId: form.providerId,
    api: form.api,
    providerTransport: form.providerTransport || undefined,
    baseUrl: form.baseUrl || undefined,
    apiKey: form.apiKey.trim() || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    secretHeaderRefs: parseSecretHeaderRefsText(form.secretHeaderRefsText),
    authHeader: form.authHeader,
  };
}

function identitiesEqual(left: PrivateRequestIdentity, right: PrivateRequestIdentity): boolean {
  return left.cwd === right.cwd && left.providerPresetId === right.providerPresetId &&
    left.kind === right.kind && left.providerId === right.providerId && left.api === right.api &&
    left.providerTransport === right.providerTransport && left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey && left.apiKeyRef === right.apiKeyRef && left.authHeader === right.authHeader &&
    headerRefsEqual(left.secretHeaderRefs, right.secretHeaderRefs);
}

function headerRefsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  return leftKeys.length === rightKeys.length && leftKeys.every(key => left?.[key] === right?.[key]);
}
