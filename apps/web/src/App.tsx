import { useState } from "react";
import { AppShell } from "./app/AppShell.js";
import { DesktopThemeBridge } from "./app/DesktopThemeBridge.js";
import { LaunchTransition } from "./features/launch/LaunchTransition.js";

export function App(): React.JSX.Element {
  const [showLaunchTransition, setShowLaunchTransition] = useState(true);

  return (
    <>
      <DesktopThemeBridge />
      <AppShell />
      {showLaunchTransition ? (
        <LaunchTransition onFinished={() => setShowLaunchTransition(false)} />
      ) : null}
    </>
  );
}
