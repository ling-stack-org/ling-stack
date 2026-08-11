import type { HTMLAttributes, ReactNode } from "react";
import { useAppViewportState } from "./use-app-viewport-state.js";

export interface AppShellOverlayBoundaryProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  readonly children: ReactNode;
}

export function AppShellOverlayBoundary({
  children,
  ...props
}: AppShellOverlayBoundaryProps): React.JSX.Element {
  const viewport = useAppViewportState();
  return (
    <main
      {...props}
      data-ui2-client={viewport.client}
      data-ui2-overlay-root="ling-ui-overlay-root"
      data-ui2-shell-boundary="true"
      data-ui2-viewport-height={viewport.height}
      data-ui2-viewport-size={viewport.size}
      data-ui2-viewport-width={viewport.width}
    >
      {children}
    </main>
  );
}
