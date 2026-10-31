import assert from "node:assert/strict";
import test from "node:test";

let subject = {};
try {
  subject = await import("../dist/storage/sqlite/run-ancestry.js");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const workspaceId = "workspace-primary";

function resolver() {
  assert.equal(
    typeof subject.resolveRunAncestry,
    "function",
    "shared Run ancestry resolver must exist",
  );
  return subject.resolveRunAncestry;
}

function fixture(length, options = {}) {
  const runs = new Map();
  for (let index = 0; index < length; index += 1) {
    const id = `run-${index}`;
    runs.set(id, Object.freeze({
      id,
      taskId: `inline-or-stored-task-${index}`,
      ...(index === 0 ? {} : { parentRunId: `run-${index - 1}` }),
    }));
  }
  const workspaceByRun = new Map(
    [...runs].map(([id]) => [id, options.workspaceByRun?.get(id) ?? workspaceId]),
  );
  let workspaceReads = 0;
  const ports = {
    getRun: (id) => runs.get(id),
    ...(options.withWorkspaceResolver === false ? {} : {
      getWorkspaceId(run) {
        workspaceReads += 1;
        return workspaceByRun.get(run.id);
      },
    }),
  };
  return {
    runs,
    ports,
    workspaceByRun,
    get workspaceReads() { return workspaceReads; },
    input: {
      leafRunId: `run-${length - 1}`,
      ...(options.expectedRoot === false ? {} : { expectedRootRunId: "run-0" }),
      ...(options.expectedWorkspace === false ? {} : { expectedWorkspaceId: workspaceId }),
    },
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test("discovers a one-Run root without requiring a stored Task or workspace resolver", () => {
  const f = fixture(1, { withWorkspaceResolver: false, expectedRoot: false, expectedWorkspace: false });
  const ancestry = resolver()(f.ports, f.input);
  assert.deepEqual(ancestry, {
    rootRunId: "run-0",
    leafRunId: "run-0",
    entries: [{ id: "run-0", taskId: "inline-or-stored-task-0" }],
  });
});

test("returns the complete chain in root to leaf order and preserves inline task identity", () => {
  const f = fixture(4);
  const ancestry = resolver()(f.ports, f.input);
  assert.deepEqual(ancestry, {
    rootRunId: "run-0",
    leafRunId: "run-3",
    workspaceId,
    entries: [
      { id: "run-0", taskId: "inline-or-stored-task-0" },
      { id: "run-1", parentRunId: "run-0", taskId: "inline-or-stored-task-1" },
      { id: "run-2", parentRunId: "run-1", taskId: "inline-or-stored-task-2" },
      { id: "run-3", parentRunId: "run-2", taskId: "inline-or-stored-task-3" },
    ],
  });
  assert.equal(f.workspaceReads, 4);
});

test("fails closed when the requested leaf Run is missing", () => {
  const f = fixture(1);
  assert.throws(
    () => resolver()(f.ports, { ...f.input, leafRunId: "run-missing" }),
    hasCode("run_ancestry.missing"),
  );
});

test("fails closed when an intermediate parent Run is missing", () => {
  const f = fixture(4);
  f.runs.delete("run-1");
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.missing"));
});

test("rejects a self-cycle", () => {
  const f = fixture(1);
  f.runs.set("run-0", Object.freeze({ id: "run-0", taskId: "task-0", parentRunId: "run-0" }));
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.cycle"));
});

test("rejects a repeated Run in a multi-node cycle", () => {
  const f = fixture(4);
  f.runs.set("run-1", Object.freeze({ id: "run-1", taskId: "task-1", parentRunId: "run-3" }));
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.cycle"));
});

test("accepts exactly 100 parent hops", () => {
  const f = fixture(101);
  const ancestry = resolver()(f.ports, f.input);
  assert.equal(ancestry.entries.length, 101);
  assert.equal(ancestry.entries[0].id, "run-0");
  assert.equal(ancestry.entries.at(-1).id, "run-100");
});

test("rejects 101 parent hops with a fixed non-configurable limit", () => {
  const f = fixture(102);
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.depth_exceeded"));
});

test("allows evaluation callers to discover root but rejects an explicit wrong root", () => {
  const f = fixture(3, { expectedRoot: false });
  assert.equal(resolver()(f.ports, f.input).rootRunId, "run-0");
  assert.throws(
    () => resolver()(f.ports, { ...f.input, expectedRootRunId: "run-foreign" }),
    hasCode("run_ancestry.root_mismatch"),
  );
});

test("requires every resolved durable owner to remain in the expected workspace", () => {
  for (const id of ["run-0", "run-1", "run-3"]) {
    const workspaceByRun = new Map([[id, "workspace-foreign"]]);
    const f = fixture(4, { workspaceByRun });
    assert.throws(
      () => resolver()(f.ports, f.input),
      hasCode("run_ancestry.workspace_mismatch"),
      `${id} must not cross workspace scope`,
    );
  }
});

test("may discover one workspace through the typed resolver without an expected workspace", () => {
  const f = fixture(3, { expectedWorkspace: false });
  const ancestry = resolver()(f.ports, f.input);
  assert.equal(ancestry.workspaceId, workspaceId);
});

test("refuses a workspace claim when no durable workspace resolver is supplied", () => {
  const f = fixture(2, { withWorkspaceResolver: false });
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.invalid_input"));
});

test("rejects a Run returned under a different requested identity", () => {
  const f = fixture(2);
  const getRun = f.ports.getRun;
  f.ports.getRun = (id) => id === "run-0"
    ? Object.freeze({ id: "run-forged", taskId: "task-forged" })
    : getRun(id);
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.identity_mismatch"));
});

test("refuses inherited lineage rather than silently treating a child as a root", () => {
  const f = fixture(2);
  f.runs.set("run-1", Object.assign(Object.create({ parentRunId: "run-0" }), {
    id: "run-1", taskId: "inline-task-1",
  }));
  assert.throws(() => resolver()(f.ports, {
    leafRunId: "run-1",
  }), hasCode("run_ancestry.identity_mismatch"));
});

test("rejects lineage accessors without executing them and missing durable workspace owners", () => {
  const f = fixture(2);
  let getterCalls = 0;
  f.runs.set("run-1", { id: "run-1", taskId: "inline-task-1",
    get parentRunId() { getterCalls += 1; return "run-0"; } });
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.identity_mismatch"));
  assert.equal(getterCalls, 0);
  f.runs.set("run-1", { id: "run-1", taskId: "inline-task-1", parentRunId: "run-0" });
  f.workspaceByRun.delete("run-0");
  assert.throws(() => resolver()(f.ports, f.input), hasCode("run_ancestry.workspace_mismatch"));
});

test("strict input capture rejects accessors, extra fields, and revoked proxies", () => {
  const f = fixture(1);
  let getterCalls = 0;
  const accessorInput = { expectedRootRunId: "run-0", expectedWorkspaceId: workspaceId };
  Object.defineProperty(accessorInput, "leafRunId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "run-0";
    },
  });
  assert.throws(() => resolver()(f.ports, accessorInput), hasCode("run_ancestry.invalid_input"));
  assert.equal(getterCalls, 0);
  assert.throws(
    () => resolver()(f.ports, { ...f.input, maxDepth: 10 }),
    hasCode("run_ancestry.invalid_input"),
  );
  const { proxy, revoke } = Proxy.revocable(f.input, {});
  revoke();
  assert.throws(() => resolver()(f.ports, proxy), hasCode("run_ancestry.invalid_input"));
});

test("returns a frozen result whose entries cannot be rewritten", () => {
  const f = fixture(2);
  const ancestry = resolver()(f.ports, f.input);
  assert.equal(Object.isFrozen(ancestry), true);
  assert.equal(Object.isFrozen(ancestry.entries), true);
  assert.equal(ancestry.entries.every(Object.isFrozen), true);
  assert.throws(() => ancestry.entries.push({ id: "run-forged", taskId: "task-forged" }), TypeError);
  assert.throws(() => { ancestry.entries[0].id = "run-forged"; }, TypeError);
});

test("derives ancestry only from Run parent links and never delegation depth", () => {
  const f = fixture(3);
  let delegationReads = 0;
  f.ports.getDelegationStep = () => {
    delegationReads += 1;
    throw new Error("delegation depth is not Run ancestry");
  };
  const ancestry = resolver()(f.ports, f.input);
  assert.equal(ancestry.entries.length, 3);
  assert.equal(delegationReads, 0);
});
