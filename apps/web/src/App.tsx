import { AppShell } from "./app/AppShell.js";
import { DesktopThemeBridge } from "./app/DesktopThemeBridge.js";
import { BackgroundProvider } from "./shared/ui/background/BackgroundProvider.js";
import { WorkspaceBackgroundLayer } from "./shared/ui/background/WorkspaceBackgroundLayer.js";

export function App(): React.JSX.Element {
  return (
    <BackgroundProvider>
      <DesktopThemeBridge />
      <WorkspaceBackgroundLayer />
      <AppShell />
    </BackgroundProvider>
  );
}
