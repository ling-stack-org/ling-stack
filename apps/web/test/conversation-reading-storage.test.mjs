import assert from "node:assert/strict";
import test from "node:test";
import { conversationReadingScope, createConversationReadingStorage } from "../src/shared/conversation/view-store/conversation-reading-storage.ts";
import { createConversationViewStore } from "../src/shared/conversation/view-store/conversation-view-store.ts";

const key = "ling-stack.conversation-reading.v1";
const anchor = { rowKey: "message:42", parentSubAgentId: "child:7", offsetTop: -12.5 };
function fixture() {
  const values = new Map();
  let clock = 1_000_000_000_000;
  const storage = { getItem: id => values.get(id) ?? null, setItem: (id, value) => values.set(id, value) };
  return { values, storage, reader: createConversationReadingStorage(() => storage, () => clock),
    advance: ms => { clock += ms; } };
}

test("reading scope separates daemon, workspace, surface and thread without storing URL credentials", () => {
  const scope = conversationReadingScope("http://user:secret@localhost:4234/api?token=private#fragment", " /project ", "normal", "thread-1");
  assert.deepEqual(JSON.parse(scope), ["http://localhost:4234/api", "/project", "normal", "thread-1"]);
  for (const args of [
    ["http://localhost:4235/api", "/project", "normal", "thread-1"],
    ["http://localhost:4234/api", "/other", "normal", "thread-1"],
    ["http://localhost:4234/api", "/project", "private", "thread-1"],
    ["http://localhost:4234/api", "/project", "normal", "thread-2"],
  ]) assert.notEqual(conversationReadingScope(...args), scope);
  assert.equal(conversationReadingScope("invalid url", "/project", "normal", "id"), undefined);
  assert.equal(conversationReadingScope("http://localhost", "", "normal", "id"), undefined);
  assert.equal(conversationReadingScope("http://localhost", "/project", "normal", undefined), undefined);
});

test("reopen restores only whitelisted view fields and merges viewport/disclosure writes", () => {
  const { storage, reader, values } = fixture();
  reader.writeViewport("scope", { following: false, anchor: { ...anchor, body: "private transcript" }, permission: "full_access" });
  reader.writeDisclosure("scope", "block", "process:1", true);
  const reopened = createConversationReadingStorage(() => storage, () => 1_000_000_000_000);
  assert.deepEqual(reopened.read("scope").viewport, { following: false, anchor });
  assert.equal(reopened.readDisclosure("scope", "block", "process:1"), true);
  const raw = values.get(key);
  assert.doesNotMatch(raw, /private transcript|permission|full_access|capability|copyFeedback|activeAction/);
  reopened.writeViewport("scope", { following: true, anchor });
  assert.deepEqual(reader.read("scope").viewport, { following: true });
  assert.equal(reader.readDisclosure("scope", "block", "process:1"), true);
  assert.equal(reader.read("other-scope"), undefined);
});

test("bad data, unknown versions, expiry and future timestamps safely fall back", () => {
  const { reader, values, advance } = fixture();
  for (const raw of ["{broken", "null", '{"version":2,"entries":[]}', "x".repeat(300_000)]) {
    values.set(key, raw);
    assert.equal(reader.read("scope"), undefined);
  }
  values.clear();
  reader.writeViewport("scope", { following: false, anchor: { ...anchor, offsetTop: NaN } });
  assert.equal(reader.read("scope"), undefined);
  reader.writeViewport("scope", { following: false, anchor });
  advance(31 * 24 * 60 * 60 * 1000);
  assert.equal(reader.read("scope"), undefined);
  values.set(key, JSON.stringify({ version: 1, entries: [["scope", { updatedAt: Number.MAX_SAFE_INTEGER, disclosures: [] }]] }));
  assert.equal(reader.read("scope"), undefined);
});

test("restricted storage never prevents reading or disclosure", () => {
  for (const storage of [() => { throw new Error("SecurityError"); }, () => ({
    getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); },
  })]) {
    const reader = createConversationReadingStorage(storage);
    assert.doesNotThrow(() => reader.writeDisclosure("scope", "block", "row", true));
    assert.doesNotThrow(() => reader.writeViewport("scope", { following: true }));
    assert.equal(reader.read("scope"), undefined);
  }
});

test("snapshots bound retained sessions and user disclosure preferences", () => {
  const { reader, values } = fixture();
  for (let index = 0; index < 105; index++) reader.writeViewport(`scope-${index}`, { following: true });
  assert.equal(reader.read("scope-0"), undefined);
  assert.ok(reader.read("scope-104"));
  assert.equal(JSON.parse(values.get(key)).entries.length, 100);
  for (let index = 0; index < 135; index++) reader.writeDisclosure("scope-104", "block", `row-${index}`, true);
  assert.equal(reader.readDisclosure("scope-104", "block", "row-0"), undefined);
  assert.equal(reader.readDisclosure("scope-104", "block", "row-134"), true);
  assert.equal(reader.read("scope-104").disclosures.length, 128);
  assert.ok(values.get(key).length * 2 <= 512 * 1024);
});

test("late-mounted historical rows restore preferences without hiding new attention states", () => {
  const { reader } = fixture();
  const persistence = { read: (kind, id) => reader.readDisclosure("scope", kind, id),
    write: (kind, id, expanded) => reader.writeDisclosure("scope", kind, id, expanded) };
  const first = createConversationViewStore("surface", persistence);
  first.ensureDisclosure({ kind: "block", id: "history", revisionKey: "1", defaultExpanded: false });
  first.setDisclosureExpanded("block", "history", true);
  first.setDisclosureExpanded("block", "failure", false);
  first.markCopied("private-copy");
  first.setActiveActionId("private-action");
  const reopened = createConversationViewStore("surface", persistence);
  reopened.reconcileRetainedKeys({ blockIds: new Set(), spanIds: new Set(), actionIds: new Set() });
  reopened.ensureDisclosure({ kind: "block", id: "history", revisionKey: "5", defaultExpanded: false, preserveTouchedStateOnRevision: true });
  assert.equal(reopened.getSnapshot().blockDisclosureById.get("history").expanded, true);
  reopened.ensureDisclosure({ kind: "block", id: "failure", revisionKey: "2", defaultExpanded: true, preserveTouchedStateOnRevision: true });
  assert.equal(reopened.getSnapshot().blockDisclosureById.get("failure").expanded, true);
  assert.equal(reopened.getSnapshot().activeActionId, undefined);
  assert.equal(reopened.getSnapshot().copyFeedbackByActionId.size, 0);
});

test("a restored pending collapse cannot hide later live or attention details", () => {
  const { reader } = fixture();
  reader.writeDisclosure("scope", "block", "tool", false);
  const reopened = createConversationViewStore("surface", {
    read: (kind, id) => reader.readDisclosure("scope", kind, id),
    write: (kind, id, expanded) => reader.writeDisclosure("scope", kind, id, expanded),
  });
  let revision = 0;
  const update = defaultExpanded => {
    reopened.ensureDisclosure({ kind: "block", id: "tool", revisionKey: String(++revision),
      defaultExpanded, preserveTouchedStateOnRevision: true });
    return reopened.getSnapshot().blockDisclosureById.get("tool").expanded;
  };
  assert.equal(update(false), false, "pending keeps the saved collapse");
  assert.equal(update(true), true, "running becomes visible");
  assert.equal(update(true), true, "later attention remains visible");
  assert.equal(update(false), false, "settling restores the original preference");
  assert.equal(reader.readDisclosure("scope", "block", "tool"), false,
    "automatic attention does not rewrite the user's saved preference");

  reopened.setDisclosureExpanded("block", "tool", true);
  assert.equal(update(false), true, "an explicit current interaction replaces the restored preference");
});

test("explicitly keeping an automatically expanded restored row open replaces the old collapse", () => {
  const store = createConversationViewStore("surface", { read: () => false, write: () => {} });
  store.ensureDisclosure({ kind: "block", id: "tool", revisionKey: "running", defaultExpanded: true,
    preserveTouchedStateOnRevision: true });
  store.setDisclosureExpanded("block", "tool", true);
  store.ensureDisclosure({ kind: "block", id: "tool", revisionKey: "settled", defaultExpanded: false,
    preserveTouchedStateOnRevision: true });
  assert.equal(store.getSnapshot().blockDisclosureById.get("tool").expanded, true);
});
