interface Window {
  readonly lingDesktop?: {
    readonly platform: "macos" | "windows" | "linux";
    readonly daemonBaseUrl: string;
    readonly navigation: {
      acknowledgeIntent(requestId: number): Promise<{ readonly accepted: boolean; readonly reason?: string }>;
      onIntent(listener: (intent: {
        readonly kind: "open_conversation";
        readonly requestId: number;
        readonly conversationId: string;
      }) => void): () => void;
    };
    readonly computerUse: {
      reportLocale(locale: "en-US" | "zh-CN"): void;
      reportSelectedDeckOwner(owner?: {
        readonly surfaceKind: "channel" | "normal_conversation" | "teammate_direct";
        readonly ownerId: string;
      }): void;
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
        readonly previewAvailable: boolean;
        readonly visible: boolean;
        readonly activePageId?: string;
        readonly pageCount: number;
      } | undefined) => void): () => void;
    };
  };
}
