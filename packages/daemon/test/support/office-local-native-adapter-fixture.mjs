import assert from "node:assert/strict";
import { createOriginalOfficeDirectoryCompositionFixture } from "./office-original-directory-composition-fixture.mjs";

/**
 * Genuine reviewed-addon, default source inventory, original Store and fixed
 * MCP factory. No actor-inventory bypass or unbound positive fallback.
 * This is an adapter conformance fixture, NOT controlled kernel/fullscope evidence.
 * Does not build an addon, call HTTP, start an App or use a real workspace DB.
 */
export async function createNativeDirectoryAdapterFixture(t, { format = "docx", path = `nested/one/result.${format}` } = {}) {
  const f = await createOriginalOfficeDirectoryCompositionFixture(t, { format, path });
  return { ...f,
    observations: () => f.store.listHostOfficeLocalDirectoryEffectsV2(f.plan.executionId).map(effect => ({ effect,
      observation: effect.observationArtifactId ? f.store.getArtifact(effect.observationArtifactId).sealedPayload : null })),
  };
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
