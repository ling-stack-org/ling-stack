import { useEffect, useRef } from "react";

export function useDesktopNavigationIntents(
  enabled: boolean,
  openConversation: (
    conversationId: string,
    isCurrentIntent: () => boolean,
  ) => Promise<boolean> | boolean,
): void {
  const openConversationRef = useRef(openConversation);
  openConversationRef.current = openConversation;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const navigation = window.lingDesktop?.navigation;
    if (!navigation) {
      return undefined;
    }
    let active = true;
    let highestSeenRequestId = 0;

    const openIntent = async (
      intent: Parameters<Parameters<typeof navigation.onIntent>[0]>[0],
    ): Promise<void> => {
      const isCurrentIntent = (): boolean => active && intent.requestId === highestSeenRequestId;
      let opened = false;
      try {
        opened = await openConversationRef.current(intent.conversationId, isCurrentIntent);
      } catch {
        return;
      }
      if (!opened || !isCurrentIntent()) {
        return;
      }
      try {
        await navigation.acknowledgeIntent(intent.requestId);
      } catch {
        // Main retains unacknowledged intent for a later renderer/window.
      }
    };

    const unsubscribe = navigation.onIntent((intent) => {
      if (intent.requestId <= highestSeenRequestId) {
        return;
      }
      highestSeenRequestId = intent.requestId;
      void openIntent(intent);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled]);
}
