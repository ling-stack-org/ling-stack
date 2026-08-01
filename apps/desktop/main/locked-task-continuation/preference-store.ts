import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockedTaskContinuationPreference {
  readonly schemaVersion: 1;
  readonly continueWhileLocked: boolean;
}

export const DEFAULT_LOCKED_TASK_CONTINUATION_PREFERENCE: LockedTaskContinuationPreference =
  Object.freeze({
    schemaVersion: 1,
    continueWhileLocked: true,
  });

export interface LockedTaskContinuationPreferenceStore {
  load(): Promise<LockedTaskContinuationPreference>;
  save(preference: LockedTaskContinuationPreference): Promise<void>;
}

export class FileLockedTaskContinuationPreferenceStore
implements LockedTaskContinuationPreferenceStore {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<LockedTaskContinuationPreference> {
    try {
      return sanitizeLockedTaskContinuationPreference(
        JSON.parse(await readFile(this.filePath, "utf8")) as unknown,
      );
    } catch {
      return DEFAULT_LOCKED_TASK_CONTINUATION_PREFERENCE;
    }
  }

  save(preference: LockedTaskContinuationPreference): Promise<void> {
    const sanitized = sanitizeLockedTaskContinuationPreference(preference);
    const operation = this.saveQueue.then(() => this.writePreference(sanitized));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }

  private async writePreference(preference: LockedTaskContinuationPreference): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(preference, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.filePath), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function sanitizeLockedTaskContinuationPreference(
  value: unknown,
): LockedTaskContinuationPreference {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.continueWhileLocked !== "boolean") {
    return DEFAULT_LOCKED_TASK_CONTINUATION_PREFERENCE;
  }
  return Object.freeze({
    schemaVersion: 1,
    continueWhileLocked: value.continueWhileLocked,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
