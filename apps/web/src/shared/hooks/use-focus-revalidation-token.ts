import { useEffect, useRef, useState } from "react";

const DEFAULT_STALE_AFTER_MS = 15_000;

export function useFocusRevalidationToken({
  enabled = true,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: {
  readonly enabled?: boolean;
  readonly staleAfterMs?: number;
} = {}): number {
  const [token, setToken] = useState(0);
  const lastRevalidationAtRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) {
      lastRevalidationAtRef.current = Date.now();
      return undefined;
    }

    const revalidateIfStale = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastRevalidationAtRef.current < staleAfterMs) return;
      lastRevalidationAtRef.current = now;
      setToken((current) => current + 1);
    };

    window.addEventListener("focus", revalidateIfStale);
    window.addEventListener("online", revalidateIfStale);
    document.addEventListener("visibilitychange", revalidateIfStale);
    return () => {
      window.removeEventListener("focus", revalidateIfStale);
      window.removeEventListener("online", revalidateIfStale);
      document.removeEventListener("visibilitychange", revalidateIfStale);
    };
  }, [enabled, staleAfterMs]);

  return token;
}
