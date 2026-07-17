import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadOrCreateDesktopBridgeToken } from "../dist/main/bridge-token.js";

const execFileAsync = promisify(execFile);
const bridgeTokenModuleUrl = new URL("../dist/main/bridge-token.js", import.meta.url).href;

test("desktop bridge token replaces a short existing value atomically", async () => {
  await withTemporaryTokenFile(async (directory, path) => {
    await writeFile(path, "short\n", { mode: 0o600 });

    const token = await loadOrCreateDesktopBridgeToken(path);

    assert.ok(token.length >= 32);
    assert.notEqual(token, "short");
    assert.equal((await readFile(path, "utf8")).trim(), token);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await readdir(directory), ["desktop-bridge-token"]);
  });
});

test("desktop bridge token replaces an empty existing value", async () => {
  await withTemporaryTokenFile(async (_directory, path) => {
    await writeFile(path, "", { mode: 0o600 });

    const token = await loadOrCreateDesktopBridgeToken(path);

    assert.ok(token.length >= 32);
    assert.equal((await readFile(path, "utf8")).trim(), token);
  });
});

test("concurrent invalid bridge token recovery shares one replacement", async () => {
  await withTemporaryTokenFile(async (_directory, path) => {
    await writeFile(path, "short\n", { mode: 0o600 });

    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => loadOrCreateDesktopBridgeToken(path)),
    );

    assert.equal(new Set(tokens).size, 1);
    assert.equal((await readFile(path, "utf8")).trim(), tokens[0]);
  });
});

test(
  "desktop bridge token tightens a valid POSIX file to mode 0600",
  { skip: process.platform === "win32" },
  async () => {
    await withTemporaryTokenFile(async (_directory, path) => {
      const existing = "existing-desktop-bridge-token-value";
      await writeFile(path, `${existing}\n`, { mode: 0o600 });
      await chmod(path, 0o666);

      assert.notEqual((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await loadOrCreateDesktopBridgeToken(path), existing);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    });
  },
);

test("concurrent desktop processes converge on one published bridge token", async () => {
  await withTemporaryTokenFile(async (_directory, path) => {
    const childScript = [
      "const { loadOrCreateDesktopBridgeToken } = await import(process.argv[1]);",
      "process.stdout.write(await loadOrCreateDesktopBridgeToken(process.argv[2]));",
    ].join("\n");
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(process.execPath, [
          "--input-type=module",
          "--eval",
          childScript,
          bridgeTokenModuleUrl,
          path,
        ]),
      ),
    );
    const tokens = results.map(({ stdout }) => stdout);

    assert.equal(new Set(tokens).size, 1);
    assert.ok(tokens[0].length >= 32);
    assert.equal((await readFile(path, "utf8")).trim(), tokens[0]);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  });
});

async function withTemporaryTokenFile(run) {
  const directory = await mkdtemp(join(tmpdir(), "ling-desktop-bridge-token-"));
  const path = join(directory, "desktop-bridge-token");
  try {
    await run(directory, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
