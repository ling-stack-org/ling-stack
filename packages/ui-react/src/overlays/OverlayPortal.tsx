import { createContext, useContext, type ReactNode } from "react";

const OverlayPortalContainerContext = createContext<HTMLElement | null>(null);

export function OverlayPortalProvider({
  children,
  container,
}: {
  readonly children: ReactNode;
  readonly container: HTMLElement | null;
}): React.JSX.Element {
  return (
    <OverlayPortalContainerContext.Provider value={container}>
      {children}
    </OverlayPortalContainerContext.Provider>
  );
}

export function useOverlayPortalContainer(): HTMLElement | null {
  return useContext(OverlayPortalContainerContext);
}
