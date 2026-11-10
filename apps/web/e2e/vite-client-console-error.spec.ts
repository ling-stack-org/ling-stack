import { expect, test, type ConsoleMessage } from "@playwright/test";
import { isViteClientTransportError } from "./support/vite-client-console-error";

function consoleMessage(text: string, url: string): ConsoleMessage {
  return {
    type: () => "error",
    text: () => text,
    location: () => ({ url, lineNumber: 1, columnNumber: 1 }),
  } as unknown as ConsoleMessage;
}

test("only Vite's disconnected development client logger is excluded", () => {
  const text = "Failed to send error to Vite server: TypeError: Cannot read properties of undefined (reading 'send')";
  expect(isViteClientTransportError(consoleMessage(text, "http://127.0.0.1:4175/@vite/client"))).toBe(true);
  expect(isViteClientTransportError(consoleMessage(text, "http://127.0.0.1:4175/src/app/AppShell.tsx"))).toBe(false);
  expect(isViteClientTransportError(consoleMessage("Vite compile failed", "http://127.0.0.1:4175/@vite/client"))).toBe(false);
});
