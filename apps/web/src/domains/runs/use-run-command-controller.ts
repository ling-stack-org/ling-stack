import { useMemo } from "react";
import {
  buildRerunRequest,
  buildRunRequest,
  buildTaskRunRequest,
  daemonBaseUrl,
} from "../../api.js";

export function useRunCommandController() {
  return useMemo(() => ({
    buildRerunRequest,
    buildRunRequest,
    buildTaskRunRequest,
    daemonBaseUrl,
  }), []);
}
