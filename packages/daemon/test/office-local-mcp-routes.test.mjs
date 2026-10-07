import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Packer } from "docx";
import { OfficeParser } from "officeparser";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { createDefaultMcpBroker } from "../dist/features/mcp/broker.js";
import { reserveHostMcpOperation } from "../dist/features/mcp/host-operation.js";
import { captureMcpResultAuthority } from "../dist/features/mcp/result-authority.js";
import { createMcpToolCallHandler } from "../dist/features/runs/mcp.js";
import { createChromeBrowserGenerationBroker } from "../dist/features/plugins/chrome-browser-generation-broker.js";
import { createOfficeDocumentsGenerationBroker, officeDocumentTools } from "../dist/features/plugins/office-documents-generation-broker.js";
import { createCuaDriverGenerationBroker } from "../dist/features/plugins/cua-driver-generation-broker.js";

const now = () => new Date().toISOString();
const required = Object.freeze({ kind: "user_input_required", requestId: "office-mcp-stop", requestVersion: 1 });
const creates = { xlsx: "office_create_workbook", docx: "office_create_document", pptx: "office_create_presentation" };
const inputs = {
  xlsx: { path: "result.xlsx", sheets: [{ name: "Summary", rows: [["Metric", "Value"], ["Users", 42]] }] },
  docx: { path: "result.docx", blocks: [{ type: "paragraph", text: "Original Office" }] },
  pptx: { path: "result.pptx", slides: [{ title: "Original Office", bullets: ["Native bytes"] }] },
};
const edits = {
  xlsx: { name: "office_edit_workbook", input: { path: "result.xlsx", edits: [{ sheet: "Summary", cell: "B2", value: 43 }] } },
  docx: { name: "office_edit_document", input: { path: "result.docx", replacements: [{ search: "Original", replace: "Updated" }] } },
  pptx: { name: "office_edit_presentation", input: { path: "result.pptx", replacements: [{ slide: 1, search: "Original", replace: "Updated" }] } },
};

async function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-mcp-routes-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "office-mcp-task", title: "Fixed Office", prompt: "Original source Office" };
  const f = createUnifiedExecFixture(t, cwd, task, "office-mcp-run");
  const tracker = new AttemptHostOperationTracker({ store: f.store, source: { runId: f.run.id, ...f.sourceFence } });
  const secretResolver = { resolve: () => ({ configured: false }) };
  const server = f.store.createMcpServer({ id: OFFICE_DOCUMENTS_MCP_SERVER_ID, displayName: "Office local", enabled: true,
    required: false, transport: { type: "streamable-http", url: "http://127.0.0.1:1/never-used", headers: {}, secretHeaderRefs: {} } }, now());
  const toolInputs = [...officeDocumentTools, { rawName: "office_read_ranges", displayName: "Live read", inputSchema: {},
    callableNamespace: "office", callableName: "office_read_ranges", sideEffectLevel: "read", defaultApproval: "allow" }];
  f.store.replaceMcpServerTools(server.id, toolInputs, now());
  const definitions = toolInputs.map(tool => ({ registeredName: `mcp_${tool.rawName}`, serverId: server.id, ...tool }));
  let oldEffects = 0, desktopEffects = 0;
  const forbiddenOld = () => { oldEffects++; throw new Error("legacy_office_service_invoked"); };
  const forbiddenDesktop = () => { desktopEffects++; throw new Error("live_office_invoked"); };
  const chrome = createChromeBrowserGenerationBroker({ baseBroker: createDefaultMcpBroker(), workspaceCwd: cwd,
    controller: { execute: forbiddenDesktop, snapshot: () => ({ connected: false }) } });
  const office = createOfficeDocumentsGenerationBroker({ baseBroker: chrome, workspaceCwd: cwd,
    controller: { execute: forbiddenDesktop, snapshot: () => ({ connected: false }) },
    artifacts: { createWorkbook: forbiddenOld, editWorkbook: forbiddenOld, createDocument: forbiddenOld, editDocument: forbiddenOld,
      createPresentation: forbiddenOld, editPresentation: forbiddenOld, inspect: forbiddenOld } });
  const broker = createCuaDriverGenerationBroker({ baseBroker: office, bundledEnabled: true, workspaceCwd: cwd,
    leaseRegistry: { getCurrent: forbiddenDesktop }, clientPool: { acquire: forbiddenDesktop } });
  let sequence = 0, projections = 0;
  const request = (name = creates.docx, input = inputs.docx, signal) => ({ toolCallId: `office-mcp-call-${++sequence}`,
    registeredName: `mcp_${name}`, serverId: server.id, rawName: name, input, task, cwd, defaultApproval: "ask", signal });
  const handler = (selectedBroker = broker, options = {}) => createMcpToolCallHandler(f.store, secretResolver, selectedBroker, definitions,
    { runId: f.run.id, hostOperationTracker: tracker, onResult: () => { projections++; }, ...options });
  const rows = () => tracker.executorGroup.getSnapshot().operations.map(row => f.store.getHostOperation(row.ticket.id));
  const replaceOwner = () => f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "office-successor", runnerId: "pi", status: "started", now: now() });
  return { ...f, cwd, task, tracker, server, broker, office, request, handler, rows, replaceOwner, secretResolver, definitions,
    get oldEffects() { return oldEffects; }, get desktopEffects() { return desktopEffects; }, get projections() { return projections; } };
}
function assertBinaryPair(f, safe) {
  const rows = f.rows(); assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.parentOperationId)?.producerId, "office-local-binary");
  assert.equal(rows.find(row => row.parentOperationId)?.kind, "file_mutation");
  assert.ok(rows.every(row => row.phase === (safe ? "safe" : "unknown_outcome")));
  assert.equal(f.oldEffects, 0); assert.equal(f.desktopEffects, 0);
}
const nestedMessage = (error, message) => error?.message === message || (error?.cause && nestedMessage(error.cause, message))
  || (Array.isArray(error?.errors) && error.errors.some(cause => nestedMessage(cause, message)));

for (const format of Object.keys(creates)) {
  test(`real production factory and handler route six local ${format} create/edit calls to fixed binary receipts`, async t => {
    const f = await fixture(t), call = f.handler();
    const created = (await call(f.request(creates[format], inputs[format]))).details;
    assertBinaryPair(f, true);
    const original = readFileSync(created.path), result = await call(f.request(edits[format].name, edits[format].input));
    assert.deepEqual(readFileSync(result.details.recoveryPath), original);
    const text = (await OfficeParser.parseOffice(readFileSync(result.details.path), { fileType: format, extractAttachments: false, ocr: false })).toText();
    assert.match(text, new RegExp(format === "xlsx" ? "43" : "Updated"));
    const rows = f.rows(); assert.equal(rows.length, 4); assert.ok(rows.every(row => row.phase === "safe"));
    assert.ok(rows.every(row => ["office_local_binary_completed", "office_local_chain_completed"].includes(row.settlementKind)));
    assert.equal(f.oldEffects, 0); assert.equal(f.desktopEffects, 0); assert.equal(f.projections, 2);
  });
}

for (const variant of ["cloned-factory", "replaced-callTool", "custom-broker"]) {
  test(`Office owned fixed route refuses ${variant} before legacy or physical effects`, async t => {
    const f = await fixture(t); let calls = 0, selected = f.broker;
    if (variant === "cloned-factory") selected = { ...f.broker };
    if (variant === "replaced-callTool") { const original = f.broker.callTool; f.broker.callTool = (...args) => { calls++; return original(...args); }; }
    if (variant === "custom-broker") selected = { ...f.broker, callTool: async () => { calls++; return { content: [] }; } };
    await assert.rejects(f.handler(selected)(f.request()), error => error.code === "mcp_host_admission_unsupported");
    assert.equal(calls, 0); assert.equal(f.oldEffects, 0); assert.equal(f.desktopEffects, 0);
    assert.equal(existsSync(join(f.cwd, "result.docx")), false);
    assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  });
}

for (const name of ["office_inspect_document", "office_read_ranges"]) {
  test(`owned ${name} remains rejected instead of inheriting fixed six authority`, async t => {
    const f = await fixture(t);
    await assert.rejects(f.handler()(f.request(name, name === "office_read_ranges" ? { sessionId: "live", ranges: ["A1"] } : { path: "result.docx" })),
      error => error.code === "mcp_host_admission_unsupported");
    assert.equal(f.oldEffects, 0); assert.equal(f.desktopEffects, 0);
    assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  });
}

test("forged Office option cannot fall through to untracked legacy file writes", async t => {
  const f = await fixture(t);
  await assert.rejects(f.broker.callTool(f.server, { secretResolver: f.secretResolver, workspaceCwd: f.cwd,
    runId: f.run.id, toolCallId: "forged-office", officeLocalOperation: {} }, creates.docx, inputs.docx),
    error => error.code === "mcp_host_admission_unsupported");
  assert.equal(f.oldEffects, 0); assert.equal(existsSync(join(f.cwd, "result.docx")), false); assert.equal(f.rows().length, 0);
});

test("original Office reservation precedes best-effort observer and never generic-finally downgrades a complete receipt", async t => {
  const f = await fixture(t);
  const result = await f.handler(f.broker, { onStart() {
    assert.equal(f.rows().find(row => row.parentOperationId)?.producerId, "office-local-binary");
    throw new Error("projection observer failed");
  } })(f.request());
  assert.ok(result.details.path); assertBinaryPair(f, true); assert.equal(f.projections, 1);
});

test("onStart input mutation cannot change the original captured path or nested document bytes", async t => {
  const f = await fixture(t), input = structuredClone(inputs.docx);
  const result = await f.handler(f.broker, { onStart() { input.path = "different.docx"; input.blocks[0].text = "Observer mutation"; } })(f.request(creates.docx, input));
  assert.equal(result.details.path, join(f.cwd, "result.docx")); assert.equal(existsSync(join(f.cwd, "different.docx")), false);
  const text = (await OfficeParser.parseOffice(readFileSync(result.details.path), { fileType: "docx", extractAttachments: false, ocr: false })).toText();
  assert.match(text, /Original Office/u); assert.doesNotMatch(text, /Observer mutation/u); assertBinaryPair(f, true);
});

test("onStart replaced outer callTool is never invoked and closes only the original binary no-start pair", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.handler(f.broker, { onStart() { f.broker.callTool = async () => { calls++; return { content: [] }; }; } })(f.request()),
    error => error.code === "mcp_host_admission_unsupported");
  assert.equal(calls, 0); assertBinaryPair(f, true); assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  assert.equal(existsSync(join(f.cwd, "result.docx")), false); assert.equal(f.projections, 0);
});

test("onStart callTool accessor cannot substitute an arbitrary callback between registry check and dispatch", async t => {
  const f = await fixture(t), original = f.broker.callTool;
  let getterReads = 0, replacementCalls = 0;
  const replacement = async () => { replacementCalls++; return { content: [] }; };
  await assert.rejects(f.handler(f.broker, { onStart() {
    // Old property-read validation selected original twice, then invoked replacement on read three.
    Object.defineProperty(f.broker, "callTool", { configurable: true, enumerable: true,
      get() { return ++getterReads === 3 ? replacement : original; } });
  } })(f.request()), error => error.code === "mcp_host_admission_unsupported");
  assert.equal(getterReads, 0, "registered factory validation must inspect an own data descriptor without running accessors");
  assert.equal(replacementCalls, 0); assert.equal(f.projections, 0); assertBinaryPair(f, true);
  assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  assert.equal(existsSync(join(f.cwd, "result.docx")), false);
});

for (const seam of ["outer", "delegated-office"]) {
  test(`captured ${seam} registered method own call property cannot substitute arbitrary dispatch`, async t => {
    const f = await fixture(t), selected = seam === "outer" ? f.broker : f.office, original = selected.callTool;
    let replacementCalls = 0;
    const result = await f.handler(f.broker, { onStart() {
      original.call = async () => { replacementCalls++; return { content: [] }; };
    } })(f.request());
    assert.equal(selected.callTool, original);
    assert.equal(replacementCalls, 0, "invocation must apply the captured original function without reading its mutable call property");
    assert.equal(result.details.path, join(f.cwd, "result.docx")); assertBinaryPair(f, true);
    assert.equal(f.projections, 1);
    assert.ok(f.rows().every(row => ["office_local_binary_completed", "office_local_chain_completed"].includes(row.settlementKind)));
  });
}

for (const variant of ["cycle", "BigInt"]) {
  test(`cloneable ${variant} request digest failure retains genuine original no-start without opening the reader`, async t => {
    const f = await fixture(t), input = structuredClone(inputs.docx);
    if (variant === "cycle") input.extra = input; else input.extra = 1n;
    await assert.rejects(f.handler()(f.request(creates.docx, input)));
    assertBinaryPair(f, true); assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
    assert.equal(existsSync(join(f.cwd, "result.docx")), false); assert.equal(f.projections, 0);
    assert.equal(f.store.database.prepare("SELECT count(*) n FROM host_office_local_executions").get().n, 0);
  });
}

test("required input in the pre-dispatch observer safely closes the original binary no-start pair", async t => {
  const f = await fixture(t);
  await assert.rejects(f.handler(f.broker, { onStart() { f.tracker.executorGroup.closeAdmission(required); } })(f.request()),
    error => nestedMessage(error, "Host executor admission is closed for required input."));
  assertBinaryPair(f, true); assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  assert.equal(existsSync(join(f.cwd, "result.docx")), false); assert.equal(f.projections, 0);
});

test("already cancelled Office handler reserves its original binary roles and performs no capture or writes", async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error("office already cancelled"); controller.abort(reason);
  await assert.rejects(f.handler()(f.request(creates.docx, inputs.docx, controller.signal)), error => error === reason);
  assertBinaryPair(f, true); assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  assert.equal(existsSync(join(f.cwd, "result.docx")), false);
});

for (const variant of ["required-input", "cancel", "source-replacement", "mcp-authority-change", "factory-method-change"]) {
  test(`real handler ${variant} during real serializer await suppresses late writes and projection`, async t => {
    const f = await fixture(t), original = Packer.toBuffer, controller = new AbortController(); let entered = false;
    t.mock.method(Packer, "toBuffer", async (...args) => {
      await Promise.resolve(); entered = true;
      if (variant === "required-input") f.tracker.executorGroup.closeAdmission(required);
      if (variant === "cancel") controller.abort(new Error("office cancelled during SDK"));
      if (variant === "source-replacement") f.replaceOwner();
      if (variant === "mcp-authority-change") f.store.updateMcpServer(f.server.id, { disabledTools: [creates.docx] }, now());
      if (variant === "factory-method-change") { const call = f.office.callTool; f.office.callTool = (...args) => call(...args); }
      return original(...args);
    });
    await assert.rejects(f.handler()(f.request(creates.docx, inputs.docx, controller.signal)));
    assert.equal(entered, true, "must exercise the real SDK await, not fail at old facade admission");
    assert.equal(existsSync(join(f.cwd, "result.docx")), false); assert.equal(f.projections, 0);
    assert.equal(f.oldEffects, 0); assert.equal(f.desktopEffects, 0);
    if (variant === "source-replacement") assert.ok(f.rows().every(row => row.phase !== "safe"));
    else { assertBinaryPair(f, true); assert.ok(f.rows().every(row => row.settlementKind === "known_no_start")); }
  });
}

test("real handler preparation ACK loss preserves bound unknown roles and never runs generic finish", async t => {
  const f = await fixture(t), original = f.store.prepareHostOfficeLocalExecution.bind(f.store); let entered = false;
  t.mock.method(f.store, "prepareHostOfficeLocalExecution", (...args) => { original(...args); entered = true; throw new Error("production prepare ACK lost"); });
  await assert.rejects(f.handler()(f.request()), error => nestedMessage(error, "production prepare ACK lost"));
  assert.equal(entered, true); assertBinaryPair(f, false); assert.equal(f.projections, 0);
  assert.equal(existsSync(join(f.cwd, "result.docx")), false);
});

test("production nested directory create refuses an injected Store without legacy mkdir or fallback", async t => {
  const f = await fixture(t);
  await assert.rejects(f.handler()(f.request(creates.docx, { ...inputs.docx, path: "new/nested/result.docx" })),
    error => nestedMessage(error, "office_local_directory_core_composition_invalid"));
  assert.equal(existsSync(join(f.cwd, "new")), false); assert.equal(existsSync(join(f.cwd, "new/nested/result.docx")), false);
  assert.ok(f.rows().every(row => row.phase !== "safe")); assert.equal(f.projections, 0); assert.equal(f.oldEffects, 0);
});

async function assertPerEffectForwardStop(t, variant, timing) {
  const f = await fixture(t), controller = new AbortController();
  const actual = { openSync: fs.openSync, writeSync: fs.writeSync, fsyncSync: fs.fsyncSync,
    linkSync: fs.linkSync, renameSync: fs.renameSync, closeSync: fs.closeSync };
  const originalObservation = f.store.recordHostOfficeLocalObservation.bind(f.store);
  const originalPrepare = f.store.prepareHostOfficeLocalEffect.bind(f.store);
  let stopped = false, temporaryOpens = 0, forwardWrites = 0, forwardNative = 0, forwardPrepared = 0;
  let originalFd, originalFdLive = false, cleanupCloses = 0, failure;
  const stop = () => {
    if (variant === "MCP revoke") f.store.updateMcpServer(f.server.id, { disabledTools: [creates.docx] }, now());
    if (variant === "cancel") controller.abort(new Error("office_mcp_per_effect_cancelled"));
    if (variant === "factory swap") { const call = f.office.callTool; f.office.callTool = (...args) => call(...args); }
    stopped = true;
  };
  fs.openSync = (...args) => {
    const fd = actual.openSync(...args);
    if (typeof args[0] === "string" && args[0].includes(".ling-office-")
      && (args[1] & fs.constants.O_WRONLY) !== 0) {
      temporaryOpens++; originalFd = fd; originalFdLive = true;
      if (stopped) forwardNative++;
    }
    return fd;
  };
  fs.writeSync = (...args) => { if (stopped && args[0] === originalFd) { forwardWrites++; forwardNative++; } return actual.writeSync(...args); };
  fs.fsyncSync = (...args) => { if (stopped && args[0] === originalFd) forwardNative++; return actual.fsyncSync(...args); };
  for (const method of ["linkSync", "renameSync"]) {
    fs[method] = (...args) => { if (stopped && args[1] === join(f.cwd, "result.docx")) forwardNative++; return actual[method](...args); };
  }
  fs.closeSync = fd => {
    const original = originalFdLive && fd === originalFd;
    const result = actual.closeSync(fd);
    if (original) { originalFdLive = false; if (stopped) cleanupCloses++; }
    return result;
  };
  t.mock.method(f.store, "recordHostOfficeLocalObservation", (...args) => {
    const effect = originalObservation(...args);
    // Persist outside the original native launch's BEGIN IMMEDIATE transaction.
    if (!stopped && timing === "after-open" && effect.kind === "open" && effect.memberId === "temporary" && effect.mode === "forward") stop();
    return effect;
  });
  t.mock.method(f.store, "prepareHostOfficeLocalEffect", (...args) => {
    if (stopped && args[1].mode === "forward") forwardPrepared++;
    const effect = originalPrepare(...args);
    // The descriptor exists, but native launch has not entered; a prepare-only fence is insufficient.
    if (!stopped && timing === "before-native" && effect.kind === "write" && effect.memberId === "temporary" && effect.mode === "forward") stop();
    return effect;
  });
  syncBuiltinESMExports();
  t.after(() => { for (const [method, original] of Object.entries(actual)) fs[method] = original; syncBuiltinESMExports(); });
  await assert.rejects(f.handler()(f.request(creates.docx, inputs.docx, controller.signal)), error => { failure = error; return true; });
  t.diagnostic(`variant=${variant} timing=${timing} temporaryOpens=${temporaryOpens} stopped=${stopped} forwardWrites=${forwardWrites} forwardNative=${forwardNative} forwardPrepared=${forwardPrepared} cleanupCloses=${cleanupCloses} cause=${failure?.cause?.message ?? failure?.message}`);
  assert.equal(temporaryOpens, 1, "exercise one real original temporary open before changing permission");
  assert.equal(stopped, true, "exercise a real persisted permission, signal or original registry change");
  assert.equal(forwardWrites, 0, "a prior factory/SDK fence cannot authorize a new effect after the MCP tool was revoked");
  assert.equal(forwardNative, 0, "no new forward native API may run after the captured authority changes");
  assert.equal(forwardPrepared, 0, "stale authority may not prepare another forward effect");
  assert.equal(cleanupCloses, 1, "new permission changes must not block release of the exact original owned descriptor");
  assert.equal(originalFdLive, false);
  assert.equal(existsSync(join(f.cwd, "result.docx")), false);
  const executionId = f.store.database.prepare("SELECT execution_id FROM host_office_local_executions").get().execution_id;
  const effects = f.store.listHostOfficeLocalEffects(executionId);
  assert.ok(effects.some(effect => effect.kind === "close" && effect.mode === "cleanup"));
  assert.ok(f.rows().every(row => row.phase !== "safe")); assert.equal(f.projections, 0); assert.equal(f.oldEffects, 0);
}

test("original temporary open followed by MCP revoke admits zero new forward native writes", async t => {
  await assertPerEffectForwardStop(t, "MCP revoke", "after-open");
});

for (const variant of ["MCP revoke", "cancel", "factory swap"]) {
  for (const timing of ["after-open", "before-native"]) {
    if (variant === "MCP revoke" && timing === "after-open") continue;
    test(`real handler per-effect ${variant} ${timing} blocks forward preparation/native while preserving original FD cleanup`, async t => {
      await assertPerEffectForwardStop(t, variant, timing);
    });
  }
}

test("production readonly close uncertainty remains a blocker despite zero mutating effects", async t => {
  const f = await fixture(t); await f.handler()(f.request());
  let retained, injected = false; const actualOpen = fs.openSync, actualClose = fs.closeSync;
  fs.openSync = (...args) => { const fd = actualOpen(...args); if (args[0] === join(f.cwd, "result.docx")) retained = fd; return fd; };
  fs.closeSync = fd => { if (fd === retained) { injected = true; throw Object.assign(new Error("production readonly close unknown"), { code: "EIO" }); } return actualClose(fd); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = actualOpen; fs.closeSync = actualClose; syncBuiltinESMExports(); if (retained !== undefined) actualClose(retained); });
  await assert.rejects(f.handler()(f.request(edits.docx.name, edits.docx.input)), error => nestedMessage(error, "production readonly close unknown"));
  assert.equal(injected, true); assert.equal(fs.fstatSync(retained).isFile(), true);
  assert.ok(f.rows().slice(2).every(row => row.phase !== "safe")); assert.equal(f.projections, 1);
});

for (const variant of ["cloned-token", "both-capabilities", "different-tool", "different-input", "different-workspace"]) {
  test(`original Office token rejects ${variant} without expanding its reserved scope`, async t => {
    const f = await fixture(t);
    const { reserveHostOfficeLocalMcpOperation, bindHostOfficeLocalMcpAuthority, finishHostOfficeLocalMcpOperation } =
      await import("../dist/features/mcp/office-local-mcp-operation.js");
    const originalInput = structuredClone(inputs.docx), operation = reserveHostOfficeLocalMcpOperation({ broker: f.broker,
      tracker: f.tracker, store: f.store, workspaceCwd: f.cwd, toolCallId: "direct-office", toolName: creates.docx,
      input: originalInput, approval: "ask" });
    bindHostOfficeLocalMcpAuthority(operation, captureMcpResultAuthority(f.store, f.server.id, creates.docx).authority);
    const transport = variant === "both-capabilities" ? reserveHostMcpOperation(f.tracker, "unrelated-transport") : undefined;
    try {
      await assert.rejects(f.broker.callTool(f.server, { secretResolver: f.secretResolver,
        workspaceCwd: variant === "different-workspace" ? join(f.cwd, "other") : f.cwd,
        runId: f.run.id, toolCallId: "direct-office", officeLocalOperation: variant === "cloned-token" ? { ...operation } : operation,
        ...(transport ? { hostOperation: transport } : {}) }, variant === "different-tool" ? creates.pptx : creates.docx,
      variant === "different-input" ? structuredClone(originalInput) : originalInput), error => error.code === "mcp_host_admission_unsupported");
    } finally { finishHostOfficeLocalMcpOperation(operation); transport?.finish(); }
    assert.equal(f.oldEffects, 0); assert.equal(f.desktopEffects, 0); assert.equal(existsSync(join(f.cwd, "result.docx")), false);
    assert.ok(f.rows().every(row => row.settlementKind === "known_no_start"));
  });
}

test("same original Office operation reentry cannot execute its fixed writer twice", async t => {
  const f = await fixture(t);
  const { reserveHostOfficeLocalMcpOperation, bindHostOfficeLocalMcpAuthority, finishHostOfficeLocalMcpOperation } =
    await import("../dist/features/mcp/office-local-mcp-operation.js");
  const input = structuredClone(inputs.docx), operation = reserveHostOfficeLocalMcpOperation({ broker: f.broker, tracker: f.tracker,
    store: f.store, workspaceCwd: f.cwd, toolCallId: "reentrant-original", toolName: creates.docx, input, approval: "ask" });
  bindHostOfficeLocalMcpAuthority(operation, captureMcpResultAuthority(f.store, f.server.id, creates.docx).authority);
  const options = { secretResolver: f.secretResolver, workspaceCwd: f.cwd, runId: f.run.id,
    toolCallId: "reentrant-original", officeLocalOperation: operation };
  const original = Packer.toBuffer; let serializations = 0;
  t.mock.method(Packer, "toBuffer", async (...args) => { serializations++; await Promise.resolve(); return original(...args); });
  try {
    const first = f.broker.callTool(f.server, options, creates.docx, input);
    await assert.rejects(f.broker.callTool(f.server, options, creates.docx, input), error => error.code === "mcp_host_admission_unsupported");
    const result = await first; assert.equal(result.details.path, join(f.cwd, "result.docx"));
  } finally { finishHostOfficeLocalMcpOperation(operation); }
  assert.equal(serializations, 1); assertBinaryPair(f, true);
});
