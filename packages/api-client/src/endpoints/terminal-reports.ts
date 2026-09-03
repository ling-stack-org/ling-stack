import type {
  TerminalReportListResponse,
  TerminalReportResponse,
  TerminalReportSourceKind,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const terminalReportEndpoints = {
  async listTerminalReports(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: {
      readonly threadId?: string;
      readonly sourceKind?: TerminalReportSourceKind;
      readonly sourceId?: string;
      readonly includeHistory?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<TerminalReportListResponse> {
    return this._get("/terminal-reports", {
      cwd,
      threadId: options.threadId,
      sourceKind: options.sourceKind,
      sourceId: options.sourceId,
      includeHistory: options.includeHistory,
      limit: options.limit,
    });
  },

  async getTerminalReport(
    this: LingDaemonEndpointContext,
    cwd: string,
    reportId: string,
  ): Promise<TerminalReportResponse> {
    return this._get(`/terminal-reports/${encodeURIComponent(reportId)}`, { cwd });
  },

  async listChannelTerminalReports(
    this: LingDaemonEndpointContext,
    cwd: string,
    channelId: string,
    options: {
      readonly threadId?: string;
      readonly sourceKind?: TerminalReportSourceKind;
      readonly sourceId?: string;
      readonly includeHistory?: boolean;
      readonly limit?: number;
    } = {},
  ): Promise<TerminalReportListResponse> {
    return this._get(`/channels/${encodeURIComponent(channelId)}/terminal-reports`, {
      cwd,
      threadId: options.threadId,
      sourceKind: options.sourceKind,
      sourceId: options.sourceId,
      includeHistory: options.includeHistory,
      limit: options.limit,
    });
  },
};

export type TerminalReportEndpoints = PublicEndpointGroup<typeof terminalReportEndpoints>;
