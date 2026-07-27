import { useCallback, useState } from "react";

export function useTeammateIdentityError(
  identity: string,
): readonly [string, (message: string) => void] {
  const [errorByIdentity, setErrorByIdentity] = useState<Readonly<Record<string, string>>>({});
  const setError = useCallback((message: string): void => {
    setErrorByIdentity((current) => {
      if (message) {
        return current[identity] === message ? current : { ...current, [identity]: message };
      }
      if (!(identity in current)) return current;
      const next = { ...current };
      delete next[identity];
      return next;
    });
  }, [identity]);

  return [errorByIdentity[identity] ?? "", setError] as const;
}
