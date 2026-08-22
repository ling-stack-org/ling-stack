import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OFFICE_DRIVER_PROTOCOL } from "@ling-stack/contracts";
import { OfficeDriverHelperProcess } from "../dist/main/office-driver/helper-process.js";

test("Office helper process exchanges framed results and keeps stderr content out of diagnostics", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-office-helper-"));
  const executablePath = resolve(root, "helper.mjs");
  const diagnostics = [];
  try {
    await writeFile(executablePath, framedHelperSource, { mode: 0o700 });
    await chmod(executablePath, 0o700);
    const helper = new OfficeDriverHelperProcess({
      executablePath,
      recoveryRoot: root,
      onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    });
    await helper.start();
    const command = request("status", "driver_status", {});
    const result = await helper.call(command);
    assert.equal(result.id, command.id);
    assert.equal(result.ok, true);
    await helper.stop();

    assert.equal(diagnostics.some((item) => item.event === "office_driver.helper_stderr"), true);
    assert.equal(JSON.stringify(diagnostics).includes("private-workbook-name"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Office helper process rejects a pending call when the native process crashes", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ling-office-helper-crash-"));
  const executablePath = resolve(root, "helper.mjs");
  try {
    await writeFile(executablePath, crashingHelperSource, { mode: 0o700 });
    await chmod(executablePath, 0o700);
    const helper = new OfficeDriverHelperProcess({ executablePath, recoveryRoot: root });
    await helper.start();
    await assert.rejects(helper.call(request("crash", "driver_status", {})), /office_driver_exited/u);
    await helper.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const framedHelperSource = `#!/usr/bin/env node
let buffered = Buffer.alloc(0);
process.stderr.write("private-workbook-name");
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const size = buffered.readUInt32LE(0);
    if (buffered.length < size + 4) return;
    const request = JSON.parse(buffered.subarray(4, size + 4).toString("utf8"));
    buffered = buffered.subarray(size + 4);
    const payload = Buffer.from(JSON.stringify({ protocol: request.protocol, id: request.id, ok: true, result: { helperVersion: "fixture" } }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    process.stdout.write(Buffer.concat([header, payload]));
  }
});
`;

const crashingHelperSource = `#!/usr/bin/env node
process.stdin.once("data", () => process.exit(3));
`;

function request(id, method, params) {
  return {
    protocol: OFFICE_DRIVER_PROTOCOL,
    id,
    method,
    params,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    idempotencyKey: `test:${id}`,
  };
}
