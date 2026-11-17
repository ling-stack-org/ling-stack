import { Worker } from "node:worker_threads";

/** Validates bounded JSON Schema arguments without letting page schemas block Desktop main. */
export async function validateWebToolArguments(schema: Record<string, unknown>, args: object, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (JSON.stringify(schema).length > 65_536 || JSON.stringify(args).length > 16_384) throw new Error("browser_webmcp_schema_too_large");
  let nodes = 0;
  const bounded = (value: unknown, depth: number): void => {
    if (++nodes > 4000 || depth > 30) throw new Error("browser_webmcp_schema_too_complex");
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "$ref" || key === "$dynamicRef") && typeof item === "string" && !item.startsWith("#")) throw new Error("browser_webmcp_schema_external_ref_forbidden");
      if (key === "$async") throw new Error("browser_webmcp_schema_async_forbidden");
      bounded(item, depth + 1);
    }
  };
  bounded(schema, 0);
  const worker = new Worker(new URL("./schema-worker.js", import.meta.url), {
    workerData: { schema, args }, resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("browser_webmcp_schema_timeout")), 1500);
      const abort = (): void => reject(signal.reason ?? new Error("browser_cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      const clean = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      worker.once("message", (message: { valid?: boolean; invalidSchema?: boolean }) => {
        clean();
        if (message.invalidSchema) reject(new Error("browser_webmcp_schema_invalid"));
        else if (!message.valid) reject(new Error("browser_webmcp_arguments_invalid"));
        else resolve();
      });
      worker.once("error", error => { clean(); reject(error); });
      worker.once("exit", code => { clean(); reject(new Error(`browser_webmcp_schema_worker_exited:${code}`)); });
    });
    signal.throwIfAborted();
  } finally { await worker.terminate(); }
}
