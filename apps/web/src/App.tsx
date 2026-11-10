import { useState } from "react";
import { AppShell } from "./app/AppShell.js";
import { DesktopThemeBridge } from "./app/DesktopThemeBridge.js";
import { LaunchTransition } from "./features/launch/LaunchTransition.js";
import { BackgroundProvider } from "./shared/ui/background/BackgroundProvider.js";
import { WorkspaceBackgroundLayer } from "./shared/ui/background/WorkspaceBackgroundLayer.js";

export function App(): React.JSX.Element {
  const [showLaunchTransition, setShowLaunchTransition] = useState(true);

  return (
    <BackgroundProvider>
      <DesktopThemeBridge />
      <WorkspaceBackgroundLayer />
      <AppShell />
      {showLaunchTransition ? (
        <LaunchTransition onFinished={() => setShowLaunchTransition(false)} />
      ) : null}
    </BackgroundProvider>
  );
}
