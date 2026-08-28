import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type DesktopTitlebarPlacement = "inline" | "window";

interface DesktopTitlebarContextValue {
  readonly host: HTMLElement | null;
  readonly placement: DesktopTitlebarPlacement;
  readonly setHost: (host: HTMLElement | null) => void;
}

const DesktopTitlebarContext = createContext<DesktopTitlebarContextValue>({
  host: null,
  placement: "inline",
  setHost: () => undefined,
});

export function DesktopTitlebarProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [host, setHostState] = useState<HTMLElement | null>(null);
  const placement: DesktopTitlebarPlacement =
    typeof window !== "undefined" && window.lingDesktop?.platform === "macos"
      ? "window"
      : "inline";
  const setHost = useCallback((nextHost: HTMLElement | null) => {
    setHostState((current) => current === nextHost ? current : nextHost);
  }, []);
  const value = useMemo<DesktopTitlebarContextValue>(() => ({ host, placement, setHost }), [host, placement, setHost]);

  return <DesktopTitlebarContext.Provider value={value}>{children}</DesktopTitlebarContext.Provider>;
}

export function DesktopTitlebarSurface({ children }: { readonly children: ReactNode }): React.JSX.Element | null {
  const { host, placement } = useContext(DesktopTitlebarContext);
  if (placement === "inline") return <>{children}</>;
  return host ? createPortal(children, host) : null;
}

export function useDesktopTitlebarHost(): (host: HTMLElement | null) => void {
  return useContext(DesktopTitlebarContext).setHost;
}

export function useDesktopTitlebarPlacement(): DesktopTitlebarPlacement {
  return useContext(DesktopTitlebarContext).placement;
}
