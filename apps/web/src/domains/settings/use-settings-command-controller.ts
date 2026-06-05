import { useMemo } from "react";
import {
  getApprovalPolicy,
  getDaemonHealth,
  updateApprovalPolicy,
} from "../../api.js";

export function useSettingsCommandController() {
  return useMemo(() => ({
    getApprovalPolicy,
    getDaemonHealth,
    updateApprovalPolicy,
  }), []);
}
