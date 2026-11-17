import { useEffect, useRef } from "react";

export function useDesktopCompanionSettings(open: () => void): void {
  const callback = useRef(open);
  callback.current = open;
  useEffect(() => window.lingDesktop?.companionWindow?.onSettingsRequested(() => callback.current()), []);
}
