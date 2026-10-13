import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { restrictWindowsPathToCurrentUser, type BrowserHostCommandRunner } from "./windows-acl.js";

export interface DescriptorPermissionOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: BrowserHostCommandRunner;
  readonly username?: string;
}

const acquisitionTimeoutMs = 5_000;
const acquisitionRetryMs = 10;

/** Coordinate only cooperating descriptor writers, not arbitrary same-user processes. */
export async function withDescriptorCoordination<T>(
  descriptorPath: string,
  options: DescriptorPermissionOptions,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  const path = resolve(descriptorPath);
  const directory = dirname(path);
  const sidecar = `${path}.coordination.sqlite`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictPath(directory, true, options);
  // The inode must survive every operation and process lifetime. Never recreate it
  // to recover from contention: SQLite/OS owns transaction and crash recovery.
  try {
    const created = await open(sidecar, "wx", 0o600);
    await created.close();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await restrictPath(sidecar, false, options);

  let connection: DatabaseSync | undefined;
  let began = false;
  let result!: T;
  const failures: unknown[] = [];
  try {
    connection = new DatabaseSync(sidecar);
    connection.exec("PRAGMA busy_timeout=0");
    const deadline = performance.now() + acquisitionTimeoutMs;
    for (;;) {
      try {
        connection.exec("BEGIN IMMEDIATE");
        began = true;
        break;
      } catch (error) {
        // Node reports ERR_SQLITE_ERROR plus a numeric SQLite errcode. Only
        // primary SQLITE_BUSY from BEGIN is retryable, never operation effects.
        if (!isBusy(error)) throw error;
        if (performance.now() >= deadline) {
          throw new Error("browser_host_descriptor_lock_timeout", { cause: error });
        }
        await delay(acquisitionRetryMs);
      }
    }
    // Do not race a deadline against this promise: its FS effects must settle
    // while we still own the transaction. SQLite rollback does not undo FS.
    result = await operation(path);
  } catch (error) {
    failures.push(error);
  } finally {
    if (began) {
      try { connection!.exec("ROLLBACK"); }
      catch (error) { failures.push(error); }
    }
    if (connection) {
      try { connection.close(); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "browser_host_descriptor_operation_and_cleanup_failed");
  return result;
}

async function restrictPath(path: string, directory: boolean, options: DescriptorPermissionOptions): Promise<void> {
  if ((options.platform ?? process.platform) === "win32") {
    await restrictWindowsPathToCurrentUser(path, {
      directory,
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.username ? { username: options.username } : {}),
    });
  } else {
    await chmod(path, directory ? 0o700 : 0o600);
  }
}

function isBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "errcode" in error
    && typeof error.errcode === "number" && (error.errcode & 0xff) === 5);
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
