import type { ConsoleMessage } from "@playwright/test";

const viteTransportFailure = "Failed to send error to Vite server: TypeError: Cannot read properties of undefined (reading 'send')";

/** Ignore only Vite's own disconnected development-client logger, never application errors. */
export function isViteClientTransportError(message: ConsoleMessage): boolean {
  return message.type() === "error"
    && message.text().startsWith(viteTransportFailure)
    && /\/@vite\/client(?:\?|$)/u.test(message.location().url);
}
