import { AppShell } from "./app/AppShell.js";
import { DesktopThemeBridge } from "./app/DesktopThemeBridge.js";

export function App(): JSX.Element {
  return (
    <>
      <DesktopThemeBridge />
      <AppShell />
    </>
  );
}
