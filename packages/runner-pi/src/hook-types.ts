export const HOOK_EVENTS = ["run_start", "before_tool", "after_tool", "run_end"] as const;
export type PiHookEvent = (typeof HOOK_EVENTS)[number];
export interface PiHookDefinition {
  readonly id: string;
  readonly event: PiHookEvent;
  readonly tools?: readonly string[];
  readonly timeoutMs?: number;
  readonly failurePolicy?: "block" | "continue";
  readonly kind: "script" | "command";
  readonly code?: string;
  readonly command?: string;
}
export interface PiHookSet {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly hooks: readonly PiHookDefinition[];
}
export interface PiHookInvocation {
  readonly event: PiHookEvent;
  readonly toolCallId?: string;
  readonly parentToolCallId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}

export function readHookDefinitions(input: unknown): PiHookDefinition[] {
  if (!Array.isArray(input) || input.length > 32) throw new Error("hooks_definition_limit");
  const ids = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hooks_definition_invalid");
    const hook = value as Record<string, unknown>;
    const keys = ["id", "event", "tools", "timeoutMs", "failurePolicy", "kind", hook.kind === "script" ? "code" : "command"];
    if (Object.keys(hook).some(key => !keys.includes(key)) || typeof hook.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(hook.id)
      || ids.has(hook.id) || !(HOOK_EVENTS as readonly unknown[]).includes(hook.event)
      || !["script", "command"].includes(String(hook.kind))
      || hook.failurePolicy !== undefined && !["block", "continue"].includes(String(hook.failurePolicy))
      || hook.timeoutMs !== undefined && (!Number.isSafeInteger(hook.timeoutMs) || Number(hook.timeoutMs) < 10 || Number(hook.timeoutMs) > 30_000)
      || hook.tools !== undefined && (!Array.isArray(hook.tools) || hook.tools.length > 32
        || !hook.tools.every(tool => typeof tool === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(tool))
        || !["before_tool", "after_tool"].includes(String(hook.event)))) throw new Error("hooks_definition_invalid");
    const source = hook.kind === "script" ? hook.code : hook.command;
    if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > 16 * 1024 || source.includes("\0")) throw new Error("hooks_source_invalid");
    ids.add(hook.id);
    return structuredClone(hook) as unknown as PiHookDefinition;
  });
}

export function readHookSet(input: unknown): PiHookSet {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hooks_snapshot_invalid");
  const set = input as Record<string, unknown>;
  if (set.schemaVersion !== 1 || typeof set.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(set.digest)
    || Object.keys(set).some(key => !["schemaVersion", "digest", "hooks"].includes(key))) throw new Error("hooks_snapshot_invalid");
  return { schemaVersion: 1, digest: set.digest, hooks: readHookDefinitions(set.hooks) };
}
