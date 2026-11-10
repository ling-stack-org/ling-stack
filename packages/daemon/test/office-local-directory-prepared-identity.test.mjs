import assert from "node:assert/strict";
import test from "node:test";
import { OfficeLocalDirectoryResourceFacts } from "../dist/features/office-documents/office-local-directory-resource-facts.js";
import { directoryV2Prepared, directoryV2Capture } from "../../core/test/support/host-office-local-directory-v2-fixture.mjs";

function fixture(change) {
  const execution = { ...directoryV2Prepared(), identityDigest: "e".repeat(64) },
    effect = { effectId: "capture", ordinal: 0, kind: "capture_parents", enteredAt: execution.preparedAt },
    facts = directoryV2Capture(execution, effect).native.result;
  change(execution.stage.ancestors[0].identity);
  return { execution, facts, ledger: new OfficeLocalDirectoryResourceFacts(execution) };
}

test("Daemon slot admission uses stable prepared directory identity while preserving full native first-fstat facts", () => {
  const f = fixture(identity => { identity.sizeBytes = "8192"; identity.modifiedNs = "2"; identity.changedNs = "3"; });
  const before = JSON.stringify(f.facts), bindings = f.ledger.accept("capture", f.facts);
  assert.equal(bindings.length, 4);
  assert.deepEqual(bindings[0].firstFstatCallRef, { effectId: "capture", ordinal: 1 });
  assert.equal(JSON.stringify(f.facts), before);
});

for (const [label, change] of [
  ["device", identity => { identity.device = "99"; }],
  ["inode", identity => { identity.inode = "99"; }],
  ["permissions", identity => { identity.mode = 0o040755; }],
  ["type", identity => { identity.isFile = true; identity.isDirectory = false; identity.mode = 0o100700; }],
]) test(`Daemon admission rejects changed prepared directory ${label} without partially advancing bindings`, () => {
  const f = fixture(change);
  assert.throws(() => f.ledger.accept("capture", f.facts), /office_local_directory_resource_binding_invalid/u);
  assert.throws(() => f.ledger.binding(f.execution.stage.ancestors[0].resourceSlotId), /office_local_directory_resource_binding_invalid/u);
});
