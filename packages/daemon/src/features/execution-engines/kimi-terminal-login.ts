import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { NativeConnectionError } from "./codex-connection.js";
import { buildNativeProcessEnvironment, killOwnedProbe } from "./installation-probe.js";
import { kimiNativeEnvironment } from "./kimi-native-executable.js";

/** Official non-interactive login command; output is human text, never a protocol. */
export function runKimiTerminalLogin(executable: string, root: string, home: string, options: {
  readonly region: "mainland-cn" | "global";
  readonly signal: AbortSignal;
  readonly spawn: typeof spawn;
  readonly onStarted: () => void;
  readonly onOutput: (text: string) => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  const child = options.spawn(executable, ["acp", "--login", "--region", options.region], {
    cwd: root, env: { ...buildNativeProcessEnvironment(process.env, root), ...kimiNativeEnvironment(root, home) },
    shell: false, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let failure: NativeConnectionError | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let bytes = 0;
    let text = "";
    const release: (() => void)[] = [];
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(cleanupTimer);
      options.signal.removeEventListener("abort", aborted);
      child.off("spawn", started).off("error", failed).off("exit", cleanup).off("close", closed);
      for (const remove of release) remove();
      text = "";
      if (failure) reject(failure); else resolve();
    };
    const cleanup = (): void => {
      killOwnedProbe(child);
      cleanupTimer ??= setTimeout(() => {
        failure = new NativeConnectionError("cleanup_failed");
        killOwnedProbe(child);
        child.stdout?.destroy(); child.stderr?.destroy();
        finish();
      }, 1000);
    };
    const stop = (code: NativeConnectionError["code"]): void => {
      if (settled) return;
      failure ??= new NativeConnectionError(code);
      cleanup();
    };
    const aborted = (): void => stop("cancelled");
    const failed = (): void => stop("process_failed");
    const publish = (value: string): void => {
      if (settled || failure) return;
      text += value;
      try {
        options.onOutput(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
      } catch { failed(); }
    };
    const started = (): void => {
      if (settled || failure) return;
      try { options.onStarted(); publish(""); } catch { failed(); }
    };
    const closed = (code: number | null): void => {
      if (code !== 0) failure ??= new NativeConnectionError("login_failed");
      if (options.signal.aborted) failure ??= new NativeConnectionError("cancelled");
      finish();
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) { failed(); continue; }
      const decoder = new StringDecoder("utf8");
      const data = (chunk: Buffer): void => {
        if (settled || failure) return;
        bytes += chunk.length;
        if (bytes > 64 * 1024) { stop("output_limit"); return; }
        publish(decoder.write(chunk));
      };
      const end = (): void => publish(decoder.end());
      stream.on("data", data).on("error", failed).once("end", end);
      release.push(() => stream.off("data", data).off("error", failed).off("end", end));
    }
    child.once("spawn", started).once("error", failed).once("exit", cleanup).once("close", closed);
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) aborted();
  });
}
