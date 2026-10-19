import { randomUUID } from "node:crypto";
import type { ExecutionEngineProfile, ExecutionEngineProfileConfiguration } from "@ling-stack/contracts";
import { parseExecutionEngineProfileConfiguration, type ExecutionEngineProfileStore } from "@ling-stack/core";
import { EngineSecretStoreError, type EngineSecretStore } from "./engine-secret-store.js";

export function saveEngineSecretProfile(options: {
  readonly store: ExecutionEngineProfileStore;
  readonly secretStore: Pick<EngineSecretStore, "write" | "remove">;
  readonly configuration: Omit<ExecutionEngineProfileConfiguration, "secretRef">;
  readonly expectedRevision: number;
  readonly secret: string;
  readonly assertAuthority: () => void;
}): ExecutionEngineProfile {
  const ref = `keychain:ling-engine-${randomUUID()}`;
  const configuration = parseExecutionEngineProfileConfiguration({ ...options.configuration,
    secretRef: ref, authProfileId: `auth-${randomUUID()}` });
  let attempted = false;
  try {
    return options.store.save(configuration, options.expectedRevision, () => {
      options.assertAuthority();
      attempted = true;
      try { options.secretStore.write(ref, options.secret); }
      catch { throw new EngineSecretStoreError("engine_secret_store_unavailable"); }
      options.assertAuthority();
    });
  } catch (error) {
    if (attempted) {
      try { options.secretStore.remove(ref); }
      catch { throw new EngineSecretStoreError("engine_secret_cleanup_failed"); }
    }
    throw error;
  }
}
