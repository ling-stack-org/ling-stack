import type { ProtectedHostActorEntry } from "./protected-host-actor-inventory.js";

/**
 * Fail-closed until the original physical launch modules export their actual
 * owned wrappers and this fixed Host module imports every one of them.
 * Runtime caller arrays, names, flags and fixture producers are not a source
 * manifest. The integration owner replaces this empty immutable source set
 * with the exact static module imports; no config/runtime registration hook.
 */
const originalEntries: readonly ProtectedHostActorEntry[] = Object.freeze([]);
export function readOriginalProtectedHostActorEntries(): readonly ProtectedHostActorEntry[] { return originalEntries; }
