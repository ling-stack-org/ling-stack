import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { record } from "./locked-use-release-evidence.ts";

export function run(path: string, args: readonly string[], input?: string): string {
  const result = spawnSync(path, [...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
    input,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  if (result.error || result.status !== 0) throw new Error("locked_use_release_command_failed:" + path);
  return result.stdout + "\n" + result.stderr;
}
export async function bounded(path: string, limit = 64 * 1024): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("locked_use_release_file_invalid:" + path);
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error("locked_use_release_file_oversized:" + path);
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function hashFile(path: string): Promise<string> {
  const limit = 128 * 1024 * 1024;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error("locked_use_release_file_invalid:" + path);
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Error("locked_use_release_file_oversized:" + path);
      hash.update(bytes.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw new Error("locked_use_release_file_changed:" + path);
    return hash.digest("hex");
  } finally { await handle.close(); }
}
export function signature(path: string, identifier: string, team: string): string {
  run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "--test-requirement",
    'identifier "' + identifier + '" and anchor apple generic and certificate leaf[subject.OU] = "' + team
      + '" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', path]);
  const metadata = run("/usr/bin/codesign", ["--display", "--verbose=4", path]);
  const hash = metadata.match(/^CDHash=([a-f0-9]{40,64})$/mu)?.[1];
  const flags = metadata.match(/\bflags=0x([a-f0-9]+)\b/iu)?.[1];
  if (!hash || !flags || !(Number.parseInt(flags, 16) & 0x10000)) throw new Error("locked_use_release_signature_invalid");
  const entitlements = run("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", path]);
  const start = entitlements.indexOf("<plist");
  if (start >= 0) {
    const end = entitlements.indexOf("</plist>", start);
    if (end < 0) throw new Error("locked_use_release_entitlements_invalid");
    const parsed: unknown = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"],
      entitlements.slice(start, end + "</plist>".length)).trim());
    const injection = ["com.apple.security.get-task-allow", "get-task-allow", "com.apple.security.cs.disable-library-validation",
      "com.apple.security.cs.allow-dyld-environment-variables", "com.apple.security.cs.allow-unsigned-executable-memory"];
    if (!record(parsed) || injection.some((key) => parsed[key] === true || typeof parsed[key] === "number" && parsed[key] !== 0)) {
      throw new Error("locked_use_release_entitlements_invalid");
    }
  }
  return hash;
}
