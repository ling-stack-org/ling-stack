export interface ResolvedSecret {
  readonly configured: boolean;
  readonly value?: string;
}

export function isSupportedSecretRef(value: string): boolean {
  return value.startsWith("env:") && value.length > "env:".length;
}

export function resolveSecretRef(value: string | undefined): ResolvedSecret {
  if (!value) {
    return { configured: false };
  }
  if (!isSupportedSecretRef(value)) {
    return { configured: false };
  }

  const envName = value.slice("env:".length);
  const secret = process.env[envName];
  if (!secret) {
    return { configured: false };
  }
  return { configured: true, value: secret };
}
