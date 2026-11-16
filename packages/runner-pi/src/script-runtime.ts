import { CodemodeSandbox, type CodemodeResult, type CodemodeTool } from "@earendil-works/pi-codemode";

let workers = 0;
export const SCRIPT_MAX_CODE_BYTES = 64 * 1024;

/** Each script gets an ephemeral VM; worker capacity is released only on actual exit. */
export async function runBoundedScript(input: {
  code: string; signal?: AbortSignal; timeoutMs?: number; tools?: CodemodeTool[];
}): Promise<CodemodeResult> {
  if (typeof input.code !== "string" || Buffer.byteLength(input.code) > SCRIPT_MAX_CODE_BYTES) throw new Error("script_code_limit");
  input.signal?.throwIfAborted();
  const sandbox = new CodemodeSandbox({
    tools: input.tools ?? [], timeoutMs: input.timeoutMs ?? 30_000, memoryLimitBytes: 64 * 1024 * 1024,
    acquireWorker: () => {
      input.signal?.throwIfAborted();
      if (workers >= 4) throw new Error("script_worker_capacity");
      workers++; return () => { workers--; };
    },
  });
  try { return await sandbox.execute(input.code, { signal: input.signal }); }
  finally { await sandbox.close(); }
}

export function boundedScriptText(result: CodemodeResult, maxBytes = 32 * 1024): { text: string; truncated: boolean } {
  const parts = result.output.filter(item => item.type === "text").map(item => item.text);
  if (result.ok && result.value !== undefined) parts.push(JSON.stringify(result.value));
  if (!result.ok) parts.push(`Script error (${result.error.kind}): ${result.error.message}`);
  const buffer = Buffer.from(parts.join("\n"));
  const truncated = buffer.length > maxBytes;
  return { text: truncated ? buffer.subarray(0, maxBytes - 64).toString("utf8") + "\n[Script output truncated]" : buffer.toString("utf8"), truncated };
}
