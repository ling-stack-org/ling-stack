import { posix } from "node:path";

import { SigningContractError } from "./signing-contract.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_IMAGES = 256;
const MAX_ENTITIES = 128;
const QUERY_TIMEOUT_MS = 10_000;
const DETACH_TIMEOUT_MS = 30_000;
const PLUTIL_ARGS = Object.freeze(["-convert", "json", "-o", "-", "--", "-"]);
const DEVICE_PATTERN = /^\/dev\/disk(?:0|[1-9][0-9]*)(?:s(?:0|[1-9][0-9]*))*$/u;
const WHOLE_DEVICE_PATTERN = /^\/dev\/disk(?:0|[1-9][0-9]*)$/u;

/**
 * Keep the first complete attachment lineage, never adopt a later association.
 * The injected transport must execute fixed tools with bounded text output.
 * Query-to-detach is not atomic and does not provide same-UID adversarial isolation.
 * This helper never creates, verifies, or removes filesystem paths.
 *
 * @param {{snapshotPath: string, mountPoint: string,
 *   runCommand: (command: string, args: string[], options?: object) => Promise<object>,
 *   beforeAttach?: () => Promise<void>, expectedOwnerUid?: number}} input
 * @returns {{attach: () => Promise<object>, detach: () => Promise<object>, receipt: () => object}}
 */
export function createDmgAttachmentCustody(input) {
  requireCondition(record(input), "input_invalid");
  const { snapshotPath, mountPoint, runCommand, beforeAttach = async () => {},
    expectedOwnerUid = process.getuid?.() } = input;
  requireCondition(safePath(snapshotPath) && safePath(mountPoint)
    && snapshotPath !== mountPoint && typeof runCommand === "function"
    && typeof beforeAttach === "function" && Number.isSafeInteger(expectedOwnerUid)
    && expectedOwnerUid >= 0, "input_invalid");

  let status = "not_attempted";
  let attempted = false;
  let attachEntered = false;
  let binding;
  const receipt = () => Object.freeze({
    status, attempted, snapshotPath, mountPoint,
    ...(binding === undefined ? {} : { binding }),
  });
  const readInventory = async () => {
    let output;
    try { output = await runCommand("/usr/bin/hdiutil", ["info", "-plist"], { timeoutMs: QUERY_TIMEOUT_MS }); }
    catch (cause) { throw failure("info_unavailable", cause); }
    return normalizeInventory(await convertPlist(output, runCommand), snapshotPath);
  };
  const association = inventory => {
    const devices = new Set(binding?.entities.map(entity => entity.device) ?? []);
    const mountPoints = new Set([mountPoint,
      ...(binding?.entities.flatMap(entity => entity.mountPoint === undefined ? [] : [entity.mountPoint]) ?? [])]);
    const related = inventory.filter(image => image.imagePath === snapshotPath
      || image.entities.some(entity => devices.has(entity.device)
        || (entity.mountPoint !== undefined && mountPoints.has(entity.mountPoint))));
    if (related.length === 0) return "absent";
    if (binding === undefined) return "unknown";
    if (related.length !== 1) return "changed";
    const image = related[0];
    return image.imagePath === snapshotPath && image.wholeDevice === binding.wholeDevice
      && image.helperPid === binding.helperPid && image.ownerUid === binding.ownerUid
      && sameEntities(image.entities, binding.entities) ? "exact" : "changed";
  };
  const markDetached = () => { status = "detached"; return receipt(); };
  const inspectAfterCommand = async causes => {
    try { return association(await readInventory()); }
    catch (cause) {
      if (causes.length > 0) throw detachFailure([...causes, cause]);
      throw cause;
    }
  };

  return Object.freeze({
    receipt,
    async attach() {
      requireCondition(!attachEntered && status !== "detached", "state_invalid");
      attachEntered = true;
      const before = await readInventory();
      requireCondition(association(before) === "absent", "already_present");
      // The owner rechecks original host pins and immutable input after info.
      await beforeAttach();
      attempted = true;
      status = "unknown";
      let output, primaryCause, commandFailed = false;
      try {
        output = await runCommand("/usr/bin/hdiutil", [
          "attach", "-plist", "-nobrowse", "-readonly", "-mountpoint", mountPoint, snapshotPath,
        ]);
      } catch (cause) {
        commandFailed = true;
        primaryCause = cause;
        output = completeFailureOutput(cause);
        if (output === undefined) throw cause;
      }
      try {
        const entities = normalizeEntities(await convertPlist(output, runCommand));
        const previousDevices = new Set(before.flatMap(image => image.entities.map(entity => entity.device)));
        requireCondition(entities.every(entity => !previousDevices.has(entity.device)), "device_reused");
        const after = await readInventory();
        const images = after.filter(image => image.imagePath === snapshotPath);
        requireCondition(images.length === 1 && sameEntities(images[0].entities, entities), "association_mismatch");
        requireCondition(images[0].ownerUid === expectedOwnerUid, "owner_mismatch");
        requireCondition(after.every(image => image.imagePath === snapshotPath
          || image.entities.every(entity => entity.mountPoint !== mountPoint)), "association_mismatch");
        if (!commandFailed) requireCondition(entities.some(entity => entity.mountPoint === mountPoint), "mountpoint_missing");
        const image = images[0];
        binding = Object.freeze({
          wholeDevice: image.wholeDevice, entities,
          helperPid: image.helperPid, ownerUid: image.ownerUid,
        });
        status = "bound";
      } catch (cause) {
        if (commandFailed) throw new AggregateError([primaryCause, cause], "dmg_attachment_attach_and_binding_failed");
        throw cause;
      }
      if (commandFailed) throw primaryCause;
      return receipt();
    },
    async detach() {
      const initial = association(await readInventory());
      // A filesystem-recovery retry needs fresh absence, not a stale detach latch.
      // Never detach or adopt an attachment appearing after confirmed absence.
      if (status === "detached") {
        requireCondition(initial === "absent", "association_mismatch");
        return receipt();
      }
      if (initial === "absent") return markDetached();
      requireCondition(binding !== undefined, "ownership_unknown");
      requireCondition(initial === "exact", "association_mismatch");

      let ordinaryCause, ordinaryFailed = false;
      try {
        checkedOutput(await runCommand("/usr/bin/hdiutil", ["detach", binding.wholeDevice], { timeoutMs: DETACH_TIMEOUT_MS }));
      } catch (cause) { ordinaryFailed = true; ordinaryCause = cause; }
      const ordinaryCauses = ordinaryFailed ? [ordinaryCause] : [];
      const afterOrdinary = await inspectAfterCommand(ordinaryCauses);
      if (afterOrdinary === "absent") return markDetached();
      if (!ordinaryFailed) throw failure("detach_unconfirmed");
      if (afterOrdinary !== "exact") throw detachFailure([ordinaryCause, failure("association_mismatch")]);

      // Ordinary failure grants no authority: query again immediately before force.
      const beforeForce = await inspectAfterCommand([ordinaryCause]);
      if (beforeForce === "absent") return markDetached();
      if (beforeForce !== "exact") throw detachFailure([ordinaryCause, failure("association_mismatch")]);
      let forceCause, forceFailed = false;
      try {
        checkedOutput(await runCommand("/usr/bin/hdiutil", ["detach", "-force", binding.wholeDevice], { timeoutMs: DETACH_TIMEOUT_MS }));
      } catch (cause) { forceFailed = true; forceCause = cause; }
      const causes = forceFailed ? [ordinaryCause, forceCause] : [ordinaryCause];
      const afterForce = await inspectAfterCommand(causes);
      if (afterForce === "absent") return markDetached();
      if (forceFailed && afterForce === "exact") throw detachFailure(causes);
      throw detachFailure([...causes, failure(afterForce === "exact" ? "detach_unconfirmed" : "association_mismatch")]);
    },
  });
}

/** Native plutil remains the XML parser; no raw dict duplicate-key guarantee is made. */
async function convertPlist(output, runCommand) {
  const { stdout } = checkedOutput(output);
  requireCondition(stdout.length > 0, "plist_missing");
  let converted;
  try {
    converted = await runCommand("/usr/bin/plutil", [...PLUTIL_ARGS], { stdin: stdout, timeoutMs: QUERY_TIMEOUT_MS });
  } catch (cause) { throw failure("plist_conversion_failed", cause); }
  const json = checkedOutput(converted).stdout;
  let value;
  try { value = JSON.parse(json); }
  catch (cause) { throw failure("plist_json_invalid", cause); }
  requireCondition(record(value), "plist_shape_invalid");
  return value;
}

function normalizeInventory(value, snapshotPath) {
  requireCondition(Object.hasOwn(value, "images") && Array.isArray(value.images)
    && value.images.length <= MAX_IMAGES, "inventory_invalid");
  const imagePaths = new Set(), devices = new Set(), mountPoints = new Set();
  const images = value.images.map(image => {
    requireCondition(record(image) && Object.hasOwn(image, "image-path") && safePath(image["image-path"]), "inventory_invalid");
    const imagePath = image["image-path"];
    // Kernel-mounted system Cryptex images have no userspace helper. They still
    // occupy every reported device/mountpoint, but cannot authorize our detach.
    requireCondition((Object.hasOwn(image, "hdid-pid")
      ? Number.isSafeInteger(image["hdid-pid"]) && image["hdid-pid"] > 0
      : imagePath !== snapshotPath)
      && Object.hasOwn(image, "owner-uid") && Number.isSafeInteger(image["owner-uid"]) && image["owner-uid"] >= 0,
    "inventory_invalid");
    requireCondition(!imagePaths.has(imagePath), "inventory_duplicate");
    imagePaths.add(imagePath);
    // An unrelated APFS image can include both a backing disk and a synthesized
    // container disk. Keep every entity for collision checks; only our snapshot
    // may supply the single whole-device lineage used to authorize detach.
    const entities = normalizeEntities(image, { allowMultipleWholeDevices: imagePath !== snapshotPath });
    for (const entity of entities) {
      requireCondition(!devices.has(entity.device), "inventory_duplicate");
      devices.add(entity.device);
      if (entity.mountPoint !== undefined) {
        requireCondition(!mountPoints.has(entity.mountPoint), "inventory_duplicate");
        mountPoints.add(entity.mountPoint);
      }
    }
    const wholeDevices = entities.filter(entity => WHOLE_DEVICE_PATTERN.test(entity.device));
    return Object.freeze({ imagePath, entities,
      wholeDevice: wholeDevices.length === 1 ? wholeDevices[0].device : undefined,
      ...(Object.hasOwn(image, "hdid-pid") ? { helperPid: image["hdid-pid"] } : {}), ownerUid: image["owner-uid"] });
  });
  return Object.freeze(images);
}

function normalizeEntities(value, { allowMultipleWholeDevices = false } = {}) {
  requireCondition(record(value) && Object.hasOwn(value, "system-entities")
    && Array.isArray(value["system-entities"]) && value["system-entities"].length > 0
    && value["system-entities"].length <= MAX_ENTITIES, "entities_invalid");
  const devices = new Set(), mountPoints = new Set();
  const entities = value["system-entities"].map(entity => {
    requireCondition(record(entity) && Object.hasOwn(entity, "dev-entry")
      && typeof entity["dev-entry"] === "string" && entity["dev-entry"].length <= 128
      && DEVICE_PATTERN.test(entity["dev-entry"]), "entities_invalid");
    const device = entity["dev-entry"];
    requireCondition(!devices.has(device), "entities_duplicate");
    devices.add(device);
    const hasMountPoint = Object.hasOwn(entity, "mount-point");
    requireCondition(!hasMountPoint || safePath(entity["mount-point"]), "entities_invalid");
    if (hasMountPoint) {
      requireCondition(!mountPoints.has(entity["mount-point"]), "entities_duplicate");
      mountPoints.add(entity["mount-point"]);
    }
    if (Object.hasOwn(entity, "content-hint")) {
      requireCondition(typeof entity["content-hint"] === "string" && entity["content-hint"].length <= 512
        && !/[\u0000-\u001f\u007f]/u.test(entity["content-hint"]), "entities_invalid");
    }
    return Object.freeze({ device, ...(hasMountPoint ? { mountPoint: entity["mount-point"] } : {}) });
  });
  const wholeDevices = entities.filter(entity => WHOLE_DEVICE_PATTERN.test(entity.device));
  requireCondition(wholeDevices.length > 0 && (allowMultipleWholeDevices || wholeDevices.length === 1),
    "whole_device_invalid");
  requireCondition(entities.every(entity => wholeDevices.some(whole => entity.device === whole.device
    || entity.device.startsWith(`${whole.device}s`))), "whole_device_invalid");
  return Object.freeze(entities.sort((left, right) => left.device.localeCompare(right.device)));
}

function completeFailureOutput(cause) {
  if (!record(cause) || !record(cause.commandReceipt)
    || !Object.isFrozen(cause.commandReceipt) || cause.commandReceipt.outputComplete !== true) return undefined;
  let current = cause;
  const seen = new Set();
  let nonzeroExit = false;
  while (record(current) && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (current.killed === true || current.signal != null
      || ["ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(current.code)) return undefined;
    if (Number.isSafeInteger(current.code) && current.code > 0) nonzeroExit = true;
    current = current.cause;
  }
  if (!nonzeroExit) return undefined;
  try { return checkedOutput(cause.commandReceipt); }
  catch { return undefined; }
}

function checkedOutput(value) {
  requireCondition(record(value) && typeof value.stdout === "string" && typeof value.stderr === "string"
    && Buffer.byteLength(value.stdout, "utf8") <= MAX_OUTPUT_BYTES
    && Buffer.byteLength(value.stderr, "utf8") <= MAX_OUTPUT_BYTES, "command_output_invalid");
  return value;
}

function sameEntities(left, right) {
  return left.length === right.length && left.every((entity, index) =>
    entity.device === right[index].device && entity.mountPoint === right[index].mountPoint);
}

function safePath(value) {
  return typeof value === "string" && value.length > 1 && Buffer.byteLength(value, "utf8") <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(value) && posix.isAbsolute(value) && posix.resolve(value) === value;
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(code, cause) {
  return new SigningContractError(`dmg_attachment_${code}`, "Attachment custody validation failed",
    arguments.length > 1 ? { cause } : {});
}
function requireCondition(condition, code) { if (!condition) throw failure(code); }
function detachFailure(causes) { return new AggregateError(causes, "dmg_attachment_detach_failed"); }
