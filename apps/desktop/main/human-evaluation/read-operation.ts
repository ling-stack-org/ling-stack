import type { HumanEvaluationConnection, HumanEvaluationDaemonClient } from "./daemon-client.js";
import { sameHumanSession, type HumanEvaluationNativeBridge } from "./native-bridge.js";

/** Read-only operations still require the exact owner/session both before and after connection cleanup. */
export async function readWithHumanEvaluationAuthority<T>(options: {
  readonly desktopInstanceId: string;
  readonly desktopEpoch: string;
  readonly lockEpoch: string;
  readonly workspaceCwd: string;
  readonly native: HumanEvaluationNativeBridge;
  readonly daemon: HumanEvaluationDaemonClient;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly read: (connection: HumanEvaluationConnection) => Promise<T>;
}): Promise<T> {
  let connection: HumanEvaluationConnection | undefined;
  const retire = async (): Promise<void> => {
    const old = connection;
    connection = undefined;
    if (old) { try { await options.daemon.revoke(old.authority); } catch { /* Reads never grant new authority on cleanup errors. */ } }
  };
  const assertCurrent = (): void => {
    if (!options.current()) throw new Error("human_read_authority_changed");
  };
  try {
    const before = await options.native.readSession(options.signal);
    assertCurrent();
    if (!before.active || before.locked) throw new Error("human_read_authority_changed");
    connection = await options.daemon.handshake({ platform: "darwin", desktopInstanceId: options.desktopInstanceId,
      desktopEpoch: options.desktopEpoch, workspaceCwd: options.workspaceCwd,
      session: { osSessionId: before.osSessionId, osUserId: before.osUserId, lockEpoch: options.lockEpoch, locked: false } }, options.signal);
    assertCurrent();
    const authority = connection.authority;
    if (connection.workspaceCwd !== options.workspaceCwd || authority.desktopInstanceId !== options.desktopInstanceId
      || authority.desktopEpoch !== options.desktopEpoch || authority.lockEpoch !== options.lockEpoch
      || authority.osSessionId !== before.osSessionId || authority.osUserId !== before.osUserId) {
      throw new Error("human_read_authority_changed");
    }
    const result = await options.read(connection);
    assertCurrent();
    const after = await options.native.readSession(options.signal);
    assertCurrent();
    if (!sameHumanSession(before, after)) throw new Error("human_read_authority_changed");
    await retire();
    assertCurrent();
    // Cleanup is asynchronous; a lock/user switch during it cannot disclose a cached response.
    const finalSession = await options.native.readSession(options.signal);
    assertCurrent();
    if (!sameHumanSession(before, finalSession)) throw new Error("human_read_authority_changed");
    return result;
  } finally { if (connection) await retire(); }
}
