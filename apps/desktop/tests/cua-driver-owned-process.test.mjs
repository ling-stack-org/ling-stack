import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runOwnedProcess } from "../scripts/cua-driver-owned-process.mjs";
import { run as runSourceBuildCommand } from "../scripts/cua-driver-source-build-lib.mjs";

const OWNED_PROCESS_MODULE_URL = new URL(
  "../scripts/cua-driver-owned-process.mjs",
  import.meta.url,
).href;
const GRANDCHILD_SCRIPT = "setInterval(() => {}, 1_000);";
const PROCESS_TREE_SCRIPT = `
  const { spawn } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const mode = process.argv[2];
  const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD_SCRIPT)}], {
    stdio: mode.startsWith("silent-")
      ? "ignore"
      : ["ignore", "inherit", "inherit"],
  });
  grandchild.unref();
  writeFileSync(process.argv[1], String(grandchild.pid));
  if (mode.endsWith("linger")) {
    setInterval(() => {}, 1_000);
  } else if (mode === "overflow") {
    process.stdout.write("x".repeat(128 * 1_024));
    setInterval(() => {}, 1_000);
  } else if (mode === "stderr-overflow") {
    process.stderr.write("x".repeat(128 * 1_024));
    setInterval(() => {}, 1_000);
  } else {
    process.stdout.write("parent-complete\\n");
  }
`;
const NESTED_PROCESS_TREE_SCRIPT = `
  const { spawn } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD_SCRIPT)}], {
    stdio: "ignore",
  });
  grandchild.unref();
  writeFileSync(process.argv[1], String(grandchild.pid));
  setInterval(() => {}, 1_000);
`;
const NESTED_OWNER_SCRIPT = `
  (async () => {
    const { runOwnedProcess } = await import(process.argv[1]);
    await runOwnedProcess(
      process.execPath,
      ["-e", process.argv[2], process.argv[3]],
      { encoding: "utf8", maxBuffer: 64 * 1_024, timeout: 30_000 },
    );
  })().catch((error) => {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
  });
`;
const NESTED_SUCCESS_OWNER_SCRIPT = `
  (async () => {
    const { runOwnedProcess } = await import(process.argv[1]);
    const result = await runOwnedProcess(
      process.execPath,
      ["-e", process.argv[2], process.argv[3], "success"],
      { encoding: "utf8", maxBuffer: 64 * 1_024, timeout: 5_000 },
    );
    process.stdout.write(\`nested:\${result.stdout}\`);
  })().catch((error) => {
    process.stderr.write(String(error?.stack || error));
    process.exitCode = 1;
  });
`;
const FORGED_GROUP_MARKER_SCRIPT = `
  (async () => {
    const { runOwnedProcess } = await import(process.argv[1]);
    try {
      await runOwnedProcess(process.execPath, ["-e", "process.exit(0)"]);
      process.stdout.write("unexpected-success");
    } catch (error) {
      process.stdout.write(String(error?.code || error));
    }
  })();
`;

test("owned runner timeout terminates the entire process tree", async (t) => {
  const fixture = await processFixture(t, "timeout-grandchild.pid");
  const { pidPath } = fixture;

  await assert.rejects(
    runOwnedProcess(
      process.execPath,
      ["-e", PROCESS_TREE_SCRIPT, pidPath, "silent-linger"],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 1_000 },
    ),
    (error) => {
      assert.equal(error?.code, "ETIMEDOUT");
      assert.equal(error?.killed, true);
      return true;
    },
  );

  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  assert.equal(Number.isSafeInteger(grandchildPid), true);
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("owned runner maxBuffer failure terminates the entire process tree", async (t) => {
  const fixture = await processFixture(t, "max-buffer-grandchild.pid");
  const { pidPath } = fixture;

  await assert.rejects(
    runOwnedProcess(
      process.execPath,
      ["-e", PROCESS_TREE_SCRIPT, pidPath, "overflow"],
      { encoding: "utf8", maxBuffer: 1_024, timeout: 5_000 },
    ),
    (error) => {
      assert.equal(error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.equal(error?.stream, "stdout");
      assert.equal(error?.killed, true);
      return true;
    },
  );

  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("owned runner abort terminates the entire process tree", async (t) => {
  const fixture = await processFixture(t, "abort-grandchild.pid");
  const { pidPath } = fixture;
  const controller = new AbortController();
  const run = runOwnedProcess(
    process.execPath,
    ["-e", PROCESS_TREE_SCRIPT, pidPath, "silent-linger"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      signal: controller.signal,
      timeout: 5_000,
    },
  );
  await waitForFile(pidPath);
  controller.abort(new Error("test abort"));

  await assert.rejects(run, (error) => {
    assert.equal(error?.name, "AbortError");
    assert.equal(error?.code, "ABORT_ERR");
    assert.equal(error?.killed, true);
    return true;
  });

  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("owned runner rejects a pre-aborted signal before candidate side effects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-owned-process-pre-abort-"));
  const markerPath = join(root, "candidate-started");
  t.after(() => rm(root, { force: true, recursive: true }));
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted by test"));

  await assert.rejects(
    runOwnedProcess(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'started')",
        markerPath,
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1_024,
        signal: controller.signal,
        timeout: 5_000,
      },
    ),
    (error) => {
      assert.equal(error?.name, "AbortError");
      assert.equal(error?.code, "ABORT_ERR");
      return true;
    },
  );
  await assert.rejects(readFile(markerPath), { code: "ENOENT" });
});

test("owned runner preserves nonzero exit diagnostics", async () => {
  await assert.rejects(
    runOwnedProcess(
      process.execPath,
      [
        "-e",
        "process.stdout.write('child-stdout'); process.stderr.write('child-stderr'); process.exit(17)",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1_024, timeout: 5_000 },
    ),
    (error) => {
      assert.equal(error?.code, 17);
      assert.equal(error?.stdout, "child-stdout");
      assert.equal(error?.stderr, "child-stderr");
      return true;
    },
  );
});

test("owned runner stderr maxBuffer failure terminates the entire process tree", async (t) => {
  const fixture = await processFixture(t, "stderr-max-buffer-grandchild.pid");
  const { pidPath } = fixture;

  await assert.rejects(
    runOwnedProcess(
      process.execPath,
      ["-e", PROCESS_TREE_SCRIPT, pidPath, "stderr-overflow"],
      { encoding: "utf8", maxBuffer: 1_024, timeout: 5_000 },
    ),
    (error) => {
      assert.equal(error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.match(error?.message ?? "", /stderr maxBuffer length exceeded/u);
      if (process.platform !== "win32") {
        assert.equal(error?.stream, "stderr");
      }
      return true;
    },
  );

  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("owned runner reaps a lingering grandchild after a successful parent", async (t) => {
  const fixture = await processFixture(t, "success-grandchild.pid");
  const { pidPath } = fixture;

  const result = await runOwnedProcess(
    process.execPath,
    ["-e", PROCESS_TREE_SCRIPT, pidPath, "success"],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5_000 },
  );

  assert.equal(result.stdout, "parent-complete\n");
  assert.equal(result.stderr, "");
  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  assert.equal(Number.isSafeInteger(grandchildPid), true);
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("owned runner resolves only after a silent grandchild is gone", async (t) => {
  const fixture = await processFixture(t, "silent-success-grandchild.pid");
  const { pidPath } = fixture;

  const result = await runOwnedProcess(
    process.execPath,
    ["-e", PROCESS_TREE_SCRIPT, pidPath, "silent-success"],
    { encoding: "utf8", maxBuffer: 64 * 1_024, timeout: 5_000 },
  );

  assert.equal(result.stdout, "parent-complete\n");
  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("source-build runner supports an explicit owned process-tree boundary", async (t) => {
  const fixture = await processFixture(t, "source-build-owned-grandchild.pid");
  const { pidPath } = fixture;

  const result = await runSourceBuildCommand(
    process.execPath,
    ["-e", PROCESS_TREE_SCRIPT, pidPath, "success"],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      ownedProcessTree: true,
      timeout: 5_000,
    },
  );

  assert.equal(result.stdout, "parent-complete\n");
  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("ambient group marker cannot authorize an unrelated Unix process", {
  skip: process.platform === "win32",
}, async () => {
  const result = await runSourceBuildCommand(
    process.execPath,
    ["-e", FORGED_GROUP_MARKER_SCRIPT, OWNED_PROCESS_MODULE_URL],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LING_CUA_OWNED_GROUP_LEADER: "leader",
      },
      timeout: 5_000,
    },
  );
  assert.equal(result.stdout, "ERR_OWNED_PROCESS_GROUP_MARKER");
});

test("outer timeout reaps a grandchild created by a nested owned runner", async (t) => {
  const fixture = await processFixture(t, "nested-grandchild.pid");
  const { pidPath } = fixture;

  await assert.rejects(
    runOwnedProcess(
      process.execPath,
      [
        "-e",
        NESTED_OWNER_SCRIPT,
        OWNED_PROCESS_MODULE_URL,
        NESTED_PROCESS_TREE_SCRIPT,
        pidPath,
      ],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1_024,
        // A fresh nested Windows process must first compile and attest the
        // native Job Object helper. Keep the outer deadline below the nested
        // 30-second deadline without racing that one-time compilation.
        timeout: process.platform === "win32" ? 15_000 : 1_000,
      },
    ),
    (error) => {
      assert.equal(error?.code, "ETIMEDOUT");
      assert.equal(error?.killed, true);
      return true;
    },
  );

  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

test("nested owned success returns output and leaves cleanup to the outer owner", async (t) => {
  const fixture = await processFixture(t, "nested-success-grandchild.pid");
  const { pidPath } = fixture;

  const result = await runOwnedProcess(
    process.execPath,
    [
      "-e",
      NESTED_SUCCESS_OWNER_SCRIPT,
      OWNED_PROCESS_MODULE_URL,
      PROCESS_TREE_SCRIPT,
      pidPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1_024, timeout: 5_000 },
  );

  assert.equal(result.stdout, "nested:parent-complete\n");
  assert.equal(result.stderr, "");
  const grandchildPid = Number(await readFile(pidPath, "utf8"));
  await assertProcessNotRunning(grandchildPid);
  fixture.markReaped();
});

async function processFixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-owned-process-test-"));
  const pidPath = join(root, name);
  let reaped = false;
  t.after(async () => {
    if (!reaped) await terminateFixtureProcess(pidPath);
    await rm(root, { force: true, recursive: true });
  });
  return Object.freeze({
    markReaped() {
      reaped = true;
    },
    pidPath,
  });
}

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for process fixture: ${path}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function assertProcessNotRunning(pid) {
  // Windows can retain a terminated process object briefly after a Job Object
  // reaches zero active processes. `kill(pid, 0)` observes that object, not
  // whether the process can still execute, so allow the kernel to reap it.
  const deadline = Date.now() + (process.platform === "win32" ? 5_000 : 0);
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(processExists(pid), false);
}

async function terminateFixtureProcess(pidPath) {
  let pid;
  try {
    pid = Number(await readFile(pidPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
