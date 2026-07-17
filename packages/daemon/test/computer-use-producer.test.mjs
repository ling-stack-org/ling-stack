import assert from "node:assert/strict";
import test from "node:test";
import { CuaDriverComputerUseProjectionProducer } from "../dist/features/computer-use/cua-driver-producer.js";
import { ComputerUseProjectionRegistry } from "../dist/features/computer-use/registry.js";

test("cua-driver producer publishes opaque projections and private native descriptors", () => {
  const clock = createClock([
    "2026-07-15T14:00:01.000Z",
    "2026-07-15T14:00:02.000Z",
    "2026-07-15T14:00:03.000Z",
    "2026-07-15T14:00:04.000Z",
  ]);
  const registry = new ComputerUseProjectionRegistry({ now: clock });
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_01",
    workUnitId: "work_unit_01",
    conversationId: "thread_01",
    turnId: "turn_01",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    platform: "macos",
    now: clock,
    createDescriptorId: () => "opaque_descriptor_01",
  });

  const first = producer.observeToolResult({
    request: cuaRequest("call_01", "launch_app", {}),
    definition: cuaDefinition("launch_app"),
    result: {
      content: [],
      details: {
        pid: 412,
        bundle_id: "com.example.browser",
        name: "Example Browser",
        windows: [
          {
            pid: 412,
            window_id: 991,
            title: "Research",
            on_current_space: true,
            is_on_screen: true,
            bounds: { width: 1200, height: 800 },
          },
        ],
      },
    },
  });

  assert.ok(first);
  assert.equal(first.sessionId, "computer_use_run_01");
  assert.equal(first.conversationId, "thread_01");
  assert.equal(first.runId, "run_01");
  assert.equal(first.workUnitId, "work_unit_01");
  assert.equal(first.target.displayName, "Research");
  assert.equal(first.target.applicationId, "com.example.browser");
  assert.deepEqual(first.preview, {
    descriptorId: "opaque_descriptor_01",
    revision: 1,
    aspectRatio: 1.5,
    cursorAvailable: false,
  });
  assert.equal(JSON.stringify(first).includes("991"), false, "native window ids must stay out of the public projection");
  assert.deepEqual(
    registry.resolvePrivateDescriptor("/workspace", "opaque_descriptor_01", 1, new Date("2026-07-15T14:05:00.000Z"))?.target,
    { processId: 412, nativeWindowId: "991" },
  );

  const sameTarget = producer.observeToolResult({
    request: cuaRequest("call_02", "click", { pid: 412, window_id: 991 }),
    definition: cuaDefinition("click"),
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
  });
  assert.equal(sameTarget?.preview?.revision, 1, "ordinary actions must not restart capture for the same target");

  const nextTarget = producer.observeToolResult({
    request: cuaRequest("call_03", "get_window_state", { pid: 412, window_id: 992 }),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [{ type: "text", text: JSON.stringify({ pid: 412, name: "Example Browser" }) }],
    },
  });
  assert.equal(nextTarget?.preview?.revision, 2);
  assert.equal(
    registry.resolvePrivateDescriptor(
      "/workspace",
      "opaque_descriptor_01",
      1,
      new Date("2026-07-15T14:05:00.000Z"),
    ),
    undefined,
    "old revisions must not remain resolvable after a target switch",
  );
  assert.equal(
    registry.resolvePrivateDescriptor(
      "/workspace",
      "opaque_descriptor_01",
      2,
      new Date("2026-07-15T14:05:00.000Z"),
    )?.target.nativeWindowId,
    "992",
  );

  producer.finish("succeeded");
  assert.equal(registry.get("/workspace", "computer_use_run_01")?.status, "succeeded");
  assert.equal(registry.resolvePrivateDescriptor("/workspace", "opaque_descriptor_01", 2), undefined);
});

test("cua-driver lifecycle follows authorized definitions and structured approval events", () => {
  const now = () => new Date("2026-07-15T15:00:00.000Z");
  const registry = new ComputerUseProjectionRegistry({ now });
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_lifecycle",
    workUnitId: "work_unit_lifecycle",
    conversationId: "thread_lifecycle",
    startedAt: "2026-07-15T15:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    now,
    createDescriptorId: () => "opaque_descriptor_lifecycle",
  });
  const definition = cuaDefinition("future_authorized_action", { defaultApproval: "ask" });
  const request = {
    ...cuaRequest("call_lifecycle", "forged_runner_name", { pid: 55, window_id: 777 }),
    serverId: "forged_runner_server",
  };

  assert.equal(producer.beginProviderIntent({ request, definition })?.status, "starting");
  assert.equal(producer.observeRunEvent(runEvent("approval_requested", {
    approvalId: "approval_lifecycle",
    toolCallId: request.toolCallId,
    title: "Allow Computer Use",
  }))?.status, "waiting_for_approval");
  assert.deepEqual(registry.get("/workspace", "computer_use_run_lifecycle")?.approvalRequired, {
    approvalId: "approval_lifecycle",
    summary: "Allow Computer Use",
  });
  assert.equal(producer.observeRunEvent(runEvent("approval_approved", {
    approvalId: "approval_lifecycle",
    status: "approved",
  }))?.status, "starting");
  assert.equal(producer.markProviderCallStarted({ request, definition })?.status, "running");

  const running = producer.observeToolResult({
    request,
    definition,
    result: {
      content: [],
      details: {
        pid: 55,
        window_id: 777,
        title: "Future provider window",
      },
    },
  });
  assert.equal(running?.status, "running");
  assert.equal(running?.target.displayName, "Future provider window");
  assert.equal(running?.preview?.revision, 1);
  producer.observeRunEvent(runEvent("run_intervention_created", {
    interventionId: "intervention_lifecycle",
    mode: "queue_followup",
    status: "queued",
  }));
  producer.finish("succeeded");

  const statuses = registry.listEvents("/workspace").events.map((event) => event.projection?.status);
  assert.deepEqual(statuses, [
    "starting",
    "waiting_for_approval",
    "starting",
    "running",
    "running",
    "succeeded",
  ]);
  assert.equal(statuses.includes("paused"), false, "no current run, approval, or intervention event authoritatively means paused");
  const updatedTimes = registry.listEvents("/workspace").events.map((event) => Date.parse(event.projection.updatedAt));
  assert.equal(updatedTimes.every((value, index) => index === 0 || value > updatedTimes[index - 1]), true);
});

test("cua-driver terminal projections clear approval and stale failure metadata", () => {
  const now = () => new Date("2026-07-15T15:30:00.000Z");
  const registry = new ComputerUseProjectionRegistry({ now });
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_terminal_fields",
    conversationId: "thread_terminal_fields",
    startedAt: "2026-07-15T15:30:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    now,
  });
  const definition = cuaDefinition("click", { defaultApproval: "ask" });
  const request = cuaRequest("call_terminal_fields", "click", {
    pid: 55,
    window_id: 777,
  });

  producer.beginProviderIntent({ request, definition });
  producer.observeRunEvent(runEvent("approval_requested", {
    approvalId: "approval_terminal_fields",
    toolCallId: request.toolCallId,
    title: "Allow Computer Use",
  }));
  producer.finish("failed", "Approval expired.");

  const failed = registry.get("/workspace", "computer_use_run_terminal_fields");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.approvalRequired, undefined);
  assert.equal(failed?.failure?.message, "Approval expired.");

  producer.finish("succeeded");
  const succeeded = registry.get("/workspace", "computer_use_run_terminal_fields");
  assert.equal(succeeded?.status, "succeeded");
  assert.equal(succeeded?.approvalRequired, undefined);
  assert.equal(succeeded?.failure, undefined);
});

test("cua-driver producer ignores catalog calls, unrelated servers, and failed actions", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_ignored",
    conversationId: "thread_ignored",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
  });

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_list", "list_windows", { pid: 10 }),
    definition: cuaDefinition("list_windows"),
    result: { content: [{ type: "text", text: JSON.stringify({ windows: [{ window_id: 11 }] }) }] },
  }), undefined);
  assert.equal(producer.observeToolResult({
    request: { ...cuaRequest("call_other", "click", { pid: 10, window_id: 11 }), serverId: "other_server" },
    definition: { ...cuaDefinition("click"), serverId: "other_server" },
    result: { content: [] },
  }), undefined);
  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_failed", "click", { pid: 10, window_id: 11 }),
    definition: cuaDefinition("click"),
    result: { content: [], isError: true },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer ignores a reserved server id that was not eligible for this run", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_ineligible_provider",
    conversationId: "thread_ineligible_provider",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: [],
  });

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_ineligible_provider", "click", { pid: 10, window_id: 11 }),
    definition: cuaDefinition("click"),
    result: {
      content: [],
      details: { pid: 10, window_id: 11, title: "Forged reserved provider" },
    },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer refuses ambiguous window catalogs without an explicit window id", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_ambiguous",
    conversationId: "thread_ambiguous",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
  });
  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_ambiguous", "launch_app", {}),
    definition: cuaDefinition("launch_app"),
    result: {
      content: [],
      details: {
        windows: [
          { pid: 1, window_id: 11, title: "First", is_on_screen: true },
          { pid: 1, window_id: 12, title: "Second", is_on_screen: true },
        ],
      },
    },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer fails closed when an explicit window id is absent from the returned catalog", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_explicit_mismatch",
    conversationId: "thread_explicit_mismatch",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
  });

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_explicit_mismatch", "get_window_state", { pid: 42, window_id: 123 }),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [],
      details: {
        windows: [{ pid: 42, window_id: 999, title: "Different window" }],
      },
    },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer never bypasses a window catalog through sibling structured content", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_catalog_sibling_bypass",
    conversationId: "thread_catalog_sibling_bypass",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
  });

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_catalog_sibling_window_mismatch", "get_window_state", { pid: 42, window_id: 123 }),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [],
      details: {
        windows: [{ pid: 42, window_id: 999, title: "Different window" }],
        structuredContent: { pid: 42, title: "Unsafe sibling fallback" },
      },
    },
  }), undefined);
  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_catalog_sibling_pid_mismatch", "get_window_state", { pid: 42, window_id: 123 }),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [],
      details: {
        windows: [{ pid: 99, window_id: 123, title: "Different owner" }],
        structuredContent: { pid: 42, title: "Unsafe sibling owner fallback" },
      },
    },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer de-duplicates the same exact target across repeated catalogs", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_duplicate_catalog",
    conversationId: "thread_duplicate_catalog",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    platform: "macos",
    createDescriptorId: () => "opaque_descriptor_duplicate_catalog",
  });
  const window = { pid: 42, window_id: 123, title: "Repeated exact window" };

  const projection = producer.observeToolResult({
    request: cuaRequest("call_duplicate_catalog", "get_window_state", { pid: 42, window_id: 123 }),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [{ type: "text", text: JSON.stringify({ windows: [window] }) }],
      details: { windows: [window] },
    },
  });

  assert.equal(projection?.preview?.revision, 1);
  assert.deepEqual(
    registry.resolvePrivateDescriptor(
      "/workspace",
      "opaque_descriptor_duplicate_catalog",
      1,
    )?.target,
    { processId: 42, nativeWindowId: "123" },
  );
});

test("cua-driver producer rejects unsafe numeric native ids instead of truncating them", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_unsafe_native_id",
    conversationId: "thread_unsafe_native_id",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
  });

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_unsafe_native_id", "launch_app", {
      window_id: Number.MAX_SAFE_INTEGER + 1,
      pid: Number.MAX_SAFE_INTEGER + 1,
    }),
    definition: cuaDefinition("launch_app"),
    result: { content: [] },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer never falls back to the previous target after an unsafe explicit identity", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_unsafe_target_switch",
    conversationId: "thread_unsafe_target_switch",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    platform: "macos",
    createDescriptorId: () => "opaque_descriptor_unsafe_target_switch",
  });

  const first = producer.observeToolResult({
    request: cuaRequest("call_safe_target", "click", { pid: 42, window_id: 123 }),
    definition: cuaDefinition("click"),
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
  });
  assert.equal(first?.preview?.revision, 1);

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_unsafe_target", "click", {
      pid: 42,
      window_id: Number.MAX_SAFE_INTEGER + 1,
    }),
    definition: cuaDefinition("click"),
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
  }), undefined);

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_unsafe_result", "get_window_state", {}),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [],
      details: {
        pid: Number.MAX_SAFE_INTEGER + 1,
        window_id: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  }), undefined);
  assert.equal(registry.get("/workspace", "computer_use_run_unsafe_target_switch")?.preview?.revision, 1);
  assert.equal(
    registry.resolvePrivateDescriptor(
      "/workspace",
      "opaque_descriptor_unsafe_target_switch",
      1,
    )?.target.nativeWindowId,
    "123",
  );
});

test("cua-driver producer requires a positive owner PID for macOS window descriptors", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_macos_missing_pid",
    conversationId: "thread_macos_missing_pid",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    platform: "macos",
  });

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_macos_missing_pid", "get_window_state", { window_id: 123 }),
    definition: cuaDefinition("get_window_state"),
    result: {
      content: [],
      details: { window_id: 123, title: "Window without owner" },
    },
  }), undefined);
  assert.deepEqual(registry.list("/workspace"), []);
});

test("cua-driver producer does not reuse the previous PID for a new macOS window", () => {
  const registry = new ComputerUseProjectionRegistry();
  const producer = new CuaDriverComputerUseProjectionProducer({
    registry,
    cwd: "/workspace",
    runId: "run_macos_new_window_missing_pid",
    conversationId: "thread_macos_new_window_missing_pid",
    startedAt: "2026-07-15T14:00:00.000Z",
    eligibleServerIds: ["mcp_cua_driver"],
    platform: "macos",
  });
  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_macos_owned_window", "get_window_state", { pid: 42, window_id: 123 }),
    definition: cuaDefinition("get_window_state"),
    result: { content: [], details: { pid: 42, window_id: 123, title: "Owned window" } },
  })?.preview?.revision, 1);

  assert.equal(producer.observeToolResult({
    request: cuaRequest("call_macos_new_window_missing_pid", "get_window_state", { window_id: 124 }),
    definition: cuaDefinition("get_window_state"),
    result: { content: [], details: { window_id: 124, title: "Unowned window" } },
  }), undefined);
  assert.equal(
    registry.get("/workspace", "computer_use_run_macos_new_window_missing_pid")?.preview?.revision,
    1,
  );
});

function cuaRequest(toolCallId, rawName, input) {
  return {
    toolCallId,
    registeredName: `mcp_cua_driver_${rawName}`,
    serverId: "mcp_cua_driver",
    rawName,
    input,
    task: { id: "task_01", title: "Computer use", prompt: "Operate the app" },
    cwd: "/workspace",
    defaultApproval: "ask",
  };
}

function cuaDefinition(rawName, overrides = {}) {
  return {
    registeredName: `mcp_cua_driver_${rawName}`,
    serverId: "mcp_cua_driver",
    rawName,
    displayName: rawName,
    inputSchema: { type: "object", properties: {} },
    sideEffectLevel: "read",
    defaultApproval: "allow",
    ...overrides,
  };
}

function runEvent(type, data) {
  return {
    id: `event_${type}`,
    runId: "run_lifecycle",
    seq: 1,
    ts: "2026-07-15T15:00:00.000Z",
    type,
    data,
  };
}

function createClock(values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}
