import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { parseSecretRef, type ResolvedSecret, type SecretStatus } from "@ling-stack/core";
import type { ExternalSecretStore } from "../../context.js";
import { defineProtectedHostActorEntry, isProtectedHostActorEntryLaunchRefusal } from "../../runtime/sandbox/protected-host-actor-inventory.js";

declare const keychainSecurityRecordBrand: unique symbol;
interface KeychainSecurityRecord { readonly [keychainSecurityRecordBrand]: true }
interface KeychainSecurityLaunch {
  readonly args: readonly string[];
  readonly options: ExecFileSyncOptions;
  consumed: boolean;
}
const originalExecFileSync = execFileSync;
const keychainSecurityLaunches = new WeakMap<KeychainSecurityRecord, KeychainSecurityLaunch>();

/** Source-owned fixed security producer. A caller cannot supply argv or inherit default source proof. */
export const KEYCHAIN_SECURITY_ACTOR_ENTRY = defineProtectedHostActorEntry("keychain_security",
  (record: KeychainSecurityRecord): string | Buffer => {
    const launch = keychainSecurityLaunches.get(record);
    if (!launch?.consumed || !keychainSecurityLaunches.delete(record)) throw new Error("keychain_security_record_invalid");
    return originalExecFileSync("/usr/bin/security", [...launch.args], launch.options);
  },
  (record: KeychainSecurityRecord): void => {
    const launch = keychainSecurityLaunches.get(record);
    if (!launch || launch.consumed) throw new Error("keychain_security_record_invalid");
    launch.consumed = true; // Rejected launches are consumed too; no replay after the gate changes.
  });

function runKeychainSecurity(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
function runKeychainSecurity(args: readonly string[], options: ExecFileSyncOptions): Buffer;
function runKeychainSecurity(args: readonly string[], options: ExecFileSyncOptions): string | Buffer {
  const record = Object.freeze({}) as KeychainSecurityRecord;
  const stdio = Array.isArray(options.stdio) ? [...options.stdio] : options.stdio;
  if (Array.isArray(stdio)) Object.freeze(stdio);
  keychainSecurityLaunches.set(record, { args: Object.freeze([...args]),
    options: Object.freeze({ ...options, stdio }),
    consumed: false });
  return KEYCHAIN_SECURITY_ACTOR_ENTRY.invoke(undefined, record);
}

function isOriginalKeychainSecurityRefusal(error: unknown): boolean {
  return isProtectedHostActorEntryLaunchRefusal(KEYCHAIN_SECURITY_ACTOR_ENTRY, error);
}

export function createSystemKeychainSecretStore(options: { readonly readTimeoutMs?: number } = {}): ExternalSecretStore {
  if (options.readTimeoutMs !== undefined && (!Number.isSafeInteger(options.readTimeoutMs) || options.readTimeoutMs <= 0)) {
    throw new Error("Invalid keychain read timeout.");
  }
  const readBounds = options.readTimeoutMs === undefined ? {} : { timeout: options.readTimeoutMs, killSignal: "SIGKILL" as const };
  const service = "ling-stack";
  const unavailable = (ref: string, message = "Keychain secret store is unavailable in this runtime."): SecretStatus => ({
    ref,
    kind: "keychain",
    configured: false,
    errorCode: "secret_store_unavailable",
    message,
  });

  return {
    status(ref: string): SecretStatus {
      let parsed: ReturnType<typeof parseSecretRef>;
      try {
        parsed = parseSecretRef(ref);
      } catch (error) {
        return {
          ref,
          kind: "keychain",
          configured: false,
          errorCode: "invalid_secret_ref",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (parsed.kind !== "keychain") {
        return {
          ref,
          kind: parsed.kind,
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "External work Web secret setup only supports keychain: refs.",
        };
      }
      if (process.platform !== "darwin") {
        return unavailable(ref);
      }
      try {
        runKeychainSecurity(["find-generic-password", "-s", service, "-a", parsed.name], {
          ...readBounds,
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { ref, kind: "keychain", configured: true };
      } catch (error) {
        if (isOriginalKeychainSecurityRefusal(error)) throw error;
        const message = readProcessErrorMessage(error);
        if (message.includes("could not be found") || message.includes("The specified item could not be found")) {
          return {
            ref,
            kind: "keychain",
            configured: false,
            errorCode: "secret_missing",
            message: `Secret is not configured: ${ref}`,
          };
        }
        return unavailable(ref, message || "Keychain secret status could not be read.");
      }
    },
    resolve(ref: string): ResolvedSecret {
      const status = this.status(ref);
      if (!status.configured) {
        return { ref, configured: false, status };
      }
      const parsed = parseSecretRef(ref);
      try {
        const value = runKeychainSecurity(["find-generic-password", "-s", service, "-a", parsed.name, "-w"], {
          ...readBounds,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        return { ref, configured: Boolean(value), value, status };
      } catch (error) {
        if (isOriginalKeychainSecurityRefusal(error)) throw error;
        const message = readProcessErrorMessage(error);
        return {
          ref,
          configured: false,
          status: {
            ref,
            kind: "keychain",
            configured: false,
            errorCode: "secret_access_denied",
            message: message || "Keychain secret could not be read.",
          },
        };
      }
    },
    setSecret(ref: string, value: string): SecretStatus {
      const parsed = parseSecretRef(ref);
      if (parsed.kind !== "keychain") {
        return {
          ref,
          kind: parsed.kind,
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "External work Web secret setup only supports keychain: refs.",
        };
      }
      if (process.platform !== "darwin") {
        return unavailable(ref);
      }
      try {
        runKeychainSecurity(["add-generic-password", "-U", "-s", service, "-a", parsed.name, "-w", value], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { ref, kind: "keychain", configured: true };
      } catch (error) {
        if (isOriginalKeychainSecurityRefusal(error)) throw error;
        return {
          ref,
          kind: "keychain",
          configured: false,
          errorCode: "secret_access_denied",
          message: readProcessErrorMessage(error) || "Keychain secret could not be saved.",
        };
      }
    },
    deleteSecret(ref: string): SecretStatus {
      const parsed = parseSecretRef(ref);
      if (parsed.kind !== "keychain") {
        return {
          ref,
          kind: parsed.kind,
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "External work Web secret setup only supports keychain: refs.",
        };
      }
      if (process.platform !== "darwin") {
        return unavailable(ref);
      }
      try {
        runKeychainSecurity(["delete-generic-password", "-s", service, "-a", parsed.name], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        if (isOriginalKeychainSecurityRefusal(error)) throw error;
        const message = readProcessErrorMessage(error);
        if (!message.includes("could not be found") && !message.includes("The specified item could not be found")) {
          return {
            ref,
            kind: "keychain",
            configured: false,
            errorCode: "secret_access_denied",
            message: message || "Keychain secret could not be deleted.",
          };
        }
      }
      return {
        ref,
        kind: "keychain",
        configured: false,
        errorCode: "secret_missing",
        message: `Secret is not configured: ${ref}`,
      };
    },
  };
}

function readProcessErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? (error as { readonly stderr?: unknown }).stderr : undefined;
    if (Buffer.isBuffer(stderr)) {
      return stderr.toString("utf8").trim();
    }
    if (typeof stderr === "string") {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}
