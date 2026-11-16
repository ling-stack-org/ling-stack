import { DESKTOP_BROWSER_MAX_RESULT_BYTES, parseDesktopBrowserCommand, type DesktopBrowserCommand, type DesktopBrowserState, type DesktopBrowserResult } from "@ling-stack/contracts";

const ROOT = "/desktop/capabilities/browser";
export class DesktopBrowserDaemonClient {
  constructor(private readonly options: { readonly daemonBaseUrl: string; readonly bridgeToken: string }) {}

  async publish(state: DesktopBrowserState, signal: AbortSignal): Promise<string> {
    const value = await this.request("/availability", state, state, signal);
    if (typeof value.runtimeId !== "string") throw new Error("browser_runtime_identity_missing");
    return value.runtimeId;
  }
  async claim(state: DesktopBrowserState, signal: AbortSignal): Promise<DesktopBrowserCommand | undefined> {
    const value = await this.request("/commands/claim", {}, state, signal);
    return value.command === undefined ? undefined : parseDesktopBrowserCommand(value.command);
  }
  async start(command: DesktopBrowserCommand, signal: AbortSignal): Promise<void> { await this.request(`/commands/${command.id}/start`, {}, command, signal); }
  async cancelled(command: DesktopBrowserCommand, signal: AbortSignal): Promise<boolean> {
    return (await this.request(`/commands/${command.id}/cancelled`, {}, command, signal)).cancelled === true;
  }
  async complete(state: DesktopBrowserState, result: DesktopBrowserResult, signal: AbortSignal): Promise<void> {
    await this.request(`/commands/${result.id}/result`, result, state, signal);
  }

  private async request(path: string, body: unknown, authority: Pick<DesktopBrowserState, "desktopInstanceId" | "generation">, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(`${ROOT}${path}`, this.options.daemonBaseUrl), {
      method: "POST", headers: { "content-type": "application/json", "x-ling-desktop-bridge-token": this.options.bridgeToken,
        "x-ling-browser-instance": authority.desktopInstanceId, "x-ling-browser-generation": String(authority.generation) },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const reader = response.body?.getReader();
    let text = "", bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > DESKTOP_BROWSER_MAX_RESULT_BYTES) { await reader.cancel(); throw new Error("browser_response_too_large"); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_response_invalid");
    if (!response.ok) throw new Error(typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : "browser_bridge_request_failed");
    return value as Record<string, unknown>;
  }
}
