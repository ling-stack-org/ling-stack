import type { PermissionConfirmation } from "../types.js";

const storageKey = "ling-stack.full-access-confirmations.v1";
const maximumConfirmationCount = 256;

export interface FullAccessConfirmationStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export function browserFullAccessConfirmationStorage(): FullAccessConfirmationStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadFullAccessConfirmations(
  storage: FullAccessConfirmationStorage | undefined,
): Map<string, PermissionConfirmation> {
  if (!storage) return new Map();
  try {
    const payload = readRecord(JSON.parse(storage.getItem(storageKey) ?? "null"));
    if (payload?.version !== 1 || !Array.isArray(payload.confirmations)) return new Map();
    const confirmations = new Map<string, PermissionConfirmation>();
    for (const value of payload.confirmations) {
      const record = readRecord(value);
      const confirmation = readPermissionConfirmation(record?.confirmation);
      if (typeof record?.scopeId === "string" && confirmation) {
        rememberFullAccessConfirmation(confirmations, record.scopeId, confirmation);
      }
    }
    return confirmations;
  } catch {
    return new Map();
  }
}

export function persistFullAccessConfirmations(
  storage: FullAccessConfirmationStorage | undefined,
  confirmations: ReadonlyMap<string, PermissionConfirmation>,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify({
      version: 1,
      confirmations: [...confirmations.entries()].slice(-maximumConfirmationCount).map(([scopeId, confirmation]) => ({
        scopeId,
        confirmation,
      })),
    }));
  } catch {
    // Confirmation remains valid in memory when browser persistence is unavailable.
  }
}

export function rememberFullAccessConfirmation(
  confirmations: Map<string, PermissionConfirmation>,
  scopeId: string,
  confirmation: PermissionConfirmation,
): void {
  confirmations.delete(scopeId);
  confirmations.set(scopeId, confirmation);
  while (confirmations.size > maximumConfirmationCount) {
    const oldestScopeId = confirmations.keys().next().value as string | undefined;
    if (!oldestScopeId) break;
    confirmations.delete(oldestScopeId);
  }
}

function readPermissionConfirmation(value: unknown): PermissionConfirmation | undefined {
  const record = readRecord(value);
  return record?.mode === "full_access"
    && record.confirmed === true
    && typeof record.confirmedAt === "string"
    && record.reason === "user_confirmed_full_access"
    ? {
        mode: "full_access",
        confirmed: true,
        confirmedAt: record.confirmedAt,
        reason: "user_confirmed_full_access",
      }
    : undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
