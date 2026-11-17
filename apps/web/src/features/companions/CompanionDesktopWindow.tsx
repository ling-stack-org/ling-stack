import { useEffect, useState } from "react";
import type { AiTeammate } from "../../types.js";
import { listAiTeammates } from "../../api.js";
import { CompanionMiniPanel } from "./CompanionMiniPanel.js";

const teammateRetryDelayMs = 5_000;

export function CompanionDesktopWindow(): React.JSX.Element {
  const capabilities = window.lingCompanionDesktop!;
  const [teammates, setTeammates] = useState<readonly AiTeammate[]>([]);
  useEffect(() => {
    let current = true;
    let timer: number | undefined;
    const load = (): void => {
      void listAiTeammates(capabilities.cwd).then((response) => {
        if (current) setTeammates(response.teammates);
      }).catch(() => {
        if (current) timer = window.setTimeout(load, teammateRetryDelayMs);
      });
    };
    load();
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [capabilities.cwd]);
  return <CompanionMiniPanel cwd={capabilities.cwd} teammates={teammates} open desktop
    onClose={() => { void capabilities.close(); }}
    onOpenSettings={() => { void capabilities.openSettings(); }} />;
}
