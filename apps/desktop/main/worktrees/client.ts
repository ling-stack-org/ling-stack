import type { ManagedWorktreeListResponse, WorktreeInitializationChallenge } from "@ling-stack/contracts";
import type { DesktopWorktreeInitializationRequest } from "../../shared/worktree-capabilities.js";

export class DesktopWorktreeClient {
  constructor(private readonly options: { readonly baseUrl: string; readonly bridgeToken: string; readonly fetchImpl?: typeof fetch }) {}
  async prepare(request: DesktopWorktreeInitializationRequest): Promise<WorktreeInitializationChallenge> {
    return this.request(request.cwd, "prepare", { ownerKind: request.ownerKind, ownerId: request.ownerId });
  }
  async complete(cwd: string, challengeId: string, confirmed: boolean): Promise<ManagedWorktreeListResponse | undefined> {
    return this.request(cwd, "complete", { challengeId, confirmed });
  }
  private async request<T>(cwd: string, action: string, body: unknown): Promise<T> {
    const url = new URL(`/worktrees/initialization/${action}`, this.options.baseUrl);
    url.searchParams.set("cwd", cwd);
    const response = await (this.options.fetchImpl ?? fetch)(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(610_000),
      headers: { "content-type": "application/json", "x-ling-desktop-bridge-token": this.options.bridgeToken }, body: JSON.stringify(body) });
    const reader = response.body?.getReader();
    let text = "", bytes = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("worktree_response_too_large"); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    const result = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "worktree_initialization_unavailable");
    return result as T;
  }
}
