import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import {
  parseOfficeDriverResult,
  type OfficeDriverRequest,
  type OfficeDriverResult,
} from "@ling-stack/contracts";
import { encodeOfficeDriverFrame, OfficeDriverFrameDecoder } from "./framing.js";

interface PendingResult {
  readonly resolve: (result: OfficeDriverResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface OfficeDriverHelper {
  start(): Promise<void>;
  call(command: OfficeDriverRequest): Promise<OfficeDriverResult>;
  stop(): Promise<void>;
}

export class OfficeDriverHelperProcess implements OfficeDriverHelper {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingResult>();
  private stopping = false;

  constructor(private readonly options: {
    readonly executablePath: string;
    readonly recoveryRoot: string;
    readonly parentPid?: number;
    readonly onDiagnostic?: (event: string, details?: Readonly<Record<string, unknown>>) => void;
  }) {}

  async start(): Promise<void> {
    if (this.child) return;
    await access(this.options.executablePath);
    this.stopping = false;
    const child = spawn(this.options.executablePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        LING_OFFICE_PARENT_PID: String(this.options.parentPid ?? process.pid),
        LING_OFFICE_RECOVERY_ROOT: this.options.recoveryRoot,
      },
    });
    this.child = child;
    const decoder = new OfficeDriverFrameDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) this.acceptResult(value);
      } catch (error) {
        this.failProcess(error instanceof Error ? error : new Error("office_driver_protocol_failed"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.options.onDiagnostic?.("office_driver.helper_stderr", { bytes: chunk.byteLength });
    });
    child.once("error", (error) => this.failProcess(error));
    child.once("exit", (code, signal) => {
      this.child = undefined;
      const error = new Error(this.stopping ? "office_driver_stopped" : "office_driver_exited");
      this.rejectAll(error);
      this.options.onDiagnostic?.("office_driver.helper_exit", { code, signal });
    });
    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);
  }

  async call(command: OfficeDriverRequest): Promise<OfficeDriverResult> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) throw new Error("office_driver_not_running");
    if (this.pending.has(command.id)) throw new Error("office_driver_duplicate_command_id");
    const remaining = Date.parse(command.deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("office_driver_deadline_expired");
    const frame = encodeOfficeDriverFrame(command);
    const result = new Promise<OfficeDriverResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        reject(new Error("office_driver_helper_timeout"));
      }, remaining);
      this.pending.set(command.id, { resolve, reject, timer });
    });
    if (!child.stdin.write(frame)) await once(child.stdin, "drain");
    return await result;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    const exited = once(child, "exit").then(() => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    await Promise.race([exited, timeout]);
    if (this.child === child) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
    this.child = undefined;
    this.rejectAll(new Error("office_driver_stopped"));
  }

  private acceptResult(value: unknown): void {
    const result = parseOfficeDriverResult(value);
    const pending = this.pending.get(result.id);
    if (!pending) {
      this.failProcess(new Error("office_driver_unexpected_result"));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(result.id);
    pending.resolve(result);
  }

  private failProcess(error: Error): void {
    this.options.onDiagnostic?.("office_driver.helper_protocol_failed", { error: error.message });
    this.rejectAll(error);
    this.child?.kill("SIGKILL");
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
