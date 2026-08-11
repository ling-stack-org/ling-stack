import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

interface CurrentSessionHeaderCapabilityContextValue {
  readonly registerTarget: (target: HTMLElement) => () => void;
  readonly target: HTMLElement | null;
}

const CurrentSessionHeaderCapabilityContext = createContext<CurrentSessionHeaderCapabilityContextValue | null>(null);

export function CurrentSessionHeaderCapabilityProvider({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const registrationsRef = useRef(new Map<symbol, HTMLElement>());
  const [target, setTarget] = useState<HTMLElement | null>(null);

  const registerTarget = useCallback((nextTarget: HTMLElement): (() => void) => {
    const id = Symbol("current-session-header-capability");
    registrationsRef.current.set(id, nextTarget);
    setTarget(nextTarget);

    return () => {
      const registrations = registrationsRef.current;
      if (!registrations.delete(id)) {
        return;
      }
      const fallback = [...registrations.values()].at(-1) ?? null;
      setTarget((current) => current === nextTarget ? fallback : current);
    };
  }, []);

  const contextValue = useMemo(
    () => ({ registerTarget, target }),
    [registerTarget, target],
  );

  return (
    <CurrentSessionHeaderCapabilityContext.Provider value={contextValue}>
      {children}
    </CurrentSessionHeaderCapabilityContext.Provider>
  );
}

export function CurrentSessionHeaderCapabilitySlot(): React.JSX.Element {
  const context = useRequiredHeaderCapabilityContext();
  const releaseTargetRef = useRef<(() => void) | undefined>(undefined);

  const attachTarget = useCallback<RefCallback<HTMLSpanElement>>((target) => {
    releaseTargetRef.current?.();
    releaseTargetRef.current = target ? context.registerTarget(target) : undefined;
  }, [context.registerTarget]);

  return (
    <span
      ref={attachTarget}
      className="current-session-header-capability-slot"
      data-current-session-header-capability-slot="true"
    />
  );
}

export function CurrentSessionHeaderCapabilityPortal({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const { target } = useRequiredHeaderCapabilityContext();
  return target ? createPortal(children, target) : null;
}

function useRequiredHeaderCapabilityContext(): CurrentSessionHeaderCapabilityContextValue {
  const context = useContext(CurrentSessionHeaderCapabilityContext);
  if (!context) {
    throw new Error("CurrentSessionHeaderCapabilityProvider is required.");
  }
  return context;
}
