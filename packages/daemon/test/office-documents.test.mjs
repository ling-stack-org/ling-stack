import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  OFFICE_DOCUMENTS_MCP_SERVER_ID,
  OFFICE_DRIVER_PROTOCOL,
} from "@ling-stack/contracts";
import { OfficeArtifactService } from "../dist/features/office-documents/artifacts.js";
import {
  OfficeDriverController,
  createOfficeDriverSuccess,
} from "../dist/features/office-documents/driver-controller.js";
import {
  createOfficeDocumentsGenerationBroker,
  officeToolsForCapabilities,
} from "../dist/features/plugins/office-documents-generation-broker.js";

const availability = {
  protocol: OFFICE_DRIVER_PROTOCOL,
  generation: 1,
  desktopInstanceId: "desktop-office-test",
  platform: "darwin",
  helperVersion: "0.1.0-test",
  state: "ready",
  capabilities: ["excel:sessions", "excel:read", "excel:write"],
  officeInstalled: true,
  applicationRunning: true,
  permissionGranted: true,
  checkedAt: "2026-08-22T00:00:00.000Z",
};

test("Office driver controller coalesces concurrent duplicate idempotency keys", async () => {
  const controller = new OfficeDriverController({ commandTimeoutMs: 1_000 });
  controller.publishAvailability(availability);

  const first = controller.execute({ method: "write_range", params: { value: 1 }, idempotencyKey: "same-write" });
  const duplicate = controller.execute({ method: "write_range", params: { value: 1 }, idempotencyKey: "same-write" });
  const command = await controller.claim({ desktopInstanceId: availability.desktopInstanceId, generation: 1 });
  assert.ok(command);
  assert.equal(command.idempotencyKey, "same-write");
  controller.complete(
    { desktopInstanceId: availability.desktopInstanceId, generation: 1 },
    createOfficeDriverSuccess(command.id, { written: 1 }),
  );

  assert.deepEqual(await first, { written: 1 });
  assert.deepEqual(await duplicate, { written: 1 });

  const abort = new AbortController();
  const emptyClaim = controller.claim(
    { desktopInstanceId: availability.desktopInstanceId, generation: 1 },
    abort.signal,
  );
  abort.abort();
  await assert.rejects(emptyClaim, /abort/iu);
  controller.close();
});

test("Office driver controller fences stale authorities", async () => {
  const controller = new OfficeDriverController({ commandTimeoutMs: 1_000 });
  controller.publishAvailability(availability);
  const pending = controller.execute({ method: "read_ranges", params: {}, idempotencyKey: "stale-read" });
  controller.publishAvailability({ ...availability, generation: 2, checkedAt: "2026-08-22T00:00:01.000Z" });
  await assert.rejects(pending, /office_driver_authority_replaced/u);
  await assert.rejects(
    controller.claim({ desktopInstanceId: availability.desktopInstanceId, generation: 1 }),
    /office_driver_authority_invalid/u,
  );
  controller.close();
});

test("Office driver controller cancels, times out, and rejects late or oversized results", async () => {
  const controller = new OfficeDriverController({ commandTimeoutMs: 25 });
  controller.publishAvailability(availability);

  const abort = new AbortController();
  const cancelled = controller.execute({
    method: "read_ranges",
    params: {},
    idempotencyKey: "cancelled-read",
    signal: abort.signal,
  });
  const claimed = await controller.claim({ desktopInstanceId: availability.desktopInstanceId, generation: 1 });
  assert.ok(claimed);
  abort.abort();
  await assert.rejects(cancelled, /office_driver_cancelled/u);
  assert.throws(
    () => controller.complete(
      { desktopInstanceId: availability.desktopInstanceId, generation: 1 },
      createOfficeDriverSuccess(claimed.id, { ignored: true }),
    ),
    /office_driver_command_not_found/u,
  );

  const timedOut = controller.execute({ method: "read_ranges", params: {}, idempotencyKey: "timeout-read" });
  await assert.rejects(timedOut, /office_driver_timeout/u);

  const oversized = controller.execute({ method: "read_ranges", params: {}, idempotencyKey: "oversized-read" });
  const oversizedCommand = await controller.claim({ desktopInstanceId: availability.desktopInstanceId, generation: 1 });
  assert.ok(oversizedCommand);
  assert.throws(
    () => controller.complete(
      { desktopInstanceId: availability.desktopInstanceId, generation: 1 },
      createOfficeDriverSuccess(oversizedCommand.id, { text: "x".repeat(8 * 1024 * 1024) }),
    ),
    /office_driver_result_too_large/u,
  );
  controller.close();
  await assert.rejects(oversized, /office_driver_closed/u);
});

test("Office live broker preserves formula-only writes and publishes only current results", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-office-live-"));
  const controller = new OfficeDriverController({ commandTimeoutMs: 1_000 });
  controller.publishAvailability(availability);
  const broker = officeBroker(workspace, controller);
  const abort = new AbortController();
  let resultFenceCalls = 0;
  try {
    const calling = broker.callTool(
      officeServer(),
      {
        ...brokerOptions(workspace),
        signal: abort.signal,
        runId: "run-formula",
        toolCallId: "tool-formula",
        assertResultCurrent: () => { resultFenceCalls += 1; },
      },
      "office_write_range",
      { sessionId: "session-1", range: "Sheet1!A1:B1", formulas: [["=1+1", "=2+2"]] },
    );
    const command = await controller.claim(officeAuthority());
    assert.ok(command);
    assert.equal(command.method, "write_range");
    assert.deepEqual(command.params, {
      sessionId: "session-1",
      range: "Sheet1!A1:B1",
      formulas: [["=1+1", "=2+2"]],
    });
    controller.complete(officeAuthority(), createOfficeDriverSuccess(command.id, { written: 2 }));

    const result = await calling;
    assert.deepEqual(result.details, { written: 2 });
    assert.equal(resultFenceCalls, 1);
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Office live broker fences save-as paths to the workspace", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-office-save-as-"));
  const controller = new OfficeDriverController({ commandTimeoutMs: 1_000 });
  controller.publishAvailability({ ...availability, capabilities: ["excel:save-as"] });
  const broker = officeBroker(workspace, controller);
  try {
    await assert.rejects(
      broker.callTool(
        officeServer(),
        brokerOptions(workspace),
        "office_save_workbook_as",
        { sessionId: "session-1", path: resolve(workspace, "..", "outside.xlsx") },
      ),
      /office_path_outside_workspace/u,
    );

    const calling = broker.callTool(
      officeServer(),
      brokerOptions(workspace),
      "office_save_workbook_as",
      { sessionId: "session-1", path: "exports/report.xlsx" },
    );
    const command = await controller.claim(officeAuthority());
    assert.ok(command);
    assert.equal(command.method, "save_workbook_as");
    assert.equal(command.params.sessionId, "session-1");
    assert.match(command.params.path, /exports\/report\.xlsx$/u);
    controller.complete(officeAuthority(), createOfficeDriverSuccess(command.id, { saved: true }));
    assert.deepEqual((await calling).details, { saved: true });
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Office live stack gates tools by both capability and current runtime state", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-office-capabilities-"));
  const controller = new OfficeDriverController({ commandTimeoutMs: 25 });
  controller.publishAvailability({ ...availability, capabilities: ["excel:write"] });
  const broker = officeBroker(workspace, controller);
  try {
    const listed = await broker.listTools(officeServer(), brokerOptions(workspace));
    const names = listed.tools.map((tool) => tool.rawName);
    assert.equal(names.includes("office_write_range"), true);
    assert.equal(names.includes("office_read_ranges"), false);
    assert.equal(names.includes("office_create_chart"), false);
    await assert.rejects(
      broker.callTool(officeServer(), brokerOptions(workspace), "office_read_ranges", {
        sessionId: "session-1",
        ranges: ["Sheet1!A1"],
      }),
      /office_live_capability_unavailable/u,
    );

    controller.publishAvailability({
      ...availability,
      generation: 2,
      state: "application_not_running",
      capabilities: ["excel:write"],
      applicationRunning: false,
      checkedAt: "2026-08-22T00:00:01.000Z",
    });
    await assert.rejects(
      broker.callTool(officeServer(), brokerOptions(workspace), "office_write_range", {
        sessionId: "session-1",
        range: "Sheet1!A1",
        values: [[1]],
      }),
      /office_driver_application_not_running/u,
    );
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Office live format schema projects only capabilities implemented by each platform", () => {
  const macFormat = officeToolsForCapabilities(["excel:format-basic"], "darwin")
    .find((tool) => tool.rawName === "office_format_range");
  const windowsFormat = officeToolsForCapabilities(["excel:format-basic"], "win32")
    .find((tool) => tool.rawName === "office_format_range");
  assert.ok(macFormat);
  assert.ok(windowsFormat);

  const macProperties = macFormat.inputSchema.properties.format.properties;
  const windowsProperties = windowsFormat.inputSchema.properties.format.properties;
  assert.deepEqual(Object.keys(macProperties).sort(), ["bold", "italic", "numberFormat"]);
  assert.equal(Object.hasOwn(windowsProperties, "fillColor"), true);
  assert.equal(Object.hasOwn(windowsProperties, "fontColor"), true);
});

test("Office live broker discards a completed result when the caller cancels before publication", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-office-cancel-"));
  const controller = new OfficeDriverController({ commandTimeoutMs: 1_000 });
  controller.publishAvailability(availability);
  const broker = officeBroker(workspace, controller);
  const abort = new AbortController();
  const abortReason = new Error("office caller cancelled before publication");
  let resultFenceCalls = 0;
  try {
    const calling = broker.callTool(
      officeServer(),
      {
        ...brokerOptions(workspace),
        signal: abort.signal,
        assertResultCurrent: () => { resultFenceCalls += 1; },
      },
      "office_write_range",
      { sessionId: "session-1", range: "Sheet1!A1", values: [[1]] },
    );
    const command = await controller.claim(officeAuthority());
    assert.ok(command);
    controller.complete(officeAuthority(), createOfficeDriverSuccess(command.id, { written: 1 }));
    abort.abort(abortReason);

    await assert.rejects(calling, (error) => error === abortReason);
    assert.equal(resultFenceCalls, 0);
  } finally {
    controller.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Office artifacts create and re-open standards-based XLSX, DOCX, and PPTX files", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-office-artifacts-"));
  const service = new OfficeArtifactService();
  try {
    const workbookPath = resolve(workspace, "report.xlsx");
    const documentPath = resolve(workspace, "brief.docx");
    const presentationPath = resolve(workspace, "deck.pptx");

    await service.createWorkbook(workspace, {
      path: workbookPath,
      sheets: [{
        name: "Summary",
        rows: [["Metric", "Value"], ["Users", 42]],
        columnWidths: [18, 12],
        freezeHeader: true,
        headerStyle: true,
      }],
    });
    await service.createDocument(workspace, {
      path: documentPath,
      blocks: [
        { type: "paragraph", text: "Ling Office document", heading: 1 },
        { type: "paragraph", text: "<script>local only</script>" },
      ],
    });
    await service.createPresentation(workspace, {
      path: presentationPath,
      title: "Ling Office presentation",
      slides: [{ title: "Overview", bullets: ["Local", "Native"] }],
    });

    for (const [path, format, expectedText] of [
      [workbookPath, "xlsx", "Users"],
      [documentPath, "docx", "Ling Office document"],
      [presentationPath, "pptx", "Overview"],
    ]) {
      const file = await stat(path);
      assert.equal(file.isFile(), true);
      assert.equal(file.size > 0, true);
      const inspected = await service.inspect(workspace, { path });
      assert.equal(inspected.format, format);
      assert.match(inspected.text, new RegExp(expectedText, "u"));
      assert.equal((await service.validate(workspace, { path })).valid, true);
    }

    const createdWorkbookPackage = await JSZip.loadAsync(await readFile(workbookPath));
    const createdWorksheetXml = await createdWorkbookPackage.file("xl/worksheets/sheet1.xml")?.async("string");
    assert.equal(typeof createdWorksheetXml, "string");
    assert.match(createdWorksheetXml, /<pane\b[^>]*\bySplit="1"/u);
    assert.match(createdWorksheetXml, /<pane\b[^>]*\bstate="frozen"/u);
    assert.match(createdWorksheetXml, /<col\b[^>]*\bwidth="18"/u);
    assert.match(createdWorksheetXml, /<c\b[^>]*\br="A1"[^>]*\bs="[1-9][0-9]*"/u);

    await service.editWorkbook(workspace, {
      path: workbookPath,
      edits: [{ sheet: "Summary", cell: "B2", value: 43, bold: true }],
    });
    const edited = await service.inspect(workspace, { path: workbookPath });
    assert.match(edited.text, /43/u);
    assert.equal(typeof (await service.editWorkbook(workspace, {
      path: workbookPath,
      edits: [{ sheet: "Summary", cell: "B2", formula: "40+4" }],
    })).recoveryPath, "string");
    const formulaWorkbookPackage = await JSZip.loadAsync(await readFile(workbookPath));
    const formulaWorksheetXml = await formulaWorkbookPackage.file("xl/worksheets/sheet1.xml")?.async("string");
    assert.match(formulaWorksheetXml, /<f>40\+4<\/f>/u);

    const documentPackage = await JSZip.loadAsync(await readFile(documentPath));
    documentPackage.file("customXml/ling-preservation.txt", "preserve-me");
    await writeFile(documentPath, await documentPackage.generateAsync({ type: "nodebuffer" }));
    const editedDocument = await service.editDocument(workspace, {
      path: documentPath,
      replacements: [{ search: "Ling Office", replace: "Native Office" }],
      appendParagraphs: ["Added without rebuilding the package"],
    });
    assert.equal(typeof editedDocument.recoveryPath, "string");
    assert.match((await service.inspect(workspace, { path: documentPath })).text, /Native Office document/u);
    assert.match((await service.inspect(workspace, { path: documentPath })).text, /Added without rebuilding/u);
    const preservedDocument = await JSZip.loadAsync(await readFile(documentPath));
    assert.equal(await preservedDocument.file("customXml/ling-preservation.txt")?.async("string"), "preserve-me");

    const editedPresentation = await service.editPresentation(workspace, {
      path: presentationPath,
      replacements: [{ slide: 1, search: "Overview", replace: "Roadmap" }],
    });
    assert.deepEqual(editedPresentation.changedSlides, [1]);
    assert.match((await service.inspect(workspace, { path: presentationPath })).text, /Roadmap/u);

    const rendered = await service.renderDocument(workspace, { path: documentPath });
    assert.equal(rendered.mimeType, "text/html");
    assert.equal(rendered.html.includes("<script>"), false);
    assert.match(rendered.html, /&lt;script&gt;local only&lt;\/script&gt;/u);

    const macroPath = resolve(workspace, "macro.docx");
    const macroPackage = await JSZip.loadAsync(await readFile(documentPath));
    macroPackage.file("word/vbaProject.bin", Buffer.from([0, 1, 2, 3]));
    await writeFile(macroPath, await macroPackage.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(service.validate(workspace, { path: macroPath }), /office_document_executable_unsupported/u);
    await assert.rejects(service.editDocument(workspace, {
      path: macroPath,
      replacements: [{ search: "Native", replace: "Blocked" }],
    }), /office_document_executable_unsupported/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Office artifact writes reject path escape and preserve an existing target without overwrite", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "ling-office-boundary-"));
  const outside = resolve(workspace, "..", `ling-office-outside-${Date.now()}.docx`);
  const service = new OfficeArtifactService();
  try {
    await assert.rejects(
      service.createDocument(workspace, {
        path: outside,
        blocks: [{ type: "paragraph", text: "outside" }],
      }),
      /office_path_outside_workspace/u,
    );

    const existing = resolve(workspace, "existing.docx");
    await writeFile(existing, "do-not-replace", "utf8");
    await assert.rejects(
      service.createDocument(workspace, {
        path: existing,
        blocks: [{ type: "paragraph", text: "replacement" }],
      }),
      /office_target_exists/u,
    );
    assert.equal((await readFile(existing, "utf8")), "do-not-replace");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

function officeBroker(workspace, controller) {
  return createOfficeDocumentsGenerationBroker({
    baseBroker: {
      async checkServer() { throw new Error("unexpected base broker check"); },
      async listTools() { throw new Error("unexpected base broker list"); },
      async callTool() { throw new Error("unexpected base broker call"); },
    },
    workspaceCwd: workspace,
    controller,
  });
}

function brokerOptions(workspace) {
  return {
    secretResolver: { resolve: () => ({ configured: false }) },
    workspaceCwd: workspace,
    now: () => "2026-08-22T00:00:00.000Z",
  };
}

function officeServer() {
  return {
    id: OFFICE_DOCUMENTS_MCP_SERVER_ID,
    workspaceId: "office-test-workspace",
    displayName: "Office Documents",
    transport: {
      type: "streamable-http",
      url: "http://127.0.0.1:1/ling-internal/office-documents",
      headers: {},
      secretHeaderRefs: {},
    },
    enabled: true,
    required: false,
    status: { kind: "unknown" },
    startupTimeoutSec: 30,
    toolTimeoutSec: 60,
    disabledTools: [],
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function officeAuthority() {
  return { desktopInstanceId: availability.desktopInstanceId, generation: availability.generation };
}
