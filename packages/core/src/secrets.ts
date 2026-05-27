export type SecretRefKind = "env" | "keychain";
export type SecretStatusKind = SecretRefKind | "local";

export type SecretPurpose =
  | "provider_api_key"
  | "github_token"
  | "webhook_secret"
  | "custom_header"
  | "automation_token";

export const secretPurposes = [
  "provider_api_key",
  "github_token",
  "webhook_secret",
  "custom_header",
  "automation_token",
] as const satisfies readonly SecretPurpose[];

export type SecretStatusErrorCode =
  | "secret_missing"
  | "secret_access_denied"
  | "secret_store_unavailable"
  | "invalid_secret_ref";

export interface SecretRef {
  readonly raw: string;
  readonly kind: SecretRefKind;
  readonly name: string;
}

export interface SecretStatus {
  readonly ref: string;
  readonly kind: SecretStatusKind;
  readonly configured: boolean;
  readonly errorCode?: SecretStatusErrorCode;
  readonly message?: string;
}

export interface ResolvedSecret {
  readonly ref?: string;
  readonly configured: boolean;
  readonly value?: string;
  readonly status?: SecretStatus;
}

export interface SecretResolver {
  status(ref: string, purpose?: SecretPurpose): SecretStatus;
  resolve(ref: string, purpose?: SecretPurpose): ResolvedSecret;
}

export interface CompositeSecretResolverInput {
  readonly env?: Record<string, string | undefined>;
  readonly keychainResolver?: SecretResolver;
}

const supportedSecretRefKinds = ["env", "keychain"] as const satisfies readonly SecretRefKind[];

export function parseSecretRef(ref: string): SecretRef {
  if (typeof ref !== "string") {
    throw new Error("Secret ref must be a string.");
  }

  const separator = ref.indexOf(":");
  if (separator <= 0) {
    throw new Error("Secret ref must use env:NAME or keychain:NAME.");
  }

  const kind = ref.slice(0, separator);
  const name = ref.slice(separator + 1);
  if (!isSecretRefKind(kind)) {
    throw new Error("Secret ref must use env:NAME or keychain:NAME.");
  }
  if (!isValidSecretRefName(name)) {
    throw new Error("Secret ref name must be non-empty and contain no whitespace.");
  }

  return { raw: ref, kind, name };
}

export function isSupportedSecretRef(value: string): boolean {
  try {
    parseSecretRef(value);
    return true;
  } catch {
    return false;
  }
}

export function createEnvSecretResolver(env: Record<string, string | undefined> = process.env): SecretResolver {
  return {
    status(ref: string): SecretStatus {
      const parsed = parseSecretRef(ref);
      if (parsed.kind !== "env") {
        return invalidKindStatus(parsed, "env resolver only supports env: refs.");
      }
      const configured = Boolean(env[parsed.name]);
      return {
        ref: parsed.raw,
        kind: parsed.kind,
        configured,
        errorCode: configured ? undefined : "secret_missing",
        message: configured ? undefined : `Secret is not configured: ${parsed.raw}`,
      };
    },
    resolve(ref: string): ResolvedSecret {
      const status = this.status(ref);
      if (!status.configured) {
        return { ref, configured: false, status };
      }
      const parsed = parseSecretRef(ref);
      return { ref, configured: true, value: env[parsed.name], status };
    },
  };
}

export function createCompositeSecretResolver(input: CompositeSecretResolverInput = {}): SecretResolver {
  const envResolver = createEnvSecretResolver(input.env);
  const keychainResolver = input.keychainResolver ?? createUnavailableKeychainSecretResolver();

  return {
    status(ref: string, purpose?: SecretPurpose): SecretStatus {
      const parsed = safeParseSecretRef(ref);
      if (!parsed.ok) {
        return parsed.status;
      }
      return resolverFor(parsed.ref.kind).status(ref, purpose);
    },
    resolve(ref: string, purpose?: SecretPurpose): ResolvedSecret {
      const parsed = safeParseSecretRef(ref);
      if (!parsed.ok) {
        return { ref, configured: false, status: parsed.status };
      }
      return resolverFor(parsed.ref.kind).resolve(ref, purpose);
    },
  };

  function resolverFor(kind: SecretRefKind): SecretResolver {
    return kind === "env" ? envResolver : keychainResolver;
  }
}

export function resolveSecretRef(value: string | undefined): ResolvedSecret {
  if (!value) {
    return { configured: false };
  }
  return createCompositeSecretResolver().resolve(value);
}

function createUnavailableKeychainSecretResolver(): SecretResolver {
  return {
    status(ref: string): SecretStatus {
      const parsed = parseSecretRef(ref);
      if (parsed.kind !== "keychain") {
        return invalidKindStatus(parsed, "keychain resolver only supports keychain: refs.");
      }
      return {
        ref: parsed.raw,
        kind: parsed.kind,
        configured: false,
        errorCode: "secret_store_unavailable",
        message: "Keychain secret store is unavailable in this runtime.",
      };
    },
    resolve(ref: string): ResolvedSecret {
      const status = this.status(ref);
      return { ref, configured: false, status };
    },
  };
}

function safeParseSecretRef(ref: string): { readonly ok: true; readonly ref: SecretRef } | { readonly ok: false; readonly status: SecretStatus } {
  try {
    return { ok: true, ref: parseSecretRef(ref) };
  } catch (error) {
    return {
      ok: false,
      status: {
        ref,
        kind: "env",
        configured: false,
        errorCode: "invalid_secret_ref",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function invalidKindStatus(ref: SecretRef, message: string): SecretStatus {
  return {
    ref: ref.raw,
    kind: ref.kind,
    configured: false,
    errorCode: "invalid_secret_ref",
    message,
  };
}

function isSecretRefKind(value: string): value is SecretRefKind {
  return (supportedSecretRefKinds as readonly string[]).includes(value);
}

function isValidSecretRefName(name: string): boolean {
  return name.trim() === name && name.length > 0 && !/\s/.test(name);
}
