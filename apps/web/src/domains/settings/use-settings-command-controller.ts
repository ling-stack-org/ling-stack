import { useMemo } from "react";
import { getDaemonHealth } from "../../api.js";

export function useSettingsCommandController() {
  return useMemo(() => ({
    getDaemonHealth,
  }), []);
}
