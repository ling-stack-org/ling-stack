import { readSync } from "node:fs";

// Only the owning host captures this worker's output. It has no network or shell API.
async function main(): Promise<void> {
  const [operation, name] = process.argv.slice(2);
  if (process.argv.length !== 4 || !name || !/^ling-engine-[0-9a-f-]{36}$/.test(name)
    || !["read", "status", "write", "remove"].includes(operation ?? "")
    || !["darwin", "win32"].includes(process.platform)) throw new Error();
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry("ling-stack.execution-engine", name);
  let result: unknown;
  if (operation === "write") {
    const buffer = Buffer.alloc(2049);
    try {
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(0, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (length > 2048 || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error();
      if (entry.getPassword() !== null) throw new Error();
      entry.setPassword(value);
      if (entry.getPassword() !== value) throw new Error();
      result = { stored: true };
    } finally { buffer.fill(0); }
  } else if (operation === "remove") {
    entry.deleteCredential();
    if (entry.getPassword() !== null) throw new Error();
    result = { absent: true };
  } else {
    const value = entry.getPassword();
    result = operation === "status" ? { configured: value !== null } : { value };
  }
  process.stdout.write(JSON.stringify(result));
}

void main().catch(() => { process.exitCode = 1; });
