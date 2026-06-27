import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";
import { SqliteChannelTeamLifecycleStore } from "../dist/storage/sqlite/channel-team-lifecycle-store.js";

test("sqlite channel team lifecycle migration creates a separate incident table", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-lifecycle-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_team_incidents'").get());
      assert.ok(
        database
          .prepare("SELECT version FROM schema_migrations WHERE version = 82 AND name = 'create_channel_team_incidents'")
          .get(),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel team lifecycle incidents keep reliability and availability separate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-lifecycle-"));
  const now = "2026-06-26T00:00:00.000Z";
  createSqliteRunStore(cwd).close();
  const paths = resolveRuntimePaths(cwd);
  const database = new DatabaseSync(paths.databasePath);
  try {
    const store = new SqliteChannelTeamLifecycleStore({ database });
    const reliability = store.createReliabilityIncident(
      {
        id: "incident_quality_security",
        agentId: "teammate_builtin_security",
        capabilityScope: "security",
        kind: "unsafe_suggestion",
        severity: "high",
        summary: "Suggested a risky permission expansion.",
        recoveryRequired: true,
        sourceRefs: [{ type: "approval", id: "approval_demo" }],
        expiresAt: "2026-07-26T00:00:00.000Z",
      },
      now,
    );
    const availability = store.createAvailabilityIncident(
      {
        id: "incident_provider_quota",
        agentId: "teammate_builtin_security",
        providerPresetId: "provider_demo",
        state: "rate_limited",
        kind: "quota",
        severity: "medium",
        summary: "Provider quota was exhausted.",
        observedAt: "2026-06-26T00:01:00.000Z",
        expiresAt: "2026-06-25T00:00:00.000Z",
      },
      "2026-06-26T00:01:00.000Z",
    );

    assert.equal(reliability.recoveryRequired, true);
    assert.equal(availability.state, "rate_limited");
    assert.deepEqual(
      store.listReliabilityIncidents({
        agentId: "teammate_builtin_security",
        capabilityScope: "security",
        now: "2026-06-26T00:02:00.000Z",
      }).map((incident) => incident.id),
      ["incident_quality_security"],
    );
    assert.deepEqual(
      store.listAvailabilityIncidents({
        agentId: "teammate_builtin_security",
        now: "2026-06-26T00:02:00.000Z",
      }).map((incident) => incident.id),
      [],
    );
    assert.deepEqual(
      store.listAvailabilityIncidents({
        agentId: "teammate_builtin_security",
        includeExpired: true,
      }).map((incident) => incident.id),
      ["incident_provider_quota"],
    );
  } finally {
    database.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite run store exposes channel team incident create and list methods", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-run-store-lifecycle-"));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      const reliability = store.createReliabilityIncident(
        {
          id: "incident_run_store_reliability",
          agentId: "teammate_builtin_qa",
          capabilityScope: "testing",
          kind: "low_quality",
          severity: "medium",
          summary: "Regression review missed a failing case.",
          sourceRefs: [{ type: "message", id: "message_quality_1" }],
          expiresAt: "2026-07-26T00:00:00.000Z",
        },
        "2026-06-26T00:03:00.000Z",
      );
      const availability = store.createAvailabilityIncident(
        {
          id: "incident_run_store_availability",
          agentId: "teammate_builtin_qa",
          providerPresetId: "provider_test",
          state: "overloaded",
          kind: "overload",
          severity: "medium",
          summary: "Provider returned overload while scheduling observer.",
          observedAt: "2026-06-26T00:04:00.000Z",
          expiresAt: "2026-06-26T00:20:00.000Z",
        },
        "2026-06-26T00:04:00.000Z",
      );

      assert.equal(reliability.id, "incident_run_store_reliability");
      assert.equal(availability.id, "incident_run_store_availability");
      assert.deepEqual(
        store.listReliabilityIncidents({ agentId: "teammate_builtin_qa", capabilityScope: "testing" }).map((incident) => incident.id),
        ["incident_run_store_reliability"],
      );
      assert.deepEqual(
        store.listAvailabilityIncidents({
          agentId: "teammate_builtin_qa",
          providerPresetId: "provider_test",
          now: "2026-06-26T00:05:00.000Z",
        }).map((incident) => incident.id),
        ["incident_run_store_availability"],
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
