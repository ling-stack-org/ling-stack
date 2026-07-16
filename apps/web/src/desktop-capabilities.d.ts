interface Window {
  readonly lingDesktop?: {
    readonly platform: "macos" | "windows" | "linux";
    readonly daemonBaseUrl: string;
    readonly computerUse: {
      reportLocale(locale: "en-US" | "zh-CN"): void;
      reportSelectedConversation(conversationId?: string): void;
      reportHostLayout(layout: {
        readonly windowBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
        readonly obstacles: readonly {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
          readonly kind:
            | "composer"
            | "approval"
            | "dock"
            | "terminal"
            | "modal"
            | "popover"
            | "unknown"
            | "other";
        }[];
        readonly reportedAt: string;
      }): void;
      show(sessionId: string): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
      hide(sessionId: string): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
      stop(sessionId: string): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
      getPreferences(): Promise<{ readonly previewAutoShow: boolean }>;
      setAutoShow(enabled: boolean): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
      onSummaryChanged(listener: (summary: {
        readonly sessionId: string;
        readonly conversationId: string;
        readonly status: "starting" | "running" | "waiting_for_approval" | "paused" | "stopping" | "succeeded" | "failed" | "cancelled";
        readonly targetLabel: string;
        readonly visible: boolean;
      } | undefined) => void): () => void;
    };
  };
}
