// QA startup identity reader. It never creates, rotates or logs bridge tokens.
import assert from "node:assert/strict";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";

export async function readExistingPrivateToken(path) {
  const before = lstatSync(path, { bigint: true });
  const valid = stat => stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid())
    && (stat.mode & 0o7777n) === 0o600n && stat.nlink === 1n && stat.size >= 32n && stat.size <= 256n;
  assert.ok(valid(before) && realpathSync(path) === path, "Existing private QA bridge identity required");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await fd.stat({ bigint: true });
    assert.ok(valid(opened) && opened.ino === before.ino && opened.dev === before.dev);
    const value = await fd.readFile("utf8");
    const after = await fd.stat({ bigint: true });
    assert.ok(valid(after) && after.size === opened.size && after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs);
    // A value-bearing AssertionError would expose private input on failed startup.
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value.trim())) throw new Error("QA_BRIDGE_IDENTITY_FORMAT_INVALID");
    return value.trim();
  } finally { await fd.close(); }
}
