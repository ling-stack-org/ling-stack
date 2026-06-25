export const conversationDeferredContentReadyEvent = "conversation:deferred-content-ready";

export function notifyConversationDeferredContentReady(target: Element | null | undefined): void {
  if (!target) {
    return;
  }
  target.dispatchEvent(new CustomEvent(conversationDeferredContentReadyEvent, { bubbles: true }));
}
