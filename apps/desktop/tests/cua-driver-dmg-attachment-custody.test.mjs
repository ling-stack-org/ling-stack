import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";

import { createDmgAttachmentCustody } from "../scripts/cua-driver-signing/dmg-attachment-custody.mjs";

const SNAPSHOT = "/private/tmp/EXPLICIT-SYNTHETIC-input/attach-input.dmg";
const MOUNT_POINT = "/private/tmp/EXPLICIT-SYNTHETIC-mount";
const DEVICE = "/dev/disk811";
const OWNER_UID = 1000;
const PLUTIL_ARGS = ["-convert", "json", "-o", "-", "--", "-"];

test("attachment custody validates its synchronous factory and freezes its public boundary", () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.custody), true);
  assert.deepEqual(f.custody.receipt(), {
    status: "not_attempted", attempted: false, snapshotPath: SNAPSHOT, mountPoint: MOUNT_POINT,
  });
  assert.equal(Object.isFrozen(f.custody.receipt()), true);
  assert.throws(() => createDmgAttachmentCustody({}), error => error.code === "dmg_attachment_input_invalid");
  for (const input of [undefined, null, [],
    { snapshotPath: "relative" }, { mountPoint: "/tmp/../mount" },
    { snapshotPath: "/tmp/input\0.dmg" }, { mountPoint: "/tmp/mount\n" }, { mountPoint: "/tmp/mount/" },
    { mountPoint: SNAPSHOT }, { runCommand: null }, { beforeAttach: 0 },
    { expectedOwnerUid: -1 }, { expectedOwnerUid: 0.5 }, { expectedOwnerUid: "1000" },
  ]) {
    assert.throws(() => createDmgAttachmentCustody(input == null || Array.isArray(input) ? input : {
      snapshotPath: SNAPSHOT, mountPoint: MOUNT_POINT, expectedOwnerUid: OWNER_UID,
      runCommand: async () => {}, ...input,
    }), error => error.code === "dmg_attachment_input_invalid");
  }
});

test("complete before/attach/after receipts bind once and detach only the original whole device", async () => {
  const f = fixture();
  const attached = await f.custody.attach();
  assert.equal(attached.status, "bound");
  assert.equal(attached.attempted, true);
  assert.deepEqual(attached.binding, { wholeDevice: DEVICE, entities: [
    { device: DEVICE }, { device: `${DEVICE}s1`, mountPoint: MOUNT_POINT },
  ], helperPid: 1234, ownerUid: OWNER_UID });
  for (const value of [attached, attached.binding, attached.binding.entities, ...attached.binding.entities]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { attached.binding.entities[0].device = "/dev/disk999"; }, TypeError);
  const attachCall = f.calls.find(call => call.args[0] === "attach");
  assert.deepEqual(attachCall.args, ["attach", "-plist", "-nobrowse", "-readonly", "-mountpoint", MOUNT_POINT, SNAPSHOT]);
  assert.equal(f.calls.every(call => ["/usr/bin/hdiutil", "/usr/bin/plutil"].includes(call.command)), true);
  assert.equal(f.calls.filter(call => call.command === "/usr/bin/plutil").every(call =>
    JSON.stringify(call.args) === JSON.stringify(PLUTIL_ARGS) && typeof call.options.stdin === "string"
    && call.options.timeoutMs === 10_000), true);
  await f.custody.detach();
  await f.custody.detach();
  assert.equal(f.custody.receipt().status, "detached");
  assert.strictEqual(f.custody.receipt().binding, attached.binding);
  assert.deepEqual(detachCalls(f).map(call => call.args), [["detach", DEVICE]]);
  assert.equal(detachCalls(f)[0].options.timeoutMs, 30_000);
  assert.equal(f.inventory.length, 0);
});

test("real native plutil parses synthetic XML without any real hdiutil or filesystem operation", {
  skip: process.platform !== "darwin",
}, async t => {
  let conversions = 0;
  const f = fixture({
    async convert(stdin) {
      conversions += 1;
      return new Promise((resolve, reject) => {
        const child = execFile("/usr/bin/plutil", PLUTIL_ARGS, {
          encoding: "utf8", shell: false, timeout: 10_000, maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
        child.stdin.on("error", reject);
        child.stdin.end(stdin, "utf8");
      });
    },
  });
  await f.custody.attach();
  await f.custody.detach();
  assert.equal(conversions, 5);
  assert.equal(detachCalls(f).length, 1);
  t.diagnostic("Real native plutil conversion only; hdiutil output/authority synthetic. No OS mount/detach, signed artifact, GUI, or same-UID isolation acceptance.");
});

test("preflight refuses existing snapshot, occupied mountpoint and unknown kernel-helper lineage", async t => {
  const cases = [
    ["same-image", [image()], "already_present"],
    ["foreign-mount", [image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk999" })], "already_present"],
    ["kernel-pid-zero", [image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk999", mountPoint: "/tmp/other", helperPid: 0 })], "inventory_invalid"],
    ["kernel-pid-missing", [{ "image-path": "/tmp/FOREIGN.dmg", "owner-uid": OWNER_UID, "system-entities": entities("/dev/disk999", "/tmp/other") }], "inventory_invalid"],
  ];
  for (const [name, before, suffix] of cases) await t.test(name, async () => {
    const f = fixture({ before });
    await rejectsCode(f.custody.attach(), suffix);
    assert.equal(f.calls.some(call => call.args[0] === "attach"), false);
    assert.equal(f.custody.receipt().attempted, false);
    assert.equal(detachCalls(f).length, 0);
    assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
  });
});

test("beforeAttach follows valid absence and failure never starts attach or adopts lineage", async t => {
  for (const reason of [false, null, 0, "", undefined]) await t.test(`falsy-${String(reason)}`, async () => {
    let callbacks = 0;
    const f = fixture({ async beforeAttach() { callbacks += 1; throw reason; } });
    assert.strictEqual(await rejection(f.custody.attach()), reason);
    assert.equal(callbacks, 1);
    assert.equal(f.infoCount, 1);
    assert.equal(f.calls.some(call => call.args[0] === "attach"), false);
    assert.equal(f.custody.receipt().attempted, false);
    assert.equal(f.custody.receipt().status, "not_attempted");
    await f.custody.detach();
    assert.equal(detachCalls(f).length, 0);
  });
  let observed;
  const f = fixture({ async beforeAttach() { observed = f.calls.at(-1).command; } });
  await f.custody.attach();
  assert.equal(observed, "/usr/bin/plutil");
});

test("strict inventory rejects missing fields, unsafe types, duplicates and fixed array budgets", async t => {
  const ordinary = image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk999", mountPoint: "/tmp/other" });
  const cases = [
    ["images-missing", {}], ["images-not-array", { images: {} }],
    ["null-image", { images: [null] }], ["unsafe-path", { images: [{ ...ordinary, "image-path": "/tmp/../FOREIGN.dmg" }] }],
    ["trailing-slash-path", { images: [{ ...ordinary, "image-path": "/tmp/FOREIGN.dmg/" }] }],
    ["pid-string", { images: [{ ...ordinary, "hdid-pid": "1" }] }],
    ["uid-negative", { images: [{ ...ordinary, "owner-uid": -1 }] }],
    ["uid-missing", { images: [{ ...ordinary, "owner-uid": undefined }] }],
    ["duplicate-image-path", { images: [ordinary, image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk998", mountPoint: "/tmp/other2" })] }],
    ["duplicate-device", { images: [ordinary, image({ imagePath: "/tmp/OTHER.dmg", device: "/dev/disk999", mountPoint: "/tmp/other2" })] }],
    ["duplicate-mount", { images: [ordinary, image({ imagePath: "/tmp/OTHER.dmg", device: "/dev/disk998", mountPoint: "/tmp/other" })] }],
    ["257-images", { images: Array.from({ length: 257 }, (_, index) => image({ imagePath: `/tmp/FOREIGN-${index}.dmg`, device: `/dev/disk${1000 + index}`, mountPoint: `/tmp/other-${index}` })) }],
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    const f = fixture({ info() { return value; } });
    await assert.rejects(f.custody.attach(), /dmg_attachment_(inventory_invalid|inventory_duplicate)/u);
    assert.equal(f.custody.receipt().attempted, false);
    assert.equal(detachCalls(f).length, 0);
  });
});

test("attach entity parsing rejects unsafe, duplicate, foreign-tree and ambiguous whole-device receipts", async t => {
  const cases = [
    ["missing", {}], ["not-array", { "system-entities": {} }], ["empty", { "system-entities": [] }],
    ["null-entry", { "system-entities": [null] }],
    ["unsafe-device", { "system-entities": [{ "dev-entry": "/dev/disk811;detach" }] }],
    ["unsafe-mount", { "system-entities": entities(DEVICE, "/tmp/../other") }],
    ["trailing-slash-mount", { "system-entities": entities(DEVICE, `${MOUNT_POINT}/`) }],
    ["duplicate-device", { "system-entities": [{ "dev-entry": DEVICE }, { "dev-entry": DEVICE }] }],
    ["duplicate-mount", { "system-entities": [{ "dev-entry": DEVICE, "mount-point": MOUNT_POINT }, { "dev-entry": `${DEVICE}s1`, "mount-point": MOUNT_POINT }] }],
    ["no-whole", { "system-entities": [{ "dev-entry": `${DEVICE}s1`, "mount-point": MOUNT_POINT }] }],
    ["two-whole", { "system-entities": [{ "dev-entry": DEVICE }, { "dev-entry": "/dev/disk999", "mount-point": MOUNT_POINT }] }],
    ["foreign-child", { "system-entities": [{ "dev-entry": DEVICE }, { "dev-entry": "/dev/disk999s1", "mount-point": MOUNT_POINT }] }],
    ["unsafe-content-hint", { "system-entities": [{ "dev-entry": DEVICE, "content-hint": "bad\0hint" }] }],
    ["129-entities", { "system-entities": [{ "dev-entry": DEVICE }, ...Array.from({ length: 128 }, (_, index) => ({ "dev-entry": `${DEVICE}s${index + 1}` }))] }],
  ];
  for (const [name, value] of cases) await t.test(name, async () => {
    const f = fixture({ attach() { return f.output(value); } });
    await assert.rejects(f.custody.attach(), /dmg_attachment_(entities_invalid|entities_duplicate|whole_device_invalid)/u);
    assert.equal(f.custody.receipt().status, "unknown");
    assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
    await rejectsCode(f.custody.detach(), "ownership_unknown");
    assert.equal(detachCalls(f).length, 0);
  });
});

test("successful attach requires requested mountpoint and actual expected UID", async t => {
  await t.test("missing-mount", async () => {
    const f = fixture({ ownEntities: entities(DEVICE) });
    await rejectsCode(f.custody.attach(), "mountpoint_missing");
    assert.equal(f.custody.receipt().status, "unknown");
    await rejectsCode(f.custody.detach(), "ownership_unknown");
    assert.equal(detachCalls(f).length, 0);
  });
  await t.test("different-owner", async () => {
    const f = fixture({ ownerUid: OWNER_UID + 1 });
    await rejectsCode(f.custody.attach(), "owner_mismatch");
    assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
  });
  await t.test("default-owner", async () => {
    if (typeof process.getuid !== "function") return;
    const f = fixture({ expectedOwnerUid: undefined, ownerUid: process.getuid() });
    await f.custody.attach();
    assert.equal(f.custody.receipt().binding.ownerUid, process.getuid());
  });
});

test("devices already present before attach cannot become new original lineage", async () => {
  const f = fixture({ before: [image({ imagePath: "/tmp/FOREIGN.dmg", mountPoint: "/tmp/other" })] });
  await rejectsCode(f.custody.attach(), "device_reused");
  assert.equal(f.custody.receipt().status, "unknown");
  assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
  await rejectsCode(f.custody.detach(), "ownership_unknown");
  assert.equal(detachCalls(f).length, 0);
});

test("after-info must match every original attach entity, never only the first mount", async t => {
  const cases = [
    ["extra-entity", own => ({ ...own, "system-entities": [...own["system-entities"], { "dev-entry": `${DEVICE}s2` }] })],
    ["missing-entity", own => ({ ...own, "system-entities": [{ "dev-entry": DEVICE, "mount-point": MOUNT_POINT }] })],
    ["other-mount", own => ({ ...own, "system-entities": entities(DEVICE, "/tmp/other") })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture({ info(count) { return { images: count === 1 ? [] : [mutate(image())] }; } });
    await rejectsCode(f.custody.attach(), "association_mismatch");
    assert.equal(f.custody.receipt().status, "unknown");
    assert.equal(detachCalls(f).length, 0);
  });
});

test("hdiutil/plutil transports stay text-bounded and malformed conversion cannot create a receipt", async t => {
  const cases = [
    ["direct-json-object", { infoOutput: { images: [] } }, "command_output_invalid"],
    ["undefined-output", { infoOutput: undefined, explicitInfoOutput: true }, "command_output_invalid"],
    ["stdout-over-budget", { infoOutput: { stdout: "x".repeat(1024 * 1024 + 1), stderr: "" } }, "command_output_invalid"],
    ["stderr-over-budget", { infoOutput: { stdout: "<plist/>", stderr: "x".repeat(1024 * 1024 + 1) } }, "command_output_invalid"],
    ["utf8-byte-budget", { infoOutput: { stdout: "中".repeat(350_000), stderr: "" } }, "command_output_invalid"],
    ["missing-plist", { infoOutput: { stdout: "", stderr: "" } }, "plist_missing"],
    ["invalid-json", { convert: async () => ({ stdout: "{", stderr: "" }) }, "plist_json_invalid"],
    ["array-json", { convert: async () => ({ stdout: "[]", stderr: "" }) }, "plist_shape_invalid"],
    ["null-json", { convert: async () => ({ stdout: "null", stderr: "" }) }, "plist_shape_invalid"],
    ["plutil-object", { convert: async () => ({ images: [] }) }, "command_output_invalid"],
    ["plutil-over-budget", { convert: async () => ({ stdout: " ".repeat(1024 * 1024 + 1), stderr: "" }) }, "command_output_invalid"],
  ];
  for (const [name, options, suffix] of cases) await t.test(name, async () => {
    const f = fixture(options);
    await rejectsCode(f.custody.attach(), suffix);
    assert.equal(f.custody.receipt().attempted, false);
    assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
    assert.equal(detachCalls(f).length, 0);
  });
});

test("query and converter failures preserve every falsy underlying cause", async t => {
  for (const reason of [undefined, null, false, 0, ""]) {
    for (const stage of ["info", "plutil"]) await t.test(`${stage}-${String(reason)}`, async () => {
      const f = fixture(stage === "info" ? { info() { throw reason; } } : { convert() { throw reason; } });
      const error = await rejection(f.custody.attach());
      assert.equal(error.code, `dmg_attachment_${stage === "info" ? "info_unavailable" : "plist_conversion_failed"}`);
      assert.equal(Object.hasOwn(error, "cause"), true);
      assert.strictEqual(error.cause, reason);
    });
  }
});

test("only complete nonzero partial-attach output with exact after-info can bind, while retaining the original failure", async t => {
  for (const mounted of [true, false]) await t.test(`mounted-${mounted}`, async () => {
    let primary;
    const f = fixture({ ownEntities: entities(DEVICE, mounted ? MOUNT_POINT : undefined), attach() {
      primary = commandFailure(f.output({ "system-entities": f.ownEntities }));
      throw primary;
    } });
    assert.strictEqual(await rejection(f.custody.attach()), primary);
    assert.equal(f.custody.receipt().status, "bound");
    await f.custody.detach();
    assert.deepEqual(detachCalls(f).map(call => call.args), [["detach", DEVICE]]);
  });
  await t.test("wrapped-real-exit-cause", async () => {
    let primary;
    const f = fixture({ attach() {
      primary = new Error("normalized command failure", { cause: Object.assign(new Error("synthetic exit"), { code: 1 }) });
      Object.defineProperty(primary, "commandReceipt", { value: Object.freeze({ ...f.output({ "system-entities": f.ownEntities }), outputComplete: true }) });
      throw primary;
    } });
    assert.strictEqual(await rejection(f.custody.attach()), primary);
    assert.equal(f.custody.receipt().status, "bound");
  });
});

test("partial binding failures retain primary and secondary causes instead of silently adopting", async t => {
  await t.test("entity-mismatch", async () => {
    let primary;
    const f = fixture({ attach() {
      primary = commandFailure(f.output({ "system-entities": entities(DEVICE, "/tmp/other") }));
      throw primary;
    } });
    const error = await rejection(f.custody.attach());
    assert.equal(error.message, "dmg_attachment_attach_and_binding_failed");
    assert.strictEqual(error.errors[0], primary);
    assert.equal(error.errors[1].code, "dmg_attachment_association_mismatch");
    assert.equal(f.custody.receipt().status, "unknown");
  });
  await t.test("falsy-after-query", async () => {
    let primary;
    const f = fixture({ info(count) { if (count === 2) throw 0; return { images: [] }; }, attach() {
      primary = commandFailure(f.output({ "system-entities": f.ownEntities }));
      throw primary;
    } });
    const error = await rejection(f.custody.attach());
    assert.strictEqual(error.errors[0], primary);
    assert.equal(error.errors[1].code, "dmg_attachment_info_unavailable");
    assert.strictEqual(error.errors[1].cause, 0);
    assert.equal(f.custody.receipt().status, "unknown");
  });
});

test("timeout/killed/maxBuffer/incomplete/unfrozen/unproven exits never promote partial output", async t => {
  const cases = [
    ["incomplete", { outputComplete: false }], ["killed", { killed: true }],
    ["signal", { signal: "SIGTERM" }], ["timeout", { code: "ETIMEDOUT" }],
    ["maxBuffer", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
    ["exit-zero", { code: 0 }], ["no-numeric-exit", { code: "synthetic" }], ["unfrozen", { frozen: false }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    let primary;
    const f = fixture({ attach() { primary = commandFailure(f.output({ "system-entities": f.ownEntities }), options); throw primary; } });
    assert.strictEqual(await rejection(f.custody.attach()), primary);
    assert.equal(f.custody.receipt().status, "unknown");
    assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
    await rejectsCode(f.custody.detach(), "ownership_unknown");
    assert.equal(detachCalls(f).length, 0);
  });
});

test("unknown partial failures preserve falsy values and accept only complete later absence without detaching", async t => {
  for (const reason of [undefined, null, false, 0, ""]) await t.test(`falsy-${String(reason)}`, async () => {
    const f = fixture({ attach() { throw reason; } });
    assert.strictEqual(await rejection(f.custody.attach()), reason);
    await rejectsCode(f.custody.detach(), "ownership_unknown");
    assert.equal(detachCalls(f).length, 0);
    f.inventory = [];
    await f.custody.detach();
    assert.equal(f.custody.receipt().status, "detached");
    assert.equal(Object.hasOwn(f.custody.receipt(), "binding"), false);
    assert.equal(detachCalls(f).length, 0);
  });
});

test("foreign mapping, PID/UID changes and entity changes forbid both ordinary and force detach", async t => {
  const changes = [
    ["foreign-requested-mount", () => [image({ mountPoint: "/tmp/owned-elsewhere" }), image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk999" })]],
    ["helper-pid", () => [image({ helperPid: 4321 })]],
    ["owner-uid", () => [image({ ownerUid: OWNER_UID + 1 })]],
    ["missing-child", () => [{ ...image(), "system-entities": [{ "dev-entry": DEVICE, "mount-point": MOUNT_POINT }] }]],
    ["additional-child", () => [{ ...image(), "system-entities": [...entities(), { "dev-entry": `${DEVICE}s2` }] }]],
    ["device-reused-by-foreign", () => [image({ imagePath: "/tmp/FOREIGN.dmg" })]],
    ["mount-moved", () => [image({ mountPoint: "/tmp/other" })]],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const f = fixture();
    const initial = await f.custody.attach();
    f.inventory = change();
    await rejectsCode(f.custody.detach(), "association_mismatch");
    assert.equal(detachCalls(f).length, 0);
    assert.strictEqual(f.custody.receipt().binding, initial.binding);
    assert.equal(f.custody.receipt().status, "bound");
  });
});

test("ordinary failure needs fresh exact association again before force and confirms absence after it", async () => {
  const f = fixture({ detach(args) {
    if (args[1] !== "-force") throw false;
    f.inventory = [];
    return { stdout: "", stderr: "" };
  } });
  await f.custody.attach();
  await f.custody.detach();
  assert.deepEqual(detachCalls(f).map(call => call.args), [["detach", DEVICE], ["detach", "-force", DEVICE]]);
  assert.equal(f.infoCount, 6);
  assert.equal(f.custody.receipt().status, "detached");
});

test("ordinary or force nonzero exit followed by complete absence is safe without further detach", async t => {
  for (const disappearAt of ["ordinary", "force"]) await t.test(disappearAt, async () => {
    const f = fixture({ detach(args) {
      if (disappearAt === "ordinary" || args[1] === "-force") f.inventory = [];
      throw args[1] === "-force" ? 0 : false;
    } });
    await f.custody.attach();
    await f.custody.detach();
    assert.equal(detachCalls(f).length, disappearAt === "ordinary" ? 1 : 2);
    assert.equal(f.custody.receipt().status, "detached");
  });
});

test("changes after ordinary failure or in the last force guard prohibit force", async t => {
  for (const changeAt of [4, 5]) await t.test(`info-${changeAt}`, async () => {
    const f = fixture({
      info(count) { if (count >= changeAt) return { images: [image({ helperPid: 9999 })] }; return { images: f.inventory }; },
      detach() { throw null; },
    });
    await f.custody.attach();
    const error = await rejection(f.custody.detach());
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.errors[0], null);
    assert.equal(error.errors[1].code, "dmg_attachment_association_mismatch");
    assert.deepEqual(detachCalls(f).map(call => call.args), [["detach", DEVICE]]);
  });
});

test("both detach failures retain falsy causes and retry uses only original lineage", async () => {
  let blocked = true;
  const f = fixture({ detach(args) {
    if (blocked) throw args[1] === "-force" ? 0 : null;
    f.inventory = [];
    return { stdout: "", stderr: "" };
  } });
  const initial = await f.custody.attach();
  const error = await rejection(f.custody.detach());
  assert.equal(error.message, "dmg_attachment_detach_failed");
  assert.deepEqual(error.errors, [null, 0]);
  assert.equal(f.custody.receipt().status, "bound");
  blocked = false;
  await f.custody.detach();
  assert.strictEqual(f.custody.receipt().binding, initial.binding);
  assert.deepEqual(detachCalls(f).map(call => call.args), [["detach", DEVICE], ["detach", "-force", DEVICE], ["detach", DEVICE]]);
});

test("exit zero cannot authorize filesystem recovery while the original association is still present", async t => {
  for (const force of [false, true]) await t.test(`force-${force}`, async () => {
    const f = fixture({ detach(args) {
      if (force && args[1] !== "-force") throw false;
      return { stdout: "", stderr: "" };
    } });
    await f.custody.attach();
    const error = await rejection(f.custody.detach());
    if (force) {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], false);
      assert.equal(error.errors[1].code, "dmg_attachment_detach_unconfirmed");
    } else assert.equal(error.code, "dmg_attachment_detach_unconfirmed");
    assert.equal(f.custody.receipt().status, "bound");
    assert.equal(detachCalls(f).length, force ? 2 : 1);
  });
});

test("after-detach query failure retains causes and never reports confirmed absence", async () => {
  const f = fixture({ info(count) { if (count === 4) throw ""; return { images: f.inventory }; } });
  await f.custody.attach();
  const error = await rejection(f.custody.detach());
  assert.equal(error.code, "dmg_attachment_info_unavailable");
  assert.strictEqual(error.cause, "");
  assert.equal(f.custody.receipt().status, "bound");
  await f.custody.detach();
  assert.equal(f.custody.receipt().status, "detached");
  assert.equal(detachCalls(f).length, 1);
});

test("absence includes all original devices and mountpoints, not merely the image path", async t => {
  const oldEntities = [...entities(), { "dev-entry": `${DEVICE}s2`, "mount-point": "/tmp/original-second-volume" }];
  const candidates = [
    ["original-device-reused", [image({ imagePath: "/tmp/FOREIGN.dmg", mountPoint: "/tmp/other" })]],
    ["requested-mount-reused", [image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk999" })]],
    ["other-original-mount-reused", [image({ imagePath: "/tmp/FOREIGN.dmg", device: "/dev/disk999", mountPoint: "/tmp/original-second-volume" })]],
  ];
  for (const [name, inventory] of candidates) await t.test(name, async () => {
    const f = fixture({ ownEntities: oldEntities });
    await f.custody.attach();
    f.inventory = inventory;
    await rejectsCode(f.custody.detach(), "association_mismatch");
    assert.equal(detachCalls(f).length, 0);
  });
});

test("confirmed-detached residue retry queries fresh absence and never detaches a reattachment", async t => {
  for (const replacement of [image(), image({ imagePath: "/tmp/FOREIGN.dmg" })]) await t.test(replacement["image-path"], async () => {
    const f = fixture();
    const initial = await f.custody.attach();
    await f.custody.detach();
    const infoBeforeRetry = f.infoCount;
    f.inventory = [replacement];
    await rejectsCode(f.custody.detach(), "association_mismatch");
    assert.equal(f.infoCount, infoBeforeRetry + 1);
    assert.equal(detachCalls(f).length, 1);
    assert.equal(f.custody.receipt().status, "detached");
    assert.strictEqual(f.custody.receipt().binding, initial.binding);
    f.inventory = [];
    await f.custody.detach();
    assert.equal(detachCalls(f).length, 1);
  });
});

test("initial attach is single-use even after before-query failure or confirmed absence", async () => {
  const f = fixture();
  await f.custody.attach();
  await rejectsCode(f.custody.attach(), "state_invalid");
  await f.custody.detach();
  await rejectsCode(f.custody.attach(), "state_invalid");
  assert.equal(f.calls.filter(call => call.args[0] === "attach").length, 1);
});

/** Every hdiutil operation below is a substitution: none executes an OS command. */
function fixture(options = {}) {
  const calls = [], conversions = new Map();
  const ownEntities = options.ownEntities ?? entities();
  let inventory = options.before ?? [], infoCount = 0;
  const output = value => {
    const stdout = plist(value);
    conversions.set(stdout, JSON.stringify(value));
    return { stdout, stderr: "" };
  };
  const f = {
    calls, output, ownEntities,
    get inventory() { return inventory; }, set inventory(value) { inventory = value; },
    get infoCount() { return infoCount; },
  };
  const runCommand = async (command, args, commandOptions = {}) => {
    calls.push({ command, args: [...args], options: { ...commandOptions } });
    if (command === "/usr/bin/plutil") {
      assert.deepEqual(args, PLUTIL_ARGS);
      assert.equal(commandOptions.timeoutMs, 10_000);
      assert.equal(typeof commandOptions.stdin, "string");
      if (options.convert) return options.convert(commandOptions.stdin);
      assert.equal(conversions.has(commandOptions.stdin), true, "synthetic plutil must receive registered raw XML, never a pre-parsed object");
      return { stdout: conversions.get(commandOptions.stdin), stderr: "" };
    }
    assert.equal(command, "/usr/bin/hdiutil");
    if (args[0] === "info") {
      assert.deepEqual(args, ["info", "-plist"]);
      assert.equal(commandOptions.timeoutMs, 10_000);
      infoCount += 1;
      if (Object.hasOwn(options, "infoOutput") || options.explicitInfoOutput) return options.infoOutput;
      return output(options.info ? await options.info(infoCount) : { images: inventory });
    }
    if (args[0] === "attach") {
      inventory = [image({ ownEntities, ownerUid: options.ownerUid ?? OWNER_UID })];
      return options.attach ? options.attach(args) : output({ "system-entities": ownEntities });
    }
    if (args[0] === "detach") {
      assert.equal(commandOptions.timeoutMs, 30_000);
      if (options.detach) return options.detach(args);
      inventory = [];
      return { stdout: "", stderr: "" };
    }
    assert.fail("unexpected synthetic hdiutil verb");
  };
  f.custody = createDmgAttachmentCustody({
    snapshotPath: SNAPSHOT, mountPoint: MOUNT_POINT, runCommand,
    expectedOwnerUid: Object.hasOwn(options, "expectedOwnerUid") ? options.expectedOwnerUid : OWNER_UID,
    ...(options.beforeAttach ? { beforeAttach: options.beforeAttach } : {}),
  });
  return f;
}

function entities(device = DEVICE, mountPoint) {
  if (arguments.length === 0) mountPoint = MOUNT_POINT;
  return [{ "dev-entry": device }, { "dev-entry": `${device}s1`,
    ...(mountPoint === undefined ? {} : { "mount-point": mountPoint }) }];
}

function image(options = {}) {
  return { "image-path": options.imagePath ?? SNAPSHOT,
    "hdid-pid": options.helperPid ?? 1234, "owner-uid": options.ownerUid ?? OWNER_UID,
    "system-entities": options.ownEntities ?? entities(options.device ?? DEVICE, options.mountPoint ?? MOUNT_POINT) };
}

function commandFailure(output, options = {}) {
  const error = Object.assign(new Error("EXPLICIT SYNTHETIC hdiutil nonzero exit"), { code: 1,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => !["outputComplete", "frozen"].includes(key))) });
  const receipt = { ...output, outputComplete: options.outputComplete ?? true };
  Object.defineProperty(error, "commandReceipt", { value: options.frozen === false ? receipt : Object.freeze(receipt) });
  return error;
}

function plist(value) {
  const escaped = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const encode = value => {
    if (Array.isArray(value)) return `<array>${value.map(encode).join("")}</array>`;
    if (value !== null && typeof value === "object") return `<dict>${Object.entries(value)
      .filter(([, item]) => item !== undefined).map(([key, item]) => `<key>${escaped(key)}</key>${encode(item)}`).join("")}</dict>`;
    if (typeof value === "number") return `<integer>${value}</integer>`;
    if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
    return `<string>${escaped(value)}</string>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0">${encode(value)}</plist>\n`;
}

function detachCalls(f) { return f.calls.filter(call => call.command === "/usr/bin/hdiutil" && call.args[0] === "detach"); }
async function rejectsCode(promise, suffix) { await assert.rejects(promise, error => error.code === `dmg_attachment_${suffix}`); }
async function rejection(promise) {
  try { await promise; }
  catch (cause) { return cause; }
  assert.fail("expected a rejection, including a possibly falsy reason");
}
