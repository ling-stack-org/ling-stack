import assert from "node:assert/strict";
import test from "node:test";
import { verifyOfficeLocalDirectoryReplayV2 } from "../dist/index.js";
import { validateOfficeLocalDirectoryObservationPayloadV2 } from "../dist/storage/sqlite/host-office-local-directory-v2-observations.js";
import { directoryV2ReplayFixture, resealDirectoryV2Replay } from "./support/host-office-local-directory-v2-replay-fixture.mjs";

const invalid = error => error.code === "host_office_local_directory_v2_evidence_invalid";
function inputWithPreparedChange(change) {
  const input = directoryV2ReplayFixture();
  // Only the preparation snapshot changes: every original native first-fstat
  // and later historical copy stays unchanged. Resealing binds the test DTOs.
  change(input.execution.stage.ancestors[0].identity);
  resealDirectoryV2Replay(input);
  return input;
}
function validateCapture(input) {
  const { effect, observation } = input.effects[0];
  return validateOfficeLocalDirectoryObservationPayloadV2(input.execution, effect, observation, observation.completedAt);
}

test("prepared directory size/timestamps may differ from the original first fstat without replacing node authority", () => {
  const input = inputWithPreparedChange(identity => {
    identity.sizeBytes = "8192"; identity.modifiedNs = "2"; identity.changedNs = "3";
  });
  const before = JSON.stringify(input), original = input.effects[0].observation.native.result.snapshot.resources[0].initialIdentity;
  assert.notDeepEqual(input.execution.stage.ancestors[0].identity, original);
  assert.equal(validateCapture(input).native.state, "returned");
  assert.equal(verifyOfficeLocalDirectoryReplayV2(input).kind, "graph_verified_only");
  assert.equal(JSON.stringify(input), before, "keep complete original first-fstat and immutable history; never normalize facts");
});

for (const [label, change] of [
  ["device", identity => { identity.device = "99"; }],
  ["inode", identity => { identity.inode = "99"; }],
  ["permissions", identity => { identity.mode = 0o040755; }],
  ["type", identity => { identity.isFile = true; identity.isDirectory = false; identity.mode = 0o100700; }],
]) test(`prepared directory still rejects a different original ${label}`, () => {
  const input = inputWithPreparedChange(change);
  assert.throws(() => validateCapture(input), invalid);
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2(input), invalid);
});

test("accepting volatile preparation drift cannot rewrite original initial identity in a later snapshot", () => {
  const input = inputWithPreparedChange(identity => { identity.modifiedNs = "2"; });
  input.effects[1].observation.native.result.snapshot.resources[0].initialIdentity.modifiedNs = "3";
  resealDirectoryV2Replay(input);
  assert.throws(() => verifyOfficeLocalDirectoryReplayV2(input), invalid);
});
