/**
 * The source id returned by Electron is an implementation detail of the
 * desktop main process. Keep matching here as a pure function so a future
 * native Windows provider can replace the enumeration step without changing
 * the descriptor trust boundary.
 */
export interface ComputerUseCaptureTargetIdentity {
  readonly nativeWindowId?: string;
  readonly electronSourceId?: string;
}

export type ComputerUseElectronSourceType = "screen" | "window";

export function parseElectronWindowSourceId(sourceId: string): string | undefined {
  const match = /^window:([^:]+):/u.exec(sourceId);
  return readNonEmptyString(match?.[1]);
}

/**
 * Match an enumerated Electron source against the exact authorized target.
 *
 * A descriptor may carry both identities. In that case both must match; an
 * old/stale Electron id must never silently fall back to a native id. Native
 * window ids are only meaningful for `window:<native-id>:...` source ids and
 * can never authorize a display source.
 */
export function sourceMatchesDescriptor(
  source: { readonly id: string },
  sourceType: ComputerUseElectronSourceType,
  target: ComputerUseCaptureTargetIdentity,
): boolean {
  if (typeof source.id !== "string" || source.id.length === 0) {
    return false;
  }

  const electronSourceId = readNonEmptyString(target.electronSourceId);
  const nativeWindowId = readNonEmptyString(target.nativeWindowId);
  if (!electronSourceId && !nativeWindowId) {
    return false;
  }

  if (electronSourceId && (
    source.id !== electronSourceId
    || !source.id.startsWith(`${sourceType}:`)
  )) {
    return false;
  }

  if (nativeWindowId) {
    if (sourceType !== "window") {
      return false;
    }
    const enumeratedNativeWindowId = parseElectronWindowSourceId(source.id);
    if (enumeratedNativeWindowId !== nativeWindowId) {
      return false;
    }
  }

  return true;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}
