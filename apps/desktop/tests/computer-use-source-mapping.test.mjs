import assert from "node:assert/strict";
import test from "node:test";
import {
  parseElectronWindowSourceId,
  sourceMatchesDescriptor,
} from "../dist/main/computer-use/source-mapping.js";

test("Electron window source parsing extracts only the exact native id segment", () => {
  assert.equal(parseElectronWindowSourceId("window:123:0"), "123");
  assert.equal(parseElectronWindowSourceId("window:123:screen:0"), "123");
  assert.equal(parseElectronWindowSourceId("screen:123:0"), undefined);
  assert.equal(parseElectronWindowSourceId("window::0"), undefined);
  assert.equal(parseElectronWindowSourceId("window:123"), undefined);
});

test("source matching requires the exact Electron source kind and id", () => {
  assert.equal(
    sourceMatchesDescriptor(
      { id: "screen:0:0" },
      "screen",
      { electronSourceId: "screen:0:0" },
    ),
    true,
  );
  assert.equal(
    sourceMatchesDescriptor(
      { id: "window:123:0" },
      "window",
      { electronSourceId: "window:123:0" },
    ),
    true,
  );
  assert.equal(
    sourceMatchesDescriptor(
      { id: "window:123:0" },
      "screen",
      { electronSourceId: "window:123:0" },
    ),
    false,
  );
  assert.equal(
    sourceMatchesDescriptor(
      { id: "window:1234:0" },
      "window",
      { electronSourceId: "window:123:0" },
    ),
    false,
  );
});

test("native window identity cannot authorize a display or a similarly prefixed window", () => {
  assert.equal(
    sourceMatchesDescriptor({ id: "window:123:0" }, "window", { nativeWindowId: "123" }),
    true,
  );
  assert.equal(
    sourceMatchesDescriptor({ id: "window:1234:0" }, "window", { nativeWindowId: "123" }),
    false,
  );
  assert.equal(
    sourceMatchesDescriptor({ id: "screen:123:0" }, "screen", { nativeWindowId: "123" }),
    false,
  );
});

test("when both identities are present, both must match", () => {
  assert.equal(
    sourceMatchesDescriptor(
      { id: "window:123:0" },
      "window",
      { nativeWindowId: "123", electronSourceId: "window:123:1" },
    ),
    false,
  );
  assert.equal(
    sourceMatchesDescriptor(
      { id: "window:123:0" },
      "window",
      { nativeWindowId: "123", electronSourceId: "window:123:0" },
    ),
    true,
  );
});

test("empty or malformed identities fail closed", () => {
  assert.equal(sourceMatchesDescriptor({ id: "window:123:0" }, "window", {}), false);
  assert.equal(sourceMatchesDescriptor({ id: "window:123:0" }, "window", { nativeWindowId: " 123" }), false);
  assert.equal(sourceMatchesDescriptor({ id: "" }, "window", { nativeWindowId: "123" }), false);
});
