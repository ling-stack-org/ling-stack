import { execFileSync } from "node:child_process";
import { parseSecretRef, type ResolvedSecret, type SecretStatus } from "@ling-stack/core";
import type { ExternalSecretStore } from "../../context.js";

export function createSystemKeychainSecretStore(): ExternalSecretStore {
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
        execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", parsed.name], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { ref, kind: "keychain", configured: true };
      } catch (error) {
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
        const value = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", parsed.name, "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        return { ref, configured: Boolean(value), value, status };
      } catch (error) {
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
        execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", parsed.name, "-w", value], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { ref, kind: "keychain", configured: true };
      } catch (error) {
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
        execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", parsed.name], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
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
