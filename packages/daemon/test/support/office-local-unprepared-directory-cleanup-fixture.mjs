import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

/** Delegate real filesystem and Registry operations; never replace a runtime, gate, scope or close fact. */
export function observeUnpreparedOfficeDirectoryStage(t, f, { changeParent = false, closeFailure, beforeClose } = {}) {
  const actual = { mkdtempSync: fs.mkdtempSync, openSync: fs.openSync, lstatSync: fs.lstatSync,
    closeSync: fs.closeSync, fstatSync: fs.fstatSync, mkdirSync: fs.mkdirSync };
  const held = [], patches = [];
  let stagePath, stageToken, changed = false, closeFaultEntered = false, concurrentParentCreates = 0;
  const fault = new Error(`original unprepared stage close ${closeFailure ?? "none"}`);
  patches.push(t.mock.method(fs, "mkdtempSync", (...args) => {
    const path = actual.mkdtempSync(...args);
    if (args[0] === "/private/tmp/ling-office-host-") stagePath = path;
    return path;
  }));
  patches.push(t.mock.method(fs, "openSync", (...args) => {
    const fd = actual.openSync(...args);
    if (stagePath && typeof args[0] === "string" && typeof args[1] === "number" && (args[1] & fs.constants.O_DIRECTORY) !== 0) {
      const stat = actual.fstatSync(fd, { bigint: true });
      held.push({ fd, path: args[0], device: stat.dev, inode: stat.ino, closeAttempts: 0, closeReturned: false });
    }
    return fd;
  }));
  const register = f.registry.registerStage.bind(f.registry);
  patches.push(t.mock.method(f.registry, "registerStage", input => {
    const token = register(input);
    if (input.stagePath === stagePath) stageToken = token;
    return token;
  }));
  patches.push(t.mock.method(fs, "lstatSync", (...args) => {
    if (changeParent && stageToken && args[0] === f.cwd && !changed) {
      // The exact reader ran before this external namespace change. The stage
      // has genuinely returned from Registry acquisition; this is the original
      // preparation revalidation, not a synthetic snapshot or fake runtime.
      changed = true; actual.mkdirSync(join(f.cwd, "reports")); concurrentParentCreates++;
    }
    return actual.lstatSync(...args);
  }));
  patches.push(t.mock.method(fs, "closeSync", fd => {
    const row = held.find(value => value.fd === fd);
    if (row) row.closeAttempts++;
    if (row) beforeClose?.(row);
    if (row && row.path === stagePath && closeFailure && !closeFaultEntered) {
      closeFaultEntered = true;
      if (closeFailure === "return-loss") { actual.closeSync(fd); row.closeReturned = true; }
      throw fault;
    }
    const result = actual.closeSync(fd);
    if (row) row.closeReturned = true;
    return result;
  }));
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const patch of [...patches].reverse()) patch.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { held, fault, restore, originalStat: fd => actual.fstatSync(fd, { bigint: true }),
    get stagePath() { return stagePath; }, get stageToken() { return stageToken; }, get changed() { return changed; },
    get concurrentParentCreates() { return concurrentParentCreates; }, get closeFaultEntered() { return closeFaultEntered; } };
}
