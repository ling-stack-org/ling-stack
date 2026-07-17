import type {
  DesktopCommandResult,
  DesktopNavigationIntent,
} from "../shared/desktop-capabilities.js";

type NavigationIntentListener = (intent: DesktopNavigationIntent) => void;

interface PendingNavigationIntent {
  readonly intent: DesktopNavigationIntent;
  rendererAcknowledged: boolean;
  targetSelectionObserved: boolean;
}

export class DesktopNavigationIntentStore {
  private nextRequestId = 1;
  private pending: PendingNavigationIntent | undefined;
  private readonly listeners = new Set<NavigationIntentListener>();

  requestOpenConversation(conversationId: string): DesktopNavigationIntent | undefined {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      return undefined;
    }
    const intent: DesktopNavigationIntent = {
      kind: "open_conversation",
      requestId: this.nextRequestId,
      conversationId: normalizedConversationId,
    };
    this.nextRequestId += 1;
    this.pending = {
      intent,
      rendererAcknowledged: false,
      targetSelectionObserved: false,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(intent);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return intent;
  }

  getPendingIntent(): DesktopNavigationIntent | undefined {
    return this.pending?.intent;
  }

  acknowledge(requestId: number): DesktopCommandResult {
    if (this.pending?.intent.requestId !== requestId) {
      return { accepted: false, reason: "stale_navigation_intent" };
    }
    this.pending.rendererAcknowledged = true;
    this.completeIfReady();
    return { accepted: true };
  }

  /**
   * While an Open task intent is pending, ignore blank or stale renderer
   * selection reports. The target report and renderer ACK may arrive in either
   * order; the intent is cleared only after both have been observed.
   */
  acceptRendererSelection(conversationId?: string): boolean {
    if (!this.pending) {
      return true;
    }
    if (conversationId !== this.pending.intent.conversationId) {
      return false;
    }
    this.pending.targetSelectionObserved = true;
    this.completeIfReady();
    return true;
  }

  discard(requestId: number): boolean {
    if (this.pending?.intent.requestId !== requestId) {
      return false;
    }
    this.pending = undefined;
    return true;
  }

  onIntentChanged(listener: NavigationIntentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private completeIfReady(): void {
    if (this.pending?.rendererAcknowledged && this.pending.targetSelectionObserved) {
      this.pending = undefined;
    }
  }
}
