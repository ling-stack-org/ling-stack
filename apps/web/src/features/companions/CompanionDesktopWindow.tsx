import { useEffect, useState } from "react";
import type { AiTeammate } from "../../types.js";
import { listAiTeammates } from "../../api.js";
import { CompanionMiniPanel } from "./CompanionMiniPanel.js";

export function CompanionDesktopWindow(): React.JSX.Element {
  const capabilities = window.lingCompanionDesktop!;
  const [teammates, setTeammates] = useState<readonly AiTeammate[]>([]);
  useEffect(() => {
    let current = true;
    void listAiTeammates(capabilities.cwd).then((response) => {
      if (current) setTeammates(response.teammates);
    }).catch(() => { /* The panel presents daemon connection errors and reconnect controls. */ });
    return () => { current = false; };
  }, [capabilities.cwd]);
  return <CompanionMiniPanel cwd={capabilities.cwd} teammates={teammates} open desktop
    onClose={() => { void capabilities.close(); }}
    onOpenSettings={() => { void capabilities.openSettings(); }} />;
}
