import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NotificationHub } from "../dist/features/notifications/hub.js";

test("hub records journal entries and honors tone preferences", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ling-notifications-"));
  try {
    const hub = new NotificationHub({
      journalPath: join(dir, "notifications", "journal.json"),
      preferencesPath: join(dir, "notifications", "preferences.json"),
    });
    // Defaults: successes are journaled but not delivered.
    const finished = await hub.emit({
      kind: "automation_run_finished",
      title: "Automation run finished",
      body: "Daily brief completed.",
      automationId: "automation_1",
      cwd: "/tmp/w",
    });
    assert.equal(finished?.deliver, false);
    const failed = await hub.emit({ kind: "automation_run_failed", title: "Automation run failed", body: "boom" });
    assert.equal(failed?.deliver, true);

    const window = hub.list();
    assert.equal(window.notifications.length, 2);
    assert.equal(window.nextSince, failed?.record.id);

    const incremental = hub.list(finished?.record.id);
    assert.equal(incremental.notifications.length, 1);

    const journal = JSON.parse(await readFile(join(dir, "notifications", "journal.json"), "utf8"));
    assert.equal(journal.records.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("hub persists preferences and applies quiet hours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ling-notifications-prefs-"));
  try {
    const hub = new NotificationHub({
      journalPath: join(dir, "journal.json"),
      preferencesPath: join(dir, "preferences.json"),
    });
    await hub.updatePreferences({
      globalEnabled: true,
      events: { automation_run_failed: "all" },
      quietHours: { start: "22:00", end: "08:00" },
    });
    const persisted = JSON.parse(await readFile(join(dir, "preferences.json"), "utf8"));
    assert.equal(persisted.preferences.quietHours.start, "22:00");

    // Reload from disk: quiet hours survive restart.
    const reloaded = new NotificationHub({
      journalPath: join(dir, "journal.json"),
      preferencesPath: join(dir, "preferences.json"),
    });
    await reloaded.ensureLoaded();
    const delivery = await reloaded.emit({
      kind: "automation_run_failed",
      title: "t",
      body: "b",
      at: new Date("2026-10-26T23:30:00"),
    });
    assert.equal(delivery?.deliver, false, "quiet hours suppress delivery but the record is journaled");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("hub degrades to in-memory operation when paths are unusable", async () => {
  const hub = new NotificationHub({ journalPath: null, preferencesPath: null });
  await hub.emit({ kind: "approval_required", title: "t", body: "b" });
  assert.equal(hub.size(), 1);
  const globalOff = await hub.updatePreferences({ globalEnabled: false });
  assert.equal(globalOff.globalEnabled, false);
  const delivery = await hub.emit({ kind: "approval_required", title: "t", body: "b" });
  assert.equal(delivery?.deliver, false);
});

test("hub sanitizes malformed persisted preferences", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ling-notifications-bad-"));
  try {
    await writeFile(join(dir, "preferences.json"), JSON.stringify({
      schemaVersion: 1,
      preferences: { globalEnabled: "yes", events: { automation_run_failed: "sometimes" }, quietHours: { start: "99:99", end: "x" } },
    }), "utf8");
    const hub = new NotificationHub({ preferencesPath: join(dir, "preferences.json") });
    await hub.ensureLoaded();
    assert.equal(hub.getPreferences().globalEnabled, true);
    assert.equal(hub.getPreferences().events.automation_run_failed, "all");
    assert.equal(hub.getPreferences().quietHours, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
