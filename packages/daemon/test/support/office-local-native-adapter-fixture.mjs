import assert from "node:assert/strict";
import { OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";
import { captureMcpResultAuthority } from "../../dist/features/mcp/result-authority.js";
import { officeDocumentTools } from "../../dist/features/plugins/office-documents-generation-broker.js";
import { prepareOfficeArtifact } from "../../dist/features/office-documents/office-artifact-preparation.js";
import { reserveOfficeLocalWriter, bindOfficeLocalMcpForwardAuthority, captureOfficeLocalReservationSnapshot,
  bootstrapOfficeLocalDirectoryScope, prepareOfficeLocalDirectoryWrite, officeLocalDirectoryWriteState }
  from "../../dist/features/office-documents/office-local-authority.js";
import { createNativeBootstrapFixture } from "./office-local-native-bootstrap-fixture.mjs";

/**
 * Genuine reviewed-addon + Supervisor + original MCP factory + original pair.
 * ONLY the existing test fixture's actor-inventory assertion is bypassed; this
 * is an adapter conformance fixture, NOT controlled kernel/fullscope evidence.
 * Does not build an addon, call HTTP, start an App or use a real workspace DB.
 */
export async function createNativeDirectoryAdapterFixture(t, { format = "docx", path = `nested/one/result.${format}` } = {}) {
  const f = createNativeBootstrapFixture(t), now = () => new Date().toISOString(), rawName = {
    docx: "office_create_document", xlsx: "office_create_workbook", pptx: "office_create_presentation" }[format];
  assert.ok(rawName, "only fixed local create tools are valid test requests");
  f.input.rawName = rawName;
  const server = f.store.createMcpServer({ id: OFFICE_DOCUMENTS_MCP_SERVER_ID, displayName: "Original local Office",
    enabled: true, required: false, transport: { type: "streamable-http", url: "http://127.0.0.1:1/never-used", headers: {}, secretHeaderRefs: {} } }, now());
  f.store.replaceMcpServerTools(server.id, officeDocumentTools, now());
  const controller = new AbortController(), source = { runId: f.input.run.id, ...f.input.sourceFence },
    tracker = new AttemptHostOperationTracker({ store: f.store, source }),
    reservation = reserveOfficeLocalWriter(tracker, f.store, f.input.toolCallId, f.cwd),
    { authority } = captureMcpResultAuthority(f.store, server.id, rawName);
  bindOfficeLocalMcpForwardAuthority(reservation, { authority, originalBroker: f.input.originalBroker, factory: f.input.factory,
    signal: controller.signal });
  const input = format === "xlsx" ? { path, sheets: [{ name: "Summary", rows: [["Native adapter", 42]] }] }
    : format === "pptx" ? { path, slides: [{ title: "Native adapter", bullets: ["Original local OOXML"] }] }
    : { path, blocks: [{ type: "paragraph", text: "Original local OOXML adapter" }] };
  const snapshot = captureOfficeLocalReservationSnapshot(reservation, path, format), artifact = await prepareOfficeArtifact(rawName, input, undefined, controller.signal);
  bootstrapOfficeLocalDirectoryScope(reservation, f.runtime);
  const plan = prepareOfficeLocalDirectoryWrite(reservation, snapshot, artifact, "a".repeat(64), "b".repeat(64)), state = officeLocalDirectoryWriteState(plan);
  return { ...f, tracker, reservation, plan, state, artifact, controller, source,
    effects: () => f.store.listHostOfficeLocalDirectoryEffectsV2(plan.executionId),
    terminal: () => f.store.getHostOfficeLocalDirectoryTerminalV2(plan.executionId),
    observations: () => f.store.listHostOfficeLocalDirectoryEffectsV2(plan.executionId).map(effect => ({ effect,
      observation: effect.observationArtifactId ? f.store.getArtifact(effect.observationArtifactId).sealedPayload : null })),
    pairRows: () => [state.execution.parentOperationId, state.execution.producerOperationId].map(id => f.store.getHostOperation(id)) };
}

/** Inject only around the genuine original synchronous tracker callback. No fake native runtime or production callback API. */
export function observeNativeAdapterEntries(t, f, { before, after } = {}) {
  const original = f.tracker.launchOfficeLocalDirectoryEffectV2.bind(f.tracker), entries = [];
  t.mock.method(f.tracker, "launchOfficeLocalDirectoryEffectV2", (ticket, effectId, callback, mode) => {
    const descriptor = f.effects().find(item => item.effectId === effectId);
    return original(ticket, effectId, () => {
      entries.push({ effectId, kind: descriptor.kind, mode });
      before?.(descriptor);
      const packet = callback();
      after?.(descriptor, packet);
      return packet;
    }, mode);
  });
  return entries;
}

/** Real COMMIT may complete before its return is lost; injection restores the DB method immediately. */
export function injectOneCommitFailure(database, invoke, { commitFirst = true, shouldFail = () => true } = {}) {
  const original = database.exec.bind(database); let injected = false;
  database.exec = sql => {
    if (sql === "COMMIT" && !injected && shouldFail()) {
      injected = true;
      if (commitFirst) original(sql);
      throw new Error(commitFirst ? "fixture_commit_ack_unknown" : "fixture_commit_refused");
    }
    return original(sql);
  };
  try { return invoke(); }
  finally { database.exec = original; assert.equal(injected, true, "the actual transaction COMMIT must be reached"); }
}
