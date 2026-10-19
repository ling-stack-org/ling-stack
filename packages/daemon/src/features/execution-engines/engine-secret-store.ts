import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SecretResolver, SecretStatus } from "@ling-stack/core";

export interface EngineSecretStore extends SecretResolver {
  write(ref: string, value: string): void;
  remove(ref: string): void;
}

export class EngineSecretStoreError extends Error {
  constructor(readonly code: "engine_secret_store_unavailable" | "engine_secret_cleanup_failed") { super(code); }
}

export function isManagedEngineSecretRef(ref: string): boolean {
  return /^keychain:ling-engine-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref);
}

/** Engine-only namespace. The legacy provider keychain and arbitrary refs are untouched. */
export function createEngineSecretStore(options: {
  readonly exec?: typeof execFileSync;
  readonly platform?: NodeJS.Platform;
} = {}): EngineSecretStore {
  const call = (operation: "read" | "status" | "write" | "remove", ref: string, value?: string): Record<string, unknown> => {
    if (!isManagedEngineSecretRef(ref) || !["darwin", "win32"].includes(options.platform ?? process.platform)) {
      throw new EngineSecretStoreError("engine_secret_store_unavailable");
    }
    try {
      const result = (options.exec ?? execFileSync)(process.execPath,
        [fileURLToPath(new URL("./engine-secret-worker.js", import.meta.url)), operation, ref.slice("keychain:".length)], {
          input: value ?? "", encoding: "utf8", timeout: 1500, killSignal: "SIGKILL", maxBuffer: 8192,
          windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
          env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        });
      const parsed: unknown = JSON.parse(result);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new EngineSecretStoreError("engine_secret_store_unavailable"); }
  };
  const status = (ref: string, configured: boolean, errorCode?: SecretStatus["errorCode"]): SecretStatus => ({
    ref, kind: "keychain", configured, ...(errorCode ? { errorCode } : {}),
  });
  return {
    status(ref) {
      try {
        const result = call("status", ref);
        if (typeof result.configured !== "boolean") throw new Error();
        return status(ref, result.configured, result.configured ? undefined : "secret_missing");
      } catch { return status(ref, false, "secret_store_unavailable"); }
    },
    resolve(ref) {
      try {
        const result = call("read", ref);
        if (result.value === null) return { ref, configured: false, status: status(ref, false, "secret_missing") };
        if (typeof result.value !== "string" || !result.value || Buffer.byteLength(result.value) > 2048) throw new Error();
        return { ref, configured: true, value: result.value, status: status(ref, true) };
      } catch { return { ref, configured: false, status: status(ref, false, "secret_store_unavailable") }; }
    },
    write(ref, value) {
      if (!value.trim() || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 2048) {
        throw new EngineSecretStoreError("engine_secret_store_unavailable");
      }
      if (call("write", ref, value).stored !== true) throw new EngineSecretStoreError("engine_secret_store_unavailable");
    },
    remove(ref) {
      if (call("remove", ref).absent !== true) throw new EngineSecretStoreError("engine_secret_cleanup_failed");
    },
  };
}

export function withEngineSecretResolver(store: EngineSecretStore, fallback?: SecretResolver): SecretResolver {
  return {
    status: (ref, purpose) => isManagedEngineSecretRef(ref) ? store.status(ref, purpose)
      : fallback?.status(ref, purpose) ?? { ref, kind: "keychain", configured: false, errorCode: "secret_missing" },
    resolve: (ref, purpose) => isManagedEngineSecretRef(ref) ? store.resolve(ref, purpose)
      : fallback?.resolve(ref, purpose) ?? { ref, configured: false },
  };
}
