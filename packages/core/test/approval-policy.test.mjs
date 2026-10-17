import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "./channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  authorizationAndAccessFromLegacyPermission,
  approvalSideEffectFingerprintV1,
  createApprovalResumeBasisV1,
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
  inferPermissionPreset,
  legacyPermissionFromAuthorizationAndAccess,
  permissionModeForPreset,
  permissionPresetRequiresConfirmation,
  resolveSessionRunPolicy,
  workspaceAccessModeRequiresConfirmation,
} from "../dist/index.js";

test("sqlite store creates the default approval policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-policy-"));
  const store = createSqliteRunStore(cwd);
  try {
    const policy = store.getApprovalPolicy();

    assert.equal(policy.workspaceId, "workspace_default");
    assert.deepEqual(policy.toolDecisions, defaultApprovalToolDecisions);
    assert.deepEqual(policy.allowedWritePaths, defaultAllowedWritePaths);
    assert.equal(policy.createdAt, policy.updatedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval decision and per-owner post-commit work survive reopening the store", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-approval-postcommit-"));
  const now = "2026-09-25T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_postcommit",
      cwd,
      taskId: "task_postcommit",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_postcommit", title: "Post-commit recovery" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const approval = store.createApprovalRequest({
      runId: "run_postcommit",
      taskId: "task_postcommit",
      actionType: "bash",
      risk: "medium",
      title: "Approve shell command",
      description: "echo once",
      payload: { type: "bash", cwd, command: "echo once", riskFlags: [] },
    }, now);
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, "2026-09-25T01:01:00.000Z");
    store.close();
    store = createSqliteRunStore(cwd);
    assert.equal(store.getApprovalRequest(approval.id)?.status, "approved");
    assert.deepEqual(store.listApprovalPostCommitEffects({ approvalId: approval.id }).map(({ effectKind, status }) => [effectKind, status]), [
      ["decision_event", "pending"],
      ["owner", "pending"],
      ["control_plane_event", "pending"],
    ]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("post-commit ledger repairs a colliding legacy migration version", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-approval-postcommit-collision-"));
  let store = createSqliteRunStore(cwd);
  try {
    const databasePath = store.paths.databasePath;
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("DROP TABLE approval_postcommit_effects;");
      database.exec("DELETE FROM schema_migrations WHERE version = 144;");
      database.exec(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (139, 'create_delegation_tree', '2026-09-25T00:00:00.000Z');
      `);
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.ok(repaired.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'approval_postcommit_effects'
      `).get());
      assert.equal(repaired.prepare("SELECT name FROM schema_migrations WHERE version = 144").get()?.name,
        "create_approval_postcommit_effects");
    } finally {
      repaired.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("post-commit ledger failure rolls back the approval decision and retry creates one effect per kind", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-approval-ledger-rollback-"));
  const now = "2026-09-25T02:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({ id: "run_ledger_fault", cwd, taskId: "task_ledger_fault", providerName: "test-provider",
      providerModel: "test-model", taskSnapshot: { id: "task_ledger_fault", title: "Fault" },
      providerSnapshot: { provider: "test-provider", model: "test-model" }, requestSnapshot: { cwd }, createdAt: now });
    const approval = store.createApprovalRequest({ runId: "run_ledger_fault", taskId: "task_ledger_fault",
      actionType: "bash", risk: "medium", title: "Approve", description: "echo",
      payload: { type: "bash", cwd, command: "echo", riskFlags: [] } }, now);
    const database = new DatabaseSync(store.paths.databasePath);
    try {
      database.exec(`CREATE TRIGGER fail_approval_postcommit BEFORE INSERT ON approval_postcommit_effects
        BEGIN SELECT RAISE(ABORT, 'injected postcommit ledger failure'); END`);
      assert.throws(() => store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now), /injected postcommit ledger failure/);
      assert.equal(store.getApprovalRequest(approval.id)?.status, "pending");
      assert.deepEqual(store.listApprovalPostCommitEffects({ approvalId: approval.id }), []);
      database.exec("DROP TRIGGER fail_approval_postcommit");
    } finally {
      database.close();
    }
    store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    const effects = store.listApprovalPostCommitEffects({ approvalId: approval.id });
    assert.equal(effects.length, 3);
    const first = store.claimApprovalPostCommitEffect(approval.id, "owner", {
      token: "owner-claim-1", claimExpiresAt: "2026-09-25T02:01:00.000Z",
    }, now);
    assert.equal(first?.status, "claimed");
    assert.equal(store.claimApprovalPostCommitEffect(approval.id, "owner", {
      token: "owner-claim-2", claimExpiresAt: "2026-09-25T02:01:00.000Z",
    }, now), undefined);
    assert.equal(store.settleApprovalPostCommitEffect(approval.id, "owner", {
      token: "owner-claim-2", status: "completed",
    }, now), undefined);
    assert.equal(store.settleApprovalPostCommitEffect(approval.id, "owner", {
      token: "owner-claim-1", status: "completed",
    }, now)?.status, "completed");
    const eventClaim = store.claimApprovalPostCommitEffect(approval.id, "decision_event", {
      token: "event-claim", claimExpiresAt: "2026-09-25T02:01:00.000Z",
    }, now);
    assert.ok(eventClaim);
    assert.equal(store.recoverExpiredApprovalPostCommitClaim(approval.id, "decision_event", {
      expectedRevision: eventClaim.revision,
      status: "pending",
      errorCode: "event_evidence_missing",
    }, "2026-09-25T02:01:00.000Z"), undefined, "the lease is still held at its deadline");
    assert.equal(store.recoverExpiredApprovalPostCommitClaim(approval.id, "decision_event", {
      expectedRevision: eventClaim.revision,
      status: "pending",
      errorCode: "event_evidence_missing",
    }, "2026-09-25T02:01:01.000Z")?.status, "pending");
    assert.equal(store.recoverExpiredApprovalPostCommitClaim(approval.id, "decision_event", {
      expectedRevision: eventClaim.revision,
      status: "pending",
      errorCode: "event_evidence_missing",
    }, "2026-09-25T02:01:02.000Z"), undefined, "a stale revision cannot overwrite recovery");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("post-commit recovery scans past 500 effects with equal timestamps", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-approval-effects-page-"));
  const now = "2026-09-25T04:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({ id: "run_effect_page", cwd, taskId: "task_effect_page", providerName: "test-provider",
      providerModel: "test-model", taskSnapshot: { id: "task_effect_page", title: "Effects page" },
      providerSnapshot: { provider: "test-provider", model: "test-model" }, requestSnapshot: { cwd }, createdAt: now });
    for (let index = 0; index < 167; index += 1) {
      const approval = store.createApprovalRequest({ runId: "run_effect_page", taskId: "task_effect_page",
        actionType: "bash", risk: "medium", title: `Approval ${index}`, description: "echo",
        payload: { type: "bash", cwd, command: "echo", riskFlags: [] } }, now);
      store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, now);
    }
    const first = store.listApprovalPostCommitEffects({ status: "pending", limit: 500 });
    assert.equal(first.length, 500);
    const last = first.at(-1);
    const second = store.listApprovalPostCommitEffects({ status: "pending", limit: 500,
      after: { createdAt: last.createdAt, approvalId: last.approvalId, effectKind: last.effectKind } });
    assert.equal(second.length, 1);
    assert.equal(new Set([...first, ...second].map((effect) => `${effect.approvalId}:${effect.effectKind}`)).size, 501);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite approval requests persist command-rule proposals without saving a rule for allow once", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-command-rule-once-"));
  const now = "2026-08-28T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_command_rule_once",
      cwd,
      taskId: "task_command_rule_once",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_command_rule_once", title: "Command rule once" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const proposedCommandRule = {
      prefix: ["whois"],
      display: "whois",
      fingerprint: "command_rule_v1_whois",
      version: 1,
    };
    const approval = store.createApprovalRequest({
      runId: "run_command_rule_once",
      taskId: "task_command_rule_once",
      actionType: "bash",
      risk: "medium",
      title: "Approve shell command",
      description: "whois example.com",
      payload: { type: "bash", cwd, command: "whois example.com", riskFlags: [] },
      availableDecisions: ["approve_once", "approve_command_rule", "deny"],
      proposedCommandRule,
    }, now);

    assert.deepEqual(approval.availableDecisions, ["approve_once", "approve_command_rule", "deny"]);
    assert.deepEqual(approval.proposedCommandRule, proposedCommandRule);
    const approved = store.approveApprovalRequest(approval.id, { decisionKind: "approve_once" }, "2026-08-28T01:01:00.000Z");
    assert.equal(approved?.decisionKind, "approve_once");
    assert.deepEqual(store.listApprovalCommandRules(), []);

    store.close();
    store = createSqliteRunStore(cwd);
    assert.deepEqual(store.getApprovalRequest(approval.id)?.proposedCommandRule, proposedCommandRule);
    assert.equal(store.getApprovalRequest(approval.id)?.decisionKind, "approve_once");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite approval resolution atomically saves, matches, and revokes a workspace command rule", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-command-rule-save-"));
  const now = "2026-08-28T02:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_command_rule_save",
      cwd,
      taskId: "task_command_rule_save",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_command_rule_save", title: "Command rule save" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const proposedCommandRule = {
      prefix: ["whois"],
      display: "whois",
      fingerprint: "command_rule_v1_whois",
      version: 1,
    };
    const approval = store.createApprovalRequest({
      runId: "run_command_rule_save",
      taskId: "task_command_rule_save",
      actionType: "bash",
      risk: "medium",
      title: "Approve shell command",
      description: "whois example.com",
      payload: { type: "bash", cwd, command: "whois example.com", riskFlags: [] },
      availableDecisions: ["approve_once", "approve_command_rule", "deny"],
      proposedCommandRule,
    }, now);

    assert.throws(() => store.approveApprovalRequest(approval.id, {
      decisionKind: "approve_command_rule",
      proposedRuleFingerprint: "stale-fingerprint",
    }, "2026-08-28T02:00:30.000Z"), /unavailable or stale/);
    assert.equal(store.getApprovalRequest(approval.id)?.status, "pending");
    assert.deepEqual(store.listApprovalCommandRules(), []);

    const approved = store.approveApprovalRequest(approval.id, {
      decisionKind: "approve_command_rule",
      proposedRuleFingerprint: proposedCommandRule.fingerprint,
    }, "2026-08-28T02:01:00.000Z");
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.decisionKind, "approve_command_rule");
    assert.ok(approved?.decisionRuleId);

    const [rule] = store.listApprovalCommandRules();
    assert.equal(rule.id, approved.decisionRuleId);
    assert.deepEqual(rule.prefix, ["whois"]);
    assert.equal(rule.revokedAt, undefined);
    assert.equal(store.findMatchingApprovalCommandRule("bash", ["whois", "example.net"])?.id, rule.id);
    assert.equal(store.findMatchingApprovalCommandRule("bash", ["dig", "example.net"]), undefined);

    store.close();
    store = createSqliteRunStore(cwd);
    assert.equal(store.findMatchingApprovalCommandRule("bash", ["whois", "example.org"])?.id, rule.id);
    const database = new DatabaseSync(store.paths.databasePath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT name FROM schema_migrations WHERE version = 126").get()?.name,
        "create_approval_command_rules",
      );
      assert.equal(
        database.prepare("SELECT name FROM schema_migrations WHERE version = 115").get()?.name,
        "materialize_channel_delegated_step_requirements",
      );
    } finally {
      database.close();
    }

    assert.throws(() => store.approveApprovalRequest(approval.id, {
      decisionKind: "approve_command_rule",
      proposedRuleFingerprint: proposedCommandRule.fingerprint,
    }, "2026-08-28T02:02:00.000Z"), /not pending/);

    const revoked = store.revokeApprovalCommandRule(rule.id, "2026-08-28T02:03:00.000Z");
    assert.equal(revoked?.revokedAt, "2026-08-28T02:03:00.000Z");
    assert.equal(store.findMatchingApprovalCommandRule("bash", ["whois", "example.net"]), undefined);

    store.createRun({
      id: "run_command_rule_restore",
      cwd,
      taskId: "task_command_rule_restore",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_command_rule_restore", title: "Command rule restore" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: "2026-08-28T02:04:00.000Z",
    });
    const restoreApproval = store.createApprovalRequest({
      runId: "run_command_rule_restore",
      taskId: "task_command_rule_restore",
      actionType: "bash",
      risk: "medium",
      title: "Approve shell command again",
      description: "whois example.org",
      payload: { type: "bash", cwd, command: "whois example.org", riskFlags: [] },
      availableDecisions: ["approve_once", "approve_command_rule", "deny"],
      proposedCommandRule,
    }, "2026-08-28T02:04:00.000Z");
    const restoredApproval = store.approveApprovalRequest(restoreApproval.id, {
      decisionKind: "approve_command_rule",
      proposedRuleFingerprint: proposedCommandRule.fingerprint,
    }, "2026-08-28T02:05:00.000Z");
    const [restoredRule] = store.listApprovalCommandRules();
    assert.equal(restoredApproval?.decisionRuleId, rule.id);
    assert.equal(restoredRule.id, rule.id);
    assert.equal(restoredRule.sourceApprovalId, restoreApproval.id);
    assert.equal(restoredRule.revokedAt, undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store merges and persists approval policy updates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-policy-"));
  const updatedAt = "2026-05-21T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const updated = store.updateApprovalPolicy(
      {
        toolDecisions: {
          bash: "allow",
          write: "deny",
        },
        allowedWritePaths: [".", "docs"],
      },
      updatedAt,
    );

    assert.equal(updated.toolDecisions.read, "allow");
    assert.equal(updated.toolDecisions.bash, "allow");
    assert.equal(updated.toolDecisions.edit, "ask");
    assert.equal(updated.toolDecisions.write, "deny");
    assert.deepEqual(updated.allowedWritePaths, [".", "docs"]);
    assert.equal(updated.updatedAt, updatedAt);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const persisted = store.getApprovalPolicy();

    assert.equal(persisted.toolDecisions.bash, "allow");
    assert.equal(persisted.toolDecisions.write, "deny");
    assert.deepEqual(persisted.allowedWritePaths, [".", "docs"]);
    assert.equal(persisted.updatedAt, updatedAt);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session permission policy snapshots structured risk notes without relaxing deny rules", () => {
  const policyUpdatedAt = "2026-06-04T00:00:00.000Z";
  const result = resolveSessionRunPolicy({
    workspacePolicy: {
      workspaceId: "workspace_default",
      toolDecisions: {
        ...defaultApprovalToolDecisions,
        bash: "deny",
        write: "deny",
      },
      allowedWritePaths: ["docs"],
      createdAt: policyUpdatedAt,
      updatedAt: policyUpdatedAt,
    },
    permissionMode: "full_access",
  });

  assert.equal(result.approvalPolicy.toolDecisions.bash, "deny");
  assert.equal(result.approvalPolicy.toolDecisions.write, "deny");
  assert.deepEqual(result.snapshot.allowedWritePaths, ["/"]);
  assert.equal(result.snapshot.workspacePolicyUpdatedAt, policyUpdatedAt);
  assert.deepEqual(
    result.snapshot.riskNotes.filter((note) => note.code === "session_mode_denied_by_workspace_policy").map((note) => note.tool),
    ["bash", "write"],
  );
});

test("permission presets map to existing session permission modes", () => {
  assert.equal(permissionModeForPreset("read_only"), "ask_everything");
  assert.equal(permissionModeForPreset("workspace_collaboration"), "workspace_write");
  assert.equal(permissionModeForPreset("full_access"), "full_access");
  assert.equal(permissionModeForPreset("custom"), "custom");
  assert.equal(inferPermissionPreset("ask_everything"), "read_only");
  assert.equal(inferPermissionPreset("workspace_write"), "workspace_collaboration");
  assert.equal(inferPermissionPreset("full_access"), "full_access");
  assert.equal(inferPermissionPreset("balanced"), "custom");
  assert.equal(permissionPresetRequiresConfirmation("full_access"), true);
  assert.equal(permissionPresetRequiresConfirmation("workspace_collaboration"), false);
});

test("independent authorization and workspace access resolve the complete policy matrix", () => {
  const workspacePolicy = {
    workspaceId: "workspace_default",
    toolDecisions: defaultApprovalToolDecisions,
    allowedWritePaths: ["legacy-path"],
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
  const expected = {
    read_only: {
      ask: ["deny", "deny", "deny"],
      smart: ["deny", "deny", "deny"],
      always: ["deny", "deny", "deny"],
    },
    workspace_write: {
      ask: ["ask", "ask", "ask"],
      smart: ["ask", "allow", "allow"],
      always: ["ask", "allow", "allow"],
    },
    full_access: {
      ask: ["ask", "ask", "ask"],
      smart: ["ask", "allow", "allow"],
      always: ["allow", "allow", "allow"],
    },
  };

  for (const workspaceAccessMode of ["read_only", "workspace_write", "full_access"]) {
    for (const authorizationMode of ["ask", "smart", "always"]) {
      const result = resolveSessionRunPolicy({
        workspacePolicy,
        authorizationMode,
        workspaceAccessMode,
        channelBoundPath: "/workspace/project",
      });
      assert.deepEqual(
        [
          result.approvalPolicy.toolDecisions.bash,
          result.approvalPolicy.toolDecisions.edit,
          result.approvalPolicy.toolDecisions.write,
        ],
        expected[workspaceAccessMode][authorizationMode],
      );
      assert.deepEqual(
        result.snapshot.allowedWritePaths,
        workspaceAccessMode === "read_only"
          ? []
          : workspaceAccessMode === "full_access"
            ? ["/"]
            : ["/workspace/project"],
      );
      assert.equal(result.snapshot.authorizationMode, authorizationMode);
      assert.equal(result.snapshot.workspaceAccessMode, workspaceAccessMode);
    }
  }
});

test("independent permissions preserve hard denies and compatibility projections", () => {
  const result = resolveSessionRunPolicy({
    workspacePolicy: {
      workspaceId: "workspace_default",
      toolDecisions: { ...defaultApprovalToolDecisions, edit: "deny" },
      allowedWritePaths: ["."],
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    },
    authorizationMode: "always",
    workspaceAccessMode: "workspace_write",
  });

  assert.equal(result.approvalPolicy.toolDecisions.edit, "deny");
  assert.equal(result.approvalPolicy.toolDecisions.bash, "ask");
  assert.equal(result.snapshot.mode, "custom");
  assert.ok(result.snapshot.riskNotes.some((note) => note.code === "workspace_command_requires_approval"));
  assert.deepEqual(authorizationAndAccessFromLegacyPermission("workspace_write", "workspace_collaboration"), {
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
  });
  assert.deepEqual(authorizationAndAccessFromLegacyPermission("ask_everything", "full_access"), {
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
  });
  assert.deepEqual(authorizationAndAccessFromLegacyPermission("custom", "full_access"), {
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
  });
  assert.deepEqual(legacyPermissionFromAuthorizationAndAccess("always", "workspace_write"), {
    permissionMode: "custom",
    permissionPreset: "custom",
  });
  assert.equal(workspaceAccessModeRequiresConfirmation("full_access"), true);
  assert.equal(workspaceAccessModeRequiresConfirmation("workspace_write"), false);
});

test("workspace settings persist independent defaults without cross-overwriting", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-workspace-permissions-"));
  let store = createSqliteRunStore(cwd);
  try {
    assert.equal(store.getWorkspaceSettings().defaultAuthorizationMode, "smart");
    assert.equal(store.getWorkspaceSettings().defaultWorkspaceAccessMode, "workspace_write");

    const authorizationOnly = store.updateWorkspaceSettings({ defaultAuthorizationMode: "ask" }, "2026-07-11T00:00:00.000Z");
    assert.equal(authorizationOnly.defaultAuthorizationMode, "ask");
    assert.equal(authorizationOnly.defaultWorkspaceAccessMode, "workspace_write");
    assert.equal(authorizationOnly.defaultPermissionMode, "custom");
    assert.equal(authorizationOnly.defaultPermissionPreset, "custom");

    const accessOnly = store.updateWorkspaceSettings({ defaultWorkspaceAccessMode: "read_only" }, "2026-07-11T00:01:00.000Z");
    assert.equal(accessOnly.defaultAuthorizationMode, "ask");
    assert.equal(accessOnly.defaultWorkspaceAccessMode, "read_only");
    assert.equal(accessOnly.defaultPermissionMode, "ask_everything");
    assert.equal(accessOnly.defaultPermissionPreset, "read_only");
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const reopened = store.getWorkspaceSettings();
    assert.equal(reopened.defaultAuthorizationMode, "ask");
    assert.equal(reopened.defaultWorkspaceAccessMode, "read_only");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists run artifacts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-artifacts-"));
  const now = "2026-05-22T00:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_artifact_test",
      cwd,
      taskId: "task_artifact_test",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_artifact_test", title: "Artifact test" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const created = store.createArtifact({
      id: "artifact_test_markdown",
      runId: "run_artifact_test",
      type: "markdown",
      path: "run_artifact_test/result.md",
      title: "Result Markdown",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      createdAt: now,
    });

    assert.equal(created.id, "artifact_test_markdown");
    assert.equal(created.runId, "run_artifact_test");
    assert.equal(created.type, "markdown");
    assert.equal(created.path, "run_artifact_test/result.md");
    assert.equal(created.title, "Result Markdown");
    assert.equal(created.contentType, "text/markdown; charset=utf-8");
    assert.equal(created.sizeBytes, 42);
    assert.deepEqual(store.listArtifacts("run_artifact_test"), [created]);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const fetched = store.getArtifact("artifact_test_markdown");
    assert.ok(fetched);
    assert.equal(fetched.path, "run_artifact_test/result.md");
    assert.deepEqual(store.listArtifacts("run_artifact_test"), [fetched]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists run interventions, idempotency, FIFO order, cancellation, and lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-interventions-"));
  const now = "2026-06-04T03:00:00.000Z";
  let firstInterventionId = "";
  let attachmentId = "";
  let linkPreviewId = "";
  let store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Guidance", boundPath: cwd }, now);
    const otherChannel = store.createChannel({ name: "Other", boundPath: cwd }, now);
    const attachment = store.createChannelAttachment({
      channelId: channel.id,
      kind: "text",
      fileName: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 32,
      path: `${channel.id}/notes.txt`,
      createdAt: now,
    });
    const otherAttachment = store.createChannelAttachment({
      channelId: otherChannel.id,
      kind: "text",
      fileName: "other.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      path: `${otherChannel.id}/other.txt`,
      createdAt: now,
    });
    const linkPreview = store.createChannelLinkPreview(
      {
        channelId: channel.id,
        url: "https://example.com/docs",
        normalizedUrl: "https://example.com/docs",
        title: "Docs",
        status: "ready",
      },
      now,
    );
    attachmentId = attachment.id;
    linkPreviewId = linkPreview.id;
    store.createRun({
      id: "run_source",
      cwd,
      taskId: "task_guided",
      channelId: channel.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_guided", title: "Guided task", prompt: "Build the feature." },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, permissionMode: "balanced", requestedSkillId: "implement" },
      workUnitId: "wu_source",
      createdAt: now,
    });

    const first = store.createRunIntervention(
      {
        sourceRunId: "run_source",
        sourceWorkUnitId: "wu_source",
        mode: "queue_followup",
        instruction: "After this finishes, check the settings page.",
        messagePayload: {
          body: "After this finishes, check the settings page.",
          attachmentIds: [attachment.id],
          linkPreviewIds: [linkPreview.id],
        },
        idempotencyKey: "guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:01:00.000Z",
    );
    firstInterventionId = first.id;
    assert.deepEqual(first.messagePayload, {
      body: "After this finishes, check the settings page.",
      attachmentIds: [attachment.id],
      linkPreviewIds: [linkPreview.id],
    });
    const duplicate = store.createRunIntervention(
      {
        sourceRunId: "run_source",
        sourceWorkUnitId: "wu_source",
        mode: "queue_followup",
        instruction: "Duplicate should not create another row.",
        idempotencyKey: "guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:01:05.000Z",
    );
    const second = store.createRunIntervention(
      {
        sourceRunId: "run_source",
        mode: "interrupt_redirect",
        instruction: "Stop and use the daemon API path.",
        idempotencyKey: "redirect-1",
        requestedBy: "local-user",
      },
      "2026-06-04T03:02:00.000Z",
    );
    assert.throws(
      () => store.createRunIntervention(
        {
          sourceRunId: "run_source",
          mode: "queue_followup",
          instruction: "Cross-channel attachment should fail.",
          messagePayload: {
            body: "Cross-channel attachment should fail.",
            attachmentIds: [otherAttachment.id],
            linkPreviewIds: [],
          },
          idempotencyKey: "bad-cross-channel",
          requestedBy: "local-user",
        },
        "2026-06-04T03:02:30.000Z",
      ),
      /Attachment does not belong to channel/,
    );

    assert.equal(duplicate.id, first.id);
    assert.equal(store.listRunInterventions({ sourceRunId: "run_source" }).length, 2);
    assert.deepEqual(
      store.listRunInterventions({ sourceRunId: "run_source" }).map((intervention) => intervention.id),
      [first.id, second.id],
    );

    const cancelled = store.cancelRunIntervention(first.id, "2026-06-04T03:03:00.000Z", "user_cancelled");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.failureReason, "user_cancelled");

    store.createRun({
      id: "run_continuation",
      cwd,
      taskId: "task_guided",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_guided", title: "Guided task" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, continuation: true },
      parentRunId: "run_source",
      interventionId: second.id,
      continuationReason: "interrupt_redirect",
      workUnitId: "wu_continuation",
      createdAt: "2026-06-04T03:04:00.000Z",
    });

    const started = store.updateRunInterventionStatus({
      interventionId: second.id,
      status: "started",
      continuationRunId: "run_continuation",
      continuationWorkUnitId: "wu_continuation",
      startedAt: "2026-06-04T03:04:00.000Z",
      completedAt: "2026-06-04T03:04:00.000Z",
      now: "2026-06-04T03:04:00.000Z",
    });
    assert.equal(started?.continuationRunId, "run_continuation");
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    assert.deepEqual(store.getRunIntervention(firstInterventionId).messagePayload, {
      body: "After this finishes, check the settings page.",
      attachmentIds: [attachmentId],
      linkPreviewIds: [linkPreviewId],
    });
    const interventions = store.listRunInterventions({ sourceRunId: "run_source" });
    assert.equal(interventions.length, 2);
    assert.equal(interventions[0].status, "cancelled");
    assert.equal(interventions[1].continuationRunId, "run_continuation");
    const continuation = store.getRun("run_continuation");
    assert.equal(continuation?.parentRunId, "run_source");
    assert.equal(continuation?.interventionId, interventions[1].id);
    assert.equal(continuation?.continuationReason, "interrupt_redirect");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store atomically claims pending interventions beyond the first history page", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-intervention-claim-"));
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_claim_source",
      cwd,
      taskId: "task_claim_source",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: "2026-08-08T00:00:00.000Z",
    });

    let pendingId = "";
    for (let index = 0; index < 101; index += 1) {
      const createdAt = new Date(Date.parse("2026-08-08T00:00:00.000Z") + index * 1_000).toISOString();
      const intervention = store.createRunIntervention({
        sourceRunId: "run_claim_source",
        mode: "queue_followup",
        instruction: `guidance ${index}`,
        idempotencyKey: `claim-${index}`,
      }, createdAt);
      if (index < 100) {
        store.updateRunInterventionStatus({
          interventionId: intervention.id,
          expectedStatuses: ["queued"],
          status: "started",
          startedAt: createdAt,
          completedAt: createdAt,
          now: createdAt,
        });
      } else {
        pendingId = intervention.id;
      }
    }

    const claimed = store.claimNextRunIntervention({
      sourceRunId: "run_claim_source",
      expectedStatuses: ["cancelling_source", "queued"],
      status: "starting_continuation",
      startedAt: "2026-08-08T00:02:00.000Z",
      now: "2026-08-08T00:02:00.000Z",
    });
    assert.equal(claimed?.id, pendingId);
    assert.equal(claimed?.status, "starting_continuation");
    assert.equal(store.claimNextRunIntervention({
      sourceRunId: "run_claim_source",
      expectedStatuses: ["cancelling_source", "queued"],
      status: "starting_continuation",
      startedAt: "2026-08-08T00:02:01.000Z",
      now: "2026-08-08T00:02:01.000Z",
    }), undefined);
    assert.equal(store.updateRunInterventionStatus({
      interventionId: pendingId,
      expectedStatuses: ["queued"],
      status: "cancelled",
      now: "2026-08-08T00:02:02.000Z",
    }), undefined);
    assert.equal(store.getRunIntervention(pendingId)?.status, "starting_continuation");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store loads only the latest completed intervention replies before the current item", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-run-intervention-replies-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Continuation context", boundPath: cwd }, "2026-08-08T00:00:00.000Z");
    store.createRun({
      id: "run_reply_context_source",
      cwd,
      taskId: "task_reply_context_source",
      channelId: channel.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: "2026-08-08T00:00:00.000Z",
    });

    const replyIds = [];
    for (let index = 0; index < 8; index += 1) {
      const timestamp = new Date(Date.parse("2026-08-08T00:00:00.000Z") + index * 1_000).toISOString();
      const reply = appendChannelItemFixture(store, {
        channelId: channel.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: "ling_agent",
        body: `reply ${index}`,
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        status: "ready",
      }, timestamp);
      const workUnit = store.createWorkUnit({
        workspaceId: channel.workspaceId,
        kind: "channel_ai_reply",
        ownerType: "channel_message",
        ownerId: reply.id,
        channelId: channel.id,
        idempotencyKey: `reply-context-work-unit-${index}`,
        createdByActor: "local-user",
        request: {},
        linkedMessageId: reply.id,
        now: timestamp,
      });
      const intervention = store.createRunIntervention({
        sourceRunId: "run_reply_context_source",
        mode: "queue_followup",
        instruction: `guidance ${index}`,
        idempotencyKey: `reply-context-intervention-${index}`,
      }, timestamp);
      store.updateRunInterventionStatus({
        interventionId: intervention.id,
        expectedStatuses: ["queued"],
        status: "started",
        continuationWorkUnitId: workUnit.id,
        startedAt: timestamp,
        completedAt: timestamp,
        now: timestamp,
      });
      replyIds.push(reply.id);
    }
    const current = store.createRunIntervention({
      sourceRunId: "run_reply_context_source",
      mode: "queue_followup",
      instruction: "current guidance",
      idempotencyKey: "reply-context-current",
    }, "2026-08-08T00:00:09.000Z");

    assert.deepEqual(
      store.listPriorRunInterventionReplyMessages({
        sourceRunId: "run_reply_context_source",
        beforeInterventionId: current.id,
        channelId: channel.id,
        limit: 6,
      }).map((message) => message.id),
      replyIds.slice(-6),
    );
    assert.deepEqual(
      store.listPriorRunInterventionReplyMessages({
        sourceRunId: "run_reply_context_source",
        beforeInterventionId: current.id,
        channelId: channel.id,
      }).map((message) => message.id),
      replyIds,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists media jobs and status updates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-media-jobs-"));
  const createdAt = "2026-05-23T00:00:00.000Z";
  const updatedAt = "2026-05-23T00:01:00.000Z";
  let store = createSqliteRunStore(cwd);
  let jobId = "";
  try {
    const created = store.createMediaJob(
      {
        providerPresetId: "provider_seedream",
        operation: "image_generate",
        prompt: "Generate a clean product mockup.",
        input: { size: "1024x1024", apiKey: "sk-test_123456789" },
      },
      createdAt,
    );
    jobId = created.id;

    assert.equal(created.providerPresetId, "provider_seedream");
    assert.equal(created.operation, "image_generate");
    assert.equal(created.status, "queued");
    assert.deepEqual(created.artifactIds, []);
    assert.equal(created.input.size, "1024x1024");
    assert.equal(created.input.apiKey, "[REDACTED]");

    const artifact = store.createArtifact({
      id: "artifact_media_job_markdown",
      mediaJobId: created.id,
      type: "markdown",
      path: `${created.id}/static-result.md`,
      title: "Static media result",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 128,
      createdAt,
    });
    assert.equal(artifact.mediaJobId, created.id);
    assert.equal(artifact.runId, undefined);
    assert.deepEqual(store.listMediaJobArtifacts(created.id), [artifact]);

    const updated = store.updateMediaJobStatus(
      created.id,
      {
        status: "succeeded",
        artifactIds: [artifact.id],
      },
      updatedAt,
    );
    assert.ok(updated);
    assert.equal(updated.status, "succeeded");
    assert.deepEqual(updated.artifactIds, [artifact.id]);
    assert.equal(updated.updatedAt, updatedAt);
    assert.deepEqual(store.listMediaJobs({ status: "succeeded" }), [updated]);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const fetched = store.getMediaJob(jobId);
    assert.ok(fetched);
    assert.equal(fetched.status, "succeeded");
    assert.equal(fetched.prompt, "Generate a clean product mockup.");
    assert.deepEqual(fetched.artifactIds, ["artifact_media_job_markdown"]);
    assert.deepEqual(store.listMediaJobArtifacts(jobId), [store.getArtifact("artifact_media_job_markdown")]);
    assert.deepEqual(store.listMediaJobs({ providerPresetId: "provider_seedream" }), [fetched]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store keeps media production run history when scenes and projects are removed", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-media-production-"));
  const createdAt = "2026-07-13T00:00:00.000Z";
  const updatedAt = "2026-07-13T00:02:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const project = store.createMediaProject({
      name: "Launch storyboard",
      defaultProviderPresetId: "provider_seedance",
      canvasViewport: { x: 10, y: -6, zoom: 1.2 },
    }, createdAt);
    const firstScene = store.createMediaScene({
      projectId: project.id,
      title: "Opening",
      prompt: "A cinematic product reveal.",
      ratio: "16:9",
      durationSeconds: 5,
      canvasPosition: { x: 40, y: 72 },
    }, createdAt);
    const secondScene = store.createMediaScene({
      projectId: project.id,
      title: "Close up",
      prompt: "A close up of the material.",
      ratio: "16:9",
      durationSeconds: 5,
      canvasPosition: { x: 360, y: 72 },
    }, createdAt);
    assert.deepEqual(store.listMediaScenes(project.id).map((scene) => scene.id), [firstScene.id, secondScene.id]);

    const reordered = store.reorderMediaScenes(project.id, [secondScene.id, firstScene.id], updatedAt);
    assert.deepEqual(reordered.map((scene) => scene.id), [secondScene.id, firstScene.id]);
    assert.deepEqual(reordered.map((scene) => scene.sortOrder), [0, 1]);

    const job = store.createMediaJob({
      providerPresetId: "provider_seedance",
      operation: "video_generate",
      prompt: secondScene.prompt,
      input: { ratio: "16:9", duration: 5 },
    }, updatedAt);
    const sceneRun = store.createMediaSceneRun({
      projectId: project.id,
      sceneId: secondScene.id,
      mediaJobId: job.id,
      providerSnapshot: { model: "seedance-1-0-pro" },
      inputSnapshot: { prompt: secondScene.prompt, apiKey: "sk-secret" },
    }, updatedAt);
    assert.deepEqual(store.getMediaSceneRunByMediaJobId(job.id), sceneRun);
    assert.equal(store.getMediaSceneRunByMediaJobId("media_job_missing"), undefined);
    const handle = store.upsertMediaJobExecutionHandle({
      mediaJobId: job.id,
      adapterKind: "seedance",
      externalOperationId: "task_123",
      recovery: { statusEndpoint: "https://example.invalid/tasks/task_123", authorization: "Bearer secret" },
    }, updatedAt);
    assert.equal(handle.externalOperationId, "task_123");
    assert.equal(handle.recovery.authorization, "[REDACTED]");

    const selected = store.updateMediaScene(secondScene.id, { selectedMediaSceneRunId: sceneRun.id }, updatedAt);
    assert.equal(selected?.selectedMediaSceneRunId, sceneRun.id);
    assert.equal(store.deleteMediaScene(secondScene.id), true);
    assert.equal(store.getMediaSceneRun(sceneRun.id)?.mediaJobId, job.id);
    assert.equal(store.getMediaJob(job.id)?.id, job.id);

    assert.equal(store.deleteMediaProject(project.id), true);
    assert.equal(store.getMediaSceneRun(sceneRun.id)?.sceneId, secondScene.id);
    assert.equal(store.getMediaJobExecutionHandle(job.id)?.externalOperationId, "task_123");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store expires pending approval requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-expiry-"));
  const now = "2026-05-22T00:00:00.000Z";
  const expiredAt = "2026-05-22T00:30:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_expiry",
      cwd,
      taskId: "task_approval_expiry",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_expiry", title: "Approval expiry" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const pending = store.createApprovalRequest(
      {
        runId: "run_approval_expiry",
        taskId: "task_approval_expiry",
        actionType: "bash",
        risk: "medium",
        title: "Approve shell command",
        description: "echo wait",
        payload: { type: "bash", cwd, command: "echo wait", riskFlags: [] },
        expiresAt: expiredAt,
      },
      now,
    );

    const expired = store.expireApprovalRequest(
      pending.id,
      { reason: "Approval request expired before a decision was received." },
      expiredAt,
    );

    assert.ok(expired);
    assert.equal(expired.status, "expired");
    assert.equal(expired.resolvedAt, expiredAt);
    assert.equal(expired.resolvedBy, undefined);
    assert.equal(expired.decisionReason, "Approval request expired before a decision was received.");
    assert.throws(() => store.approveApprovalRequest(pending.id, { reason: "too late" }, expiredAt), /not pending/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("terminal Run cannot approve a stale pending request or persist its command rule", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-stale-run-approval-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-09-28T12:00:00.000Z";
  try {
    store.createRun({ id: "run_stale_approval", cwd, taskId: "task_stale_approval",
      providerName: "test", providerModel: "test",
      taskSnapshot: { id: "task_stale_approval", title: "Stale approval" },
      providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
    store.markRunStarted("run_stale_approval", now);
    const proposal = { prefix: ["python3", "-m", "unittest"], display: "python3 -m unittest",
      fingerprint: "command_rule_v1_stale_test", version: 1 };
    const input = { runId: "run_stale_approval", taskId: "task_stale_approval",
      actionType: "bash", risk: "medium", title: "Run tests", description: "Run unit tests",
      payload: { type: "bash", cwd, command: "python3 -m unittest", riskFlags: [] },
      availableDecisions: ["approve_once", "approve_command_rule", "deny"], proposedCommandRule: proposal };
    const once = store.createApprovalRequest(input, now);
    const rule = store.createApprovalRequest(input, now);
    store.markRunFailed("run_stale_approval", "2026-09-28T12:01:00.000Z", "Prior approval expired.");
    assert.throws(() => store.approveApprovalRequest(once.id, { decisionKind: "approve_once" }, now), /execution no longer active/);
    assert.throws(() => store.approveApprovalRequest(rule.id, { decisionKind: "approve_command_rule",
      proposedRuleFingerprint: proposal.fingerprint }, now), /execution no longer active/);
    assert.equal(store.getApprovalRequest(once.id)?.status, "pending");
    assert.equal(store.getApprovalRequest(rule.id)?.status, "pending");
    assert.deepEqual(store.listApprovalCommandRules(), []);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store creates approval checkpoints and syncs approval lifecycle", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-checkpoints-"));
  const now = "2026-06-19T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_checkpoints",
      cwd,
      taskId: "task_approval_checkpoints",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_checkpoints", title: "Approval checkpoints" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const cases = [
      {
        suffix: "approved",
        method: "approveApprovalRequest",
        expectedStatus: "approved",
        reason: "Approved for smoke.",
        resolvedAt: "2026-06-19T00:01:00.000Z",
      },
      {
        suffix: "denied",
        method: "denyApprovalRequest",
        expectedStatus: "denied",
        reason: "Too risky.",
        resolvedAt: "2026-06-19T00:02:00.000Z",
      },
      {
        suffix: "expired",
        method: "expireApprovalRequest",
        expectedStatus: "expired",
        reason: "Timed out.",
        resolvedAt: "2026-06-19T00:03:00.000Z",
      },
      {
        suffix: "cancelled",
        method: "cancelApprovalRequest",
        expectedStatus: "cancelled",
        reason: "Run stopped.",
        resolvedAt: "2026-06-19T00:04:00.000Z",
      },
    ];

    for (const entry of cases) {
      const approval = store.createApprovalRequest(
        {
          runId: "run_approval_checkpoints",
          taskId: "task_approval_checkpoints",
          toolCallId: `tool_${entry.suffix}`,
          actionType: "bash",
          risk: "medium",
          title: `Approve ${entry.suffix}`,
          description: `echo ${entry.suffix}`,
          payload: { type: "bash", cwd, command: `echo ${entry.suffix}`, riskFlags: [] },
        },
        now,
      );

      const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
      assert.ok(checkpoint);
      assert.equal(checkpoint.approvalId, approval.id);
      assert.equal(checkpoint.runId, "run_approval_checkpoints");
      assert.equal(checkpoint.taskId, "task_approval_checkpoints");
      assert.equal(checkpoint.toolCallId, `tool_${entry.suffix}`);
      assert.equal(checkpoint.status, "pending");
      assert.equal(checkpoint.actionType, "bash");
      assert.deepEqual(checkpoint.sideEffect, approval.payload);
      assert.deepEqual(checkpoint.previewArtifactIds, []);
      assert.deepEqual(checkpoint.resultArtifactIds, []);

      const resolved = store[entry.method](approval.id, { reason: entry.reason }, entry.resolvedAt);
      assert.ok(resolved);
      assert.equal(resolved.status, entry.expectedStatus);
      if (entry.expectedStatus === "expired" || entry.expectedStatus === "cancelled") {
        assert.equal(resolved.resolvedBy, undefined, "system lifecycle resolution must not impersonate a user");
      }

      const synced = store.getApprovalCheckpointForApproval(approval.id);
      assert.ok(synced);
      assert.equal(synced.status, entry.expectedStatus);
      assert.equal(synced.resolvedAt, entry.resolvedAt);
      assert.equal(synced.updatedAt, entry.resolvedAt);
      assert.deepEqual(store.listApprovalCheckpoints({ status: entry.expectedStatus }).map((item) => item.approvalId), [approval.id]);
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval resolution rolls back the decision when checkpoint persistence fails", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-atomic-resolution-"));
  const now = "2026-06-19T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_atomic_resolution",
      cwd,
      taskId: "task_approval_atomic_resolution",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_atomic_resolution", title: "Atomic approval resolution" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const cases = ["approveApprovalRequest", "denyApprovalRequest", "expireApprovalRequest", "cancelApprovalRequest"];
    for (const [index, method] of cases.entries()) {
      const approval = store.createApprovalRequest({
        runId: "run_approval_atomic_resolution",
        taskId: "task_approval_atomic_resolution",
        toolCallId: `tool_atomic_${index}`,
        actionType: "bash",
        risk: "medium",
        title: "Atomic decision",
        description: "echo safe",
        payload: { type: "bash", cwd, command: "echo safe", riskFlags: [] },
      }, now);
      const database = new DatabaseSync(store.paths.databasePath);
      try {
        database.exec(`CREATE TRIGGER fail_checkpoint_resolution BEFORE UPDATE ON approval_checkpoints
          BEGIN SELECT RAISE(ABORT, 'injected_checkpoint_failure'); END`);
      } finally {
        database.close();
      }
      assert.throws(() => store[method](approval.id, { reason: "testing rollback" }, now), /injected_checkpoint_failure/);
      assert.equal(store.getApprovalRequest(approval.id)?.status, "pending", `${method} must not leave a half-committed decision`);
      assert.equal(store.getApprovalCheckpointForApproval(approval.id)?.status, "pending");
      const cleanup = new DatabaseSync(store.paths.databasePath);
      try {
        cleanup.exec("DROP TRIGGER fail_checkpoint_resolution");
      } finally {
        cleanup.close();
      }
      assert.ok(store[method](approval.id, { reason: "retry after recovery" }, now));
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval creation rolls back the request when checkpoint persistence fails", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-atomic-creation-"));
  const now = "2026-06-19T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_atomic_creation",
      cwd,
      taskId: "task_approval_atomic_creation",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_atomic_creation", title: "Atomic approval creation" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const input = {
      runId: "run_approval_atomic_creation",
      taskId: "task_approval_atomic_creation",
      toolCallId: "tool_atomic_creation",
      actionType: "bash",
      risk: "medium",
      title: "Atomic creation",
      description: "echo safe",
      payload: { type: "bash", cwd, command: "echo safe", riskFlags: [] },
    };
    const database = new DatabaseSync(store.paths.databasePath);
    try {
      database.exec(`CREATE TRIGGER fail_checkpoint_creation BEFORE INSERT ON approval_checkpoints
        BEGIN SELECT RAISE(ABORT, 'injected_checkpoint_creation_failure'); END`);
    } finally {
      database.close();
    }
    assert.throws(() => store.createApprovalRequest(input, now), /injected_checkpoint_creation_failure/);
    assert.equal(store.listApprovalRequests({ runId: input.runId, complete: true }).length, 0,
      "an uncheckpointed approval must not become visible or block a run");
    const cleanup = new DatabaseSync(store.paths.databasePath);
    try {
      cleanup.exec("DROP TRIGGER fail_checkpoint_creation");
    } finally {
      cleanup.close();
    }
    const approval = store.createApprovalRequest(input, now);
    assert.equal(store.getApprovalCheckpointForApproval(approval.id)?.status, "pending");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval checkpoint recovery scans stable pages even when creation timestamps tie", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-checkpoint-pages-"));
  const now = "2026-06-19T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_checkpoint_pages",
      cwd,
      taskId: "task_approval_checkpoint_pages",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_checkpoint_pages", title: "Checkpoint pages" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const approvalIds = [];
    for (let index = 0; index < 3; index += 1) {
      approvalIds.push(store.createApprovalRequest({
        runId: "run_approval_checkpoint_pages",
        taskId: "task_approval_checkpoint_pages",
        toolCallId: `tool_page_${index}`,
        actionType: "bash",
        risk: "medium",
        title: `Page ${index}`,
        description: "echo safe",
        payload: { type: "bash", cwd, command: "echo safe", riskFlags: [] },
      }, now).id);
    }
    const first = store.listApprovalCheckpoints({ status: "pending", limit: 2 });
    const last = first.at(-1);
    const second = store.listApprovalCheckpoints({ status: "pending", limit: 2,
      before: { createdAt: last.createdAt, id: last.id } });
    assert.equal(first.length, 2);
    assert.equal(second.length, 1);
    assert.deepEqual(new Set([...first, ...second].map((checkpoint) => checkpoint.approvalId)), new Set(approvalIds));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store updates approval checkpoint resume metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-resume-"));
  const now = "2026-06-19T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_approval_resume",
      cwd,
      taskId: "task_approval_resume",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_approval_resume", title: "Approval resume" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });

    const approval = store.createApprovalRequest(
      {
        runId: "run_approval_resume",
        taskId: "task_approval_resume",
        actionType: "bash",
        risk: "high",
        title: "Approve resumable command",
        description: "echo resume",
        payload: { type: "bash", cwd, command: "echo resume", riskFlags: ["writes"] },
      },
      now,
    );
    const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
    assert.ok(checkpoint);

    const resumePending = store.updateApprovalCheckpointStatus(
      checkpoint.id,
      {
        status: "resume_pending",
        previewArtifactIds: ["artifact_preview"],
        resultArtifactIds: ["artifact_result"],
        runnerResumeHandle: {
          kind: "ling_continuation",
          runId: "run_approval_resume",
          attemptId: "attempt_approval_resume",
          verified: true,
        },
      },
      "2026-06-19T01:01:00.000Z",
    );

    assert.ok(resumePending);
    assert.equal(resumePending.status, "resume_pending");
    assert.deepEqual(resumePending.previewArtifactIds, ["artifact_preview"]);
    assert.deepEqual(resumePending.resultArtifactIds, ["artifact_result"]);
    assert.deepEqual(resumePending.runnerResumeHandle, {
      kind: "ling_continuation",
      runId: "run_approval_resume",
      attemptId: "attempt_approval_resume",
      verified: true,
    });

    const resumeFailed = store.updateApprovalCheckpointStatus(
      checkpoint.id,
      {
        status: "resume_failed",
        runnerResumeHandle: null,
        resumeFailureReason: "Runner rejected resume handle.",
      },
      "2026-06-19T01:02:00.000Z",
    );

    assert.ok(resumeFailed);
    assert.equal(resumeFailed.status, "resume_failed");
    assert.equal(resumeFailed.runnerResumeHandle, undefined);
    assert.equal(resumeFailed.resumeFailureReason, "Runner rejected resume handle.");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite store persists one immutable approval resume basis with revision fencing", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-resume-basis-"));
  const now = "2026-08-15T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    store.createRun({
      id: "run_resume_basis",
      cwd,
      taskId: "task_resume_basis",
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: { id: "task_resume_basis", title: "Approval resume basis" },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const sideEffect = { type: "bash", cwd, command: "echo resume", riskFlags: [] };
    const approval = store.createApprovalRequest({
      runId: "run_resume_basis",
      taskId: "task_resume_basis",
      toolCallId: "tool_resume_basis",
      actionType: "bash",
      risk: "medium",
      title: "Approve resume",
      description: "echo resume",
      payload: sideEffect,
    }, now);
    const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
    assert.ok(checkpoint);
    assert.equal(checkpoint.revision, 0);

    const resumeBasis = createApprovalResumeBasisV1({
      approvalId: approval.id,
      runId: approval.runId,
      workUnitId: "work_unit_resume_basis",
      priorAttemptId: "attempt_resume_basis_1",
      workflowStepId: "workflow_step_resume_basis",
      toolCallId: approval.toolCallId,
      actionType: approval.actionType,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect,
      }),
      delegatedRequirementFingerprint: "requirement_resume_basis",
    });
    const bound = store.updateApprovalCheckpointStatus(checkpoint.id, {
      status: "pending",
      expectedStatus: "pending",
      expectedRevision: 0,
      resumeBasis,
    }, "2026-08-15T01:01:00.000Z");
    assert.ok(bound);
    assert.equal(bound.revision, 1);
    assert.deepEqual(bound.resumeBasis, resumeBasis);
    assert.equal(store.updateApprovalCheckpointStatus(checkpoint.id, {
      status: "resume_pending",
      expectedStatus: "pending",
      expectedRevision: 0,
    }, "2026-08-15T01:02:00.000Z"), undefined);

    const { schemaVersion: _schemaVersion, fingerprint: _fingerprint, ...resumeBasisInput } = resumeBasis;
    const changedBasis = createApprovalResumeBasisV1({
      ...resumeBasisInput,
      priorAttemptId: "attempt_resume_basis_2",
    });
    assert.throws(() => store.updateApprovalCheckpointStatus(checkpoint.id, {
      status: "resume_pending",
      expectedStatus: "pending",
      expectedRevision: 1,
      resumeBasis: changedBasis,
    }, "2026-08-15T01:03:00.000Z"), /resume basis is immutable/u);

    store.close();
    store = createSqliteRunStore(cwd);
    const reopened = store.getApprovalCheckpointForApproval(approval.id);
    assert.ok(reopened);
    assert.equal(reopened.revision, 1);
    assert.deepEqual(reopened.resumeBasis, resumeBasis);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("approval resume claim atomically binds the replacement Attempt and observer invalidations", async () => {
  const fixture = await createApprovalResumeClaimFixture("atomic-success");
  try {
    const result = fixture.store.commitApprovalResumeClaim(fixture.claim);
    assert.equal(result.ok, true);
    assert.equal(result.checkpoint.status, "resume_pending");
    assert.equal(result.checkpoint.revision, fixture.checkpoint.revision + 1);
    assert.equal(result.checkpoint.runnerResumeHandle?.attemptId, fixture.claim.replacementAttempt.id);
    assert.equal(result.run.status, "running");
    assert.equal(result.workUnit.status, "running");
    assert.equal(result.workUnit.activeAttemptId, fixture.claim.replacementAttempt.id);
    assert.equal(result.attempt.status, "started");
    assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "lost");
    assert.deepEqual(result.controlPlaneEvents.map((event) => event.domain), ["runs", "work_units", "approvals"]);
    assert.equal(result.controlPlaneEvents.every((event) => event.cwd === fixture.cwd), true);
    assert.equal(result.controlPlaneEvents.every((event) => Object.keys(event.data).length === 0), true);
    assert.equal(
      fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).filter((event) =>
        event.type === "work_unit_started" && event.attemptId === fixture.claim.replacementAttempt.id).length,
      1,
    );

    const duplicate = fixture.store.commitApprovalResumeClaim(fixture.claim);
    assert.deepEqual(duplicate, { ok: false, code: "approval_resume_checkpoint_stale" });
    assert.equal(fixture.store.listWorkUnitAttempts(fixture.workUnit.id).length, 2);
  } finally {
    await fixture.close();
  }
});

test("approval resume claim releases source capacity after a validated approved handoff", async () => {
  const fixture = await createApprovalResumeClaimFixture("approved-live-handoff");
  try {
    acquireApprovalResumeRuntimeResources(fixture, {
      run: fixture.run,
      workUnit: fixture.workUnit,
      attempt: fixture.priorAttempt,
    }, "2026-08-16T01:00:30.000Z");
    void fixture.store.trackHostAttemptCompletion({ runId: fixture.run.id, ...fixture.priorFence }, new Promise(() => {}));

    const claimed = fixture.store.commitApprovalResumeClaim(fixture.claim);

    assert.equal(claimed.ok, true);
    assert.equal(fixture.store.getHostAttemptCompletion({ runId: fixture.run.id, ...fixture.priorFence })?.drainedAt, undefined);
    assert.equal(fixture.store.listResourceLeases({ attemptId: fixture.priorAttempt.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ attemptId: fixture.priorAttempt.id, status: "released" }).length, 1);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: fixture.priorAttempt.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: fixture.priorAttempt.id, status: "released" }).length, 1);
  } finally {
    await fixture.close();
  }
});

test("approval resume claim preserves source capacity while a Host operation remains unresolved", async () => {
  const fixture = await createApprovalResumeClaimFixture("approved-blocked-handoff");
  try {
    acquireApprovalResumeRuntimeResources(fixture, {
      run: fixture.run,
      workUnit: fixture.workUnit,
      attempt: fixture.priorAttempt,
    }, "2026-08-16T01:00:30.000Z");
    const source = { runId: fixture.run.id, ...fixture.priorFence };
    void fixture.store.trackHostAttemptCompletion(source, new Promise(() => {}));
    fixture.store.admitHostOperation({
      operationId: "operation-approved-blocked-handoff",
      source,
      kind: "command",
      toolCallId: fixture.approval.toolCallId,
      admittedAt: "2026-08-16T01:00:40.000Z",
    });

    const claimed = fixture.store.commitApprovalResumeClaim(fixture.claim);

    assert.equal(claimed.ok, true);
    assert.equal(fixture.store.listHostOperationBlockers(source, fixture.claim.now).length, 1);
    assert.equal(fixture.store.listResourceLeases({ attemptId: fixture.priorAttempt.id, status: "active" }).length, 1);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: fixture.priorAttempt.id, status: "active" }).length, 1);
  } finally {
    await fixture.close();
  }
});

test("approval resume claim rolls back every durable write boundary", async (t) => {
  const faults = [
    {
      name: "checkpoint",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_checkpoint AFTER UPDATE OF status ON approval_checkpoints
        WHEN NEW.id = '${fixture.checkpoint.id}' AND NEW.status = 'resume_pending'
        BEGIN SELECT RAISE(ABORT, 'resume checkpoint fault'); END
      `,
    },
    {
      name: "attempt",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_attempt AFTER INSERT ON work_unit_attempts
        WHEN NEW.id = '${fixture.claim.replacementAttempt.id}'
        BEGIN SELECT RAISE(ABORT, 'resume attempt fault'); END
      `,
    },
    {
      name: "work-unit",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_work_unit AFTER UPDATE OF active_attempt_id ON work_units
        WHEN NEW.id = '${fixture.workUnit.id}' AND NEW.active_attempt_id = '${fixture.claim.replacementAttempt.id}'
        BEGIN SELECT RAISE(ABORT, 'resume work unit fault'); END
      `,
    },
    {
      name: "run",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_run AFTER UPDATE OF status ON run_sessions
        WHEN NEW.id = '${fixture.run.id}' AND NEW.status = 'running'
        BEGIN SELECT RAISE(ABORT, 'resume run fault'); END
      `,
    },
    {
      name: "runtime-audit",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_runtime AFTER INSERT ON runtime_events
        WHEN NEW.attempt_id = '${fixture.claim.replacementAttempt.id}' AND NEW.type = 'work_unit_started'
        BEGIN SELECT RAISE(ABORT, 'resume runtime fault'); END
      `,
    },
    {
      name: "control-plane",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_control AFTER INSERT ON control_plane_events
        WHEN NEW.idempotency_key LIKE 'approval-resume-claim:%'
        BEGIN SELECT RAISE(ABORT, 'resume control fault'); END
      `,
    },
  ];

  for (const fault of faults) {
    await t.test(fault.name, async () => {
      const fixture = await createApprovalResumeClaimFixture(`rollback-${fault.name}`);
      try {
        const database = new DatabaseSync(fixture.store.paths.databasePath);
        try {
          database.exec(fault.trigger(fixture));
        } finally {
          database.close();
        }
        assert.throws(() => fixture.store.commitApprovalResumeClaim(fixture.claim), /resume .* fault/u);

        const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
        const run = fixture.store.getRun(fixture.run.id);
        const workUnit = fixture.store.getWorkUnit(fixture.workUnit.id);
        assert.equal(checkpoint?.status, "approved");
        assert.equal(checkpoint?.revision, fixture.checkpoint.revision);
        assert.equal(checkpoint?.runnerResumeHandle, undefined);
        assert.equal(run?.status, "waiting_for_approval");
        assert.equal(workUnit?.status, "waiting_for_approval");
        assert.equal(workUnit?.activeAttemptId, fixture.priorAttempt.id);
        assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "waiting_for_approval");
        assert.equal(fixture.store.getWorkUnitAttempt(fixture.claim.replacementAttempt.id), undefined);
        assert.equal(fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length, 0);
        assertApprovalResumeConnectionReusable(fixture, `claim-${fault.name}`);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("approval resume claim atomically prepares the Harness continuation and Attempt", async () => {
  const fixture = await createApprovalResumeClaimFixture("harness-atomic");
  try {
    const attemptId = "attempt_resume_claim_harness_atomic_2";
    const artifact = fixture.store.createArtifact({
      id: "artifact_resume_claim_harness_atomic",
      runId: fixture.run.id,
      type: "json",
      path: `${fixture.run.id}/continuation.json`,
      contentType: "application/vnd.ling.runner-continuation-replay+json",
      sealedPayload: { schemaVersion: 1, runId: fixture.run.id },
      createdAt: fixture.claim.now,
    });
    const { replacementAttempt: _replacementAttempt, ...claimBase } = fixture.claim;
    const claim = {
      ...claimBase,
      continuationPreparation: {
        runId: fixture.run.id,
        workUnitId: fixture.workUnit.id,
        sourceFence: fixture.priorFence,
        expectedTargetAttemptId: fixture.priorAttempt.id,
        origin: "approval_resume",
        strategy: "deterministic_replay",
        runnerId: "pi",
        runnerCapabilityRevision: "pi:test",
        contextViewId: fixture.run.contextViewId,
        contextSnapshotArtifactId: artifact.id,
        idempotencyKey: `runner-continuation:${fixture.run.id}:${fixture.priorAttempt.id}:approval_resume:0:${fixture.approval.id}`,
        generation: 0,
        targetAttempt: {
          id: attemptId,
          runtimeInstanceId: "runtime_after_restart",
          runnerId: "pi",
          effectiveRunnerId: "pi",
        },
        now: fixture.claim.now,
      },
      runnerResumeHandle: { ...fixture.claim.runnerResumeHandle, attemptId },
    };
    const result = fixture.store.commitApprovalResumeClaim(claim);
    assert.equal(result.ok, true);
    assert.equal(result.attempt.id, attemptId);
    assert.equal(result.attempt.status, "created");
    assert.equal(result.runnerContinuation?.state, "prepared");
    assert.equal(result.runnerContinuation?.targetAttemptId, attemptId);
    assert.equal(result.workUnit.activeAttemptId, attemptId);
    assert.equal(result.checkpoint.status, "resume_pending");
    assert.equal(
      fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).some((event) =>
        event.type === "work_unit_started" && event.attemptId === attemptId),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("approval resume rolls back Harness continuation preparation with the checkpoint CAS", async () => {
  const fixture = await createApprovalResumeClaimFixture("harness-rollback");
  try {
    const attemptId = "attempt_resume_claim_harness_rollback_2";
    const artifact = fixture.store.createArtifact({
      id: "artifact_resume_claim_harness_rollback",
      runId: fixture.run.id,
      type: "json",
      path: `${fixture.run.id}/continuation.json`,
      contentType: "application/vnd.ling.runner-continuation-replay+json",
      sealedPayload: { schemaVersion: 1, runId: fixture.run.id },
      createdAt: fixture.claim.now,
    });
    const { replacementAttempt: _replacementAttempt, ...claimBase } = fixture.claim;
    const idempotencyKey = `runner-continuation:${fixture.run.id}:${fixture.priorAttempt.id}:approval_resume:0:${fixture.approval.id}`;
    const claim = {
      ...claimBase,
      continuationPreparation: {
        runId: fixture.run.id,
        workUnitId: fixture.workUnit.id,
        sourceFence: fixture.priorFence,
        expectedTargetAttemptId: fixture.priorAttempt.id,
        origin: "approval_resume",
        strategy: "deterministic_replay",
        runnerId: "pi",
        runnerCapabilityRevision: "pi:test",
        contextViewId: fixture.run.contextViewId,
        contextSnapshotArtifactId: artifact.id,
        idempotencyKey,
        generation: 0,
        targetAttempt: {
          id: attemptId,
          runtimeInstanceId: "runtime_after_restart",
          runnerId: "pi",
          effectiveRunnerId: "pi",
        },
        now: fixture.claim.now,
      },
      runnerResumeHandle: { ...fixture.claim.runnerResumeHandle, attemptId },
    };
    const database = new DatabaseSync(fixture.store.paths.databasePath);
    try {
      database.exec(`
        CREATE TRIGGER fail_harness_resume_checkpoint AFTER UPDATE OF status ON approval_checkpoints
        WHEN NEW.id = '${fixture.checkpoint.id}' AND NEW.status = 'resume_pending'
        BEGIN SELECT RAISE(ABORT, 'harness resume checkpoint fault'); END
      `);
    } finally {
      database.close();
    }
    assert.throws(() => fixture.store.commitApprovalResumeClaim(claim), /harness resume checkpoint fault/u);
    assert.equal(fixture.store.findRunnerContinuationByIdempotencyKey(idempotencyKey), undefined);
    assert.equal(fixture.store.getWorkUnitAttempt(attemptId), undefined);
    assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.activeAttemptId, fixture.priorAttempt.id);
    assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "approved");
  } finally {
    await fixture.close();
  }
});

test("approval wait suspension atomically preserves pending and approved logical work", async (t) => {
  for (const expectedCheckpointStatus of ["pending", "approved"]) {
    await t.test(expectedCheckpointStatus, async () => {
      const fixture = await createApprovalResumeClaimFixture(
        `approval-wait-${expectedCheckpointStatus}`,
        { approve: expectedCheckpointStatus === "approved" },
      );
      try {
        const lifecycle = {
          checkpoint: fixture.checkpoint,
          run: fixture.run,
          workUnit: fixture.workUnit,
          attempt: fixture.priorAttempt,
        };
        acquireApprovalResumeRuntimeResources(fixture, lifecycle);

        const suspended = fixture.store.commitApprovalResumeSuspension({
          kind: "approval_wait",
          checkpointId: fixture.checkpoint.id,
          expectedCheckpointStatus,
          expectedCheckpointRevision: fixture.checkpoint.revision,
          approvalId: fixture.claim.approvalId,
          runId: fixture.run.id,
          expectedRunStatus: "waiting_for_approval",
          workUnitId: fixture.workUnit.id,
          expectedWorkUnitStatus: "waiting_for_approval",
          attemptId: fixture.priorAttempt.id,
          cause: "daemon_restart",
          now: "2026-08-16T01:01:30.000Z",
        });

        assert.equal(suspended.ok, true);
        assert.equal(suspended.checkpoint.status, expectedCheckpointStatus);
        assert.equal(suspended.checkpoint.revision, fixture.checkpoint.revision + 1);
        assert.equal(suspended.run.status, "waiting_for_approval");
        assert.equal(suspended.workUnit.status, "waiting_for_approval");
        assert.equal(suspended.workUnit.activeAttemptId, fixture.priorAttempt.id);
        assert.equal(suspended.attempt.status, "lost");
        assert.equal(fixture.store.getApprovalRequest(fixture.claim.approvalId)?.status, expectedCheckpointStatus);
        assert.equal(fixture.store.getTask(fixture.task.id)?.status, "running");
        assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: fixture.run.id, status: "active" }).length, 0);
        assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: fixture.priorAttempt.id, status: "active" }).length, 0);
        assert.deepEqual(suspended.controlPlaneEvents.map((event) => event.domain), ["runs", "work_units", "approvals"]);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("approval wait suspension rejects illegal lifecycle cross-products before writing", async () => {
  const fixture = await createApprovalResumeClaimFixture("approval-wait-invalid-shape", { approve: false });
  try {
    const checkpoint = fixture.store.getApprovalCheckpoint(fixture.checkpoint.id);
    const attempt = fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id);
    const runtimeEventCount = fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).length;
    const controlPlaneEventCount = fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length;

    assert.throws(() => fixture.store.commitApprovalResumeSuspension({
      kind: "approval_wait",
      checkpointId: fixture.checkpoint.id,
      expectedCheckpointStatus: "pending",
      expectedCheckpointRevision: fixture.checkpoint.revision,
      approvalId: fixture.claim.approvalId,
      runId: fixture.run.id,
      expectedRunStatus: "running",
      workUnitId: fixture.workUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: fixture.priorAttempt.id,
      cause: "invalid-shape",
      now: "2026-08-16T01:01:40.000Z",
    }), /suspension lifecycle shape is invalid/u);

    assert.deepEqual(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id), checkpoint);
    assert.deepEqual(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id), attempt);
    assert.equal(fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).length, runtimeEventCount);
    assert.equal(
      fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length,
      controlPlaneEventCount,
    );
  } finally {
    await fixture.close();
  }
});

test("approval wait suspension rolls back every durable write boundary", async (t) => {
  for (const fault of approvalResumeSuspensionFaults()) {
    await t.test(fault.name, async () => {
      const fixture = await createApprovalResumeClaimFixture(`approval-wait-rollback-${fault.name}`, { approve: false });
      try {
        const lifecycle = {
          checkpoint: fixture.checkpoint,
          run: fixture.run,
          workUnit: fixture.workUnit,
          attempt: fixture.priorAttempt,
        };
        acquireApprovalResumeRuntimeResources(fixture, lifecycle);
        const runtimeEventCount = fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).length;
        const controlPlaneEventCount = fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length;
        const database = new DatabaseSync(fixture.store.paths.databasePath);
        try {
          database.exec(fault.trigger(fixture, lifecycle));
        } finally {
          database.close();
        }

        assert.throws(() => fixture.store.commitApprovalResumeSuspension({
          kind: "approval_wait",
          checkpointId: fixture.checkpoint.id,
          expectedCheckpointStatus: "pending",
          expectedCheckpointRevision: fixture.checkpoint.revision,
          approvalId: fixture.claim.approvalId,
          runId: fixture.run.id,
          expectedRunStatus: "waiting_for_approval",
          workUnitId: fixture.workUnit.id,
          expectedWorkUnitStatus: "waiting_for_approval",
          attemptId: fixture.priorAttempt.id,
          cause: "daemon_restart",
          now: "2026-08-16T01:01:50.000Z",
        }), /resume suspension .* fault/u);

        assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.revision, fixture.checkpoint.revision);
        assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "pending");
        assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
        assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "waiting_for_approval");
        assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "waiting_for_approval");
        assert.equal(fixture.store.getTask(fixture.task.id)?.status, "running");
        assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: fixture.run.id, status: "active" }).length, 1);
        assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: fixture.priorAttempt.id, status: "active" }).length, 1);
        assert.equal(fixture.store.listRuntimeEvents(fixture.workUnit.id, { limit: 100 }).length, runtimeEventCount);
        assert.equal(
          fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length,
          controlPlaneEventCount,
        );
        assertApprovalResumeConnectionReusable(fixture, `approval-wait-suspension-${fault.name}`);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("approval resume suspension atomically preserves logical work and releases runtime capacity", async () => {
  const fixture = await createApprovalResumeClaimFixture("suspension-success");
  try {
    const claim = fixture.store.commitApprovalResumeClaim(fixture.claim);
    assert.equal(claim.ok, true);
    acquireApprovalResumeRuntimeResources(fixture, claim);

    const suspended = fixture.store.commitApprovalResumeSuspension({
      kind: "resume_pre_dispatch",
      checkpointId: claim.checkpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: claim.checkpoint.revision,
      approvalId: fixture.claim.approvalId,
      runId: claim.run.id,
      expectedRunStatus: "running",
      workUnitId: claim.workUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: claim.attempt.id,
      cause: "daemon_restart",
      now: "2026-08-16T01:03:00.000Z",
    });

    assert.equal(suspended.ok, true);
    assert.equal(suspended.checkpoint.status, "resume_pending");
    assert.equal(suspended.checkpoint.revision, claim.checkpoint.revision + 1);
    assert.equal(suspended.run.status, "running");
    assert.equal(suspended.workUnit.status, "running");
    assert.equal(suspended.workUnit.activeAttemptId, claim.attempt.id);
    assert.equal(suspended.attempt.status, "lost");
    assert.equal(fixture.store.getTask(fixture.task.id)?.status, "running");
    assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: claim.run.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: claim.run.id, status: "released" }).length, 1);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: claim.attempt.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: claim.attempt.id, status: "released" }).length, 1);
    assert.deepEqual(suspended.controlPlaneEvents.map((event) => event.domain), ["runs", "work_units", "approvals"]);
    assert.equal(fixture.store.listRuntimeEvents(claim.workUnit.id, { limit: 100 }).some((event) =>
      event.type === "work_unit_stale" && event.attemptId === claim.attempt.id), true);
  } finally {
    await fixture.close();
  }
});

test("approval resume suspension rolls back every durable write boundary", async (t) => {
  const faults = approvalResumeSuspensionFaults();

  for (const fault of faults) {
    await t.test(fault.name, async () => {
      const fixture = await createApprovalResumeClaimFixture(`suspension-rollback-${fault.name}`);
      try {
        const claim = fixture.store.commitApprovalResumeClaim(fixture.claim);
        assert.equal(claim.ok, true);
        acquireApprovalResumeRuntimeResources(fixture, claim);
        const controlEventCount = fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length;
        const runtimeEventCount = fixture.store.listRuntimeEvents(claim.workUnit.id, { limit: 100 }).length;
        const database = new DatabaseSync(fixture.store.paths.databasePath);
        try {
          database.exec(fault.trigger(fixture, claim));
        } finally {
          database.close();
        }

        assert.throws(() => fixture.store.commitApprovalResumeSuspension({
          kind: "resume_pre_dispatch",
          checkpointId: claim.checkpoint.id,
          expectedCheckpointStatus: "resume_pending",
          expectedCheckpointRevision: claim.checkpoint.revision,
          approvalId: fixture.claim.approvalId,
          runId: claim.run.id,
          expectedRunStatus: "running",
          workUnitId: claim.workUnit.id,
          expectedWorkUnitStatus: "running",
          attemptId: claim.attempt.id,
          cause: "daemon_restart",
          now: "2026-08-16T01:03:00.000Z",
        }), /resume suspension .* fault/u);

        assert.equal(fixture.store.getApprovalCheckpoint(claim.checkpoint.id)?.revision, claim.checkpoint.revision);
        assert.equal(fixture.store.getApprovalCheckpoint(claim.checkpoint.id)?.status, "resume_pending");
        assert.equal(fixture.store.getRun(claim.run.id)?.status, "running");
        assert.equal(fixture.store.getWorkUnit(claim.workUnit.id)?.status, "running");
        assert.equal(fixture.store.getWorkUnitAttempt(claim.attempt.id)?.status, "started");
        assert.equal(fixture.store.getTask(fixture.task.id)?.status, "running");
        assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: claim.run.id, status: "active" }).length, 1);
        assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: claim.attempt.id, status: "active" }).length, 1);
        assert.equal(fixture.store.listRuntimeEvents(claim.workUnit.id, { limit: 100 }).length, runtimeEventCount);
        assert.equal(
          fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length,
          controlEventCount,
        );
        assertApprovalResumeConnectionReusable(fixture, `resume-suspension-${fault.name}`);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("approval resume terminal settlement atomically closes checkpoint, runtime, task, and capacity", async () => {
  const fixture = await createApprovalResumeClaimFixture("terminal-success");
  try {
    const claim = fixture.store.commitApprovalResumeClaim(fixture.claim);
    assert.equal(claim.ok, true);
    acquireApprovalResumeRuntimeResources(fixture, claim);

    const terminal = fixture.store.commitApprovalResumeTerminal({
      kind: "verified_lineage",
      checkpointId: claim.checkpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: claim.checkpoint.revision,
      approvalId: fixture.claim.approvalId,
      runId: claim.run.id,
      expectedRunStatus: "running",
      workUnitId: claim.workUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: claim.attempt.id,
      status: "succeeded",
      attemptStatus: "succeeded",
      checkpointStatus: "resumed",
      summaryPath: resolve(fixture.cwd, "summary.md"),
      now: "2026-08-16T01:04:00.000Z",
    });

    assert.equal(terminal.ok, true);
    assert.equal(terminal.checkpoint.status, "resumed");
    assert.equal(terminal.run.status, "succeeded");
    assert.equal(terminal.workUnit.status, "succeeded");
    assert.equal(terminal.attempt.status, "succeeded");
    assert.equal(fixture.store.getTask(fixture.task.id)?.status, "done");
    assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: claim.run.id, status: "active" }).length, 0);
    assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: claim.attempt.id, status: "active" }).length, 0);
    assert.deepEqual(terminal.controlPlaneEvents.map((event) => event.domain), ["runs", "work_units", "approvals"]);
    assert.deepEqual(fixture.store.commitApprovalResumeTerminal({
      kind: "verified_lineage",
      checkpointId: claim.checkpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: claim.checkpoint.revision,
      approvalId: fixture.claim.approvalId,
      runId: claim.run.id,
      expectedRunStatus: "running",
      workUnitId: claim.workUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: claim.attempt.id,
      status: "succeeded",
      attemptStatus: "succeeded",
      checkpointStatus: "resumed",
      now: "2026-08-16T01:04:00.000Z",
    }), { ok: false, code: "approval_resume_terminal_stale" });
  } finally {
    await fixture.close();
  }
});

test("approval resume terminal blocker preserves the detailed checkpoint failure reason", async () => {
  const fixture = await createApprovalResumeClaimFixture("terminal-detailed-blocker");
  try {
    const claim = fixture.store.commitApprovalResumeClaim(fixture.claim);
    assert.equal(claim.ok, true);
    acquireApprovalResumeRuntimeResources(fixture, claim);

    const terminal = fixture.store.commitApprovalResumeTerminal({
      kind: "verified_lineage",
      checkpointId: claim.checkpoint.id,
      expectedCheckpointStatus: "resume_pending",
      expectedCheckpointRevision: claim.checkpoint.revision,
      approvalId: fixture.claim.approvalId,
      runId: claim.run.id,
      expectedRunStatus: "running",
      workUnitId: claim.workUnit.id,
      expectedWorkUnitStatus: "running",
      attemptId: claim.attempt.id,
      status: "failed",
      attemptStatus: "failed",
      checkpointStatus: "resume_failed",
      errorCode: "approval_resume_unsupported",
      errorMessage: "approval_resume_unsupported:file_write",
      now: "2026-08-16T01:04:30.000Z",
    });

    assert.equal(terminal.ok, true);
    assert.equal(terminal.checkpoint.resumeFailureReason, "approval_resume_unsupported:file_write");
    assert.equal(terminal.run.errorMessage, "approval_resume_unsupported:file_write");
  } finally {
    await fixture.close();
  }
});

test("approval resume terminal settlement rolls back every durable write boundary", async (t) => {
  const faults = [
    {
      name: "checkpoint",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_terminal_checkpoint AFTER UPDATE OF status ON approval_checkpoints
        WHEN NEW.id = '${fixture.checkpoint.id}' AND NEW.status = 'resumed'
        BEGIN SELECT RAISE(ABORT, 'resume terminal checkpoint fault'); END
      `,
    },
    {
      name: "run",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_terminal_run AFTER UPDATE OF status ON run_sessions
        WHEN NEW.id = '${claim.run.id}' AND NEW.status = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'resume terminal run fault'); END
      `,
    },
    {
      name: "work-unit",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_terminal_work_unit AFTER UPDATE OF status ON work_units
        WHEN NEW.id = '${claim.workUnit.id}' AND NEW.status = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'resume terminal work unit fault'); END
      `,
    },
    {
      name: "attempt",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_terminal_attempt AFTER UPDATE OF status ON work_unit_attempts
        WHEN NEW.id = '${claim.attempt.id}' AND NEW.status = 'succeeded'
        BEGIN SELECT RAISE(ABORT, 'resume terminal attempt fault'); END
      `,
    },
    {
      name: "task",
      trigger: (fixture) => `
        CREATE TRIGGER fail_resume_terminal_task AFTER UPDATE OF status ON tasks
        WHEN NEW.id = '${fixture.task.id}' AND NEW.status = 'done'
        BEGIN SELECT RAISE(ABORT, 'resume terminal task fault'); END
      `,
    },
    {
      name: "runtime-audit",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_terminal_runtime AFTER INSERT ON runtime_events
        WHEN NEW.attempt_id = '${claim.attempt.id}' AND NEW.type = 'work_unit_succeeded'
        BEGIN SELECT RAISE(ABORT, 'resume terminal runtime fault'); END
      `,
    },
    {
      name: "resource-lease",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_terminal_lease AFTER UPDATE OF status ON resource_leases
        WHEN NEW.owner_type = 'run' AND NEW.owner_id = '${claim.run.id}' AND NEW.status = 'released'
        BEGIN SELECT RAISE(ABORT, 'resume terminal lease fault'); END
      `,
    },
    {
      name: "semaphore",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_terminal_semaphore AFTER UPDATE OF status ON runtime_semaphore_slots
        WHEN NEW.owner_id = '${claim.attempt.id}' AND NEW.status = 'released'
        BEGIN SELECT RAISE(ABORT, 'resume terminal semaphore fault'); END
      `,
    },
    {
      name: "control-plane",
      trigger: () => `
        CREATE TRIGGER fail_resume_terminal_control AFTER INSERT ON control_plane_events
        WHEN NEW.idempotency_key LIKE 'approval-resume-terminal:%'
        BEGIN SELECT RAISE(ABORT, 'resume terminal control fault'); END
      `,
    },
  ];

  for (const fault of faults) {
    await t.test(fault.name, async () => {
      const fixture = await createApprovalResumeClaimFixture(`terminal-rollback-${fault.name}`);
      try {
        const claim = fixture.store.commitApprovalResumeClaim(fixture.claim);
        assert.equal(claim.ok, true);
        acquireApprovalResumeRuntimeResources(fixture, claim);
        const controlEventCount = fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length;
        const runtimeEventCount = fixture.store.listRuntimeEvents(claim.workUnit.id, { limit: 100 }).length;
        const database = new DatabaseSync(fixture.store.paths.databasePath);
        try {
          database.exec(fault.trigger(fixture, claim));
        } finally {
          database.close();
        }

        assert.throws(() => fixture.store.commitApprovalResumeTerminal({
          kind: "verified_lineage",
          checkpointId: claim.checkpoint.id,
          expectedCheckpointStatus: "resume_pending",
          expectedCheckpointRevision: claim.checkpoint.revision,
          approvalId: fixture.claim.approvalId,
          runId: claim.run.id,
          expectedRunStatus: "running",
          workUnitId: claim.workUnit.id,
          expectedWorkUnitStatus: "running",
          attemptId: claim.attempt.id,
          status: "succeeded",
          attemptStatus: "succeeded",
          checkpointStatus: "resumed",
          now: "2026-08-16T01:04:00.000Z",
        }), /resume terminal .* fault/u);

        assert.equal(fixture.store.getApprovalCheckpoint(claim.checkpoint.id)?.status, "resume_pending");
        assert.equal(fixture.store.getApprovalCheckpoint(claim.checkpoint.id)?.revision, claim.checkpoint.revision);
        assert.equal(fixture.store.getRun(claim.run.id)?.status, "running");
        assert.equal(fixture.store.getWorkUnit(claim.workUnit.id)?.status, "running");
        assert.equal(fixture.store.getWorkUnitAttempt(claim.attempt.id)?.status, "started");
        assert.equal(fixture.store.getTask(fixture.task.id)?.status, "running");
        assert.equal(fixture.store.listResourceLeases({ ownerType: "run", ownerId: claim.run.id, status: "active" }).length, 1);
        assert.equal(fixture.store.listRuntimeSemaphoreSlots({ ownerId: claim.attempt.id, status: "active" }).length, 1);
        assert.equal(fixture.store.listRuntimeEvents(claim.workUnit.id, { limit: 100 }).length, runtimeEventCount);
        assert.equal(
          fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length,
          controlEventCount,
        );
        assertApprovalResumeConnectionReusable(fixture, `terminal-${fault.name}`);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("approval resume checkpoint quarantine blocks corrupt lineage without terminalizing guessed runtime rows", async () => {
  const fixture = await createApprovalResumeClaimFixture("checkpoint-quarantine");
  try {
    const quarantined = fixture.store.commitApprovalResumeTerminal({
      kind: "checkpoint_quarantine",
      checkpointId: fixture.checkpoint.id,
      expectedCheckpointStatus: "approved",
      expectedCheckpointRevision: fixture.checkpoint.revision,
      approvalId: fixture.claim.approvalId,
      errorCode: "approval_resume_lineage_invalid",
      errorMessage: "approval_resume_lineage_invalid:work_unit_mismatch",
      now: "2026-08-16T01:04:00.000Z",
    });

    assert.equal(quarantined.ok, true);
    assert.equal(quarantined.kind, "checkpoint_quarantine");
    assert.equal(quarantined.checkpoint.status, "resume_failed");
    assert.equal(quarantined.checkpoint.resumeFailureReason, "approval_resume_lineage_invalid:work_unit_mismatch");
    assert.deepEqual(quarantined.controlPlaneEvents.map((event) => event.domain), ["approvals"]);
    assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnit(fixture.workUnit.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getWorkUnitAttempt(fixture.priorAttempt.id)?.status, "waiting_for_approval");
    assert.equal(fixture.store.getTask(fixture.task.id)?.status, "running");
  } finally {
    await fixture.close();
  }
});

test("approval resume checkpoint quarantine rolls back checkpoint and invalidation together", async (t) => {
  for (const fault of ["checkpoint", "control-plane"]) {
    await t.test(fault, async () => {
      const fixture = await createApprovalResumeClaimFixture(`checkpoint-quarantine-${fault}`);
      try {
        const database = new DatabaseSync(fixture.store.paths.databasePath);
        try {
          database.exec(fault === "checkpoint"
            ? `
              CREATE TRIGGER fail_resume_quarantine_checkpoint AFTER UPDATE OF status ON approval_checkpoints
              WHEN NEW.id = '${fixture.checkpoint.id}' AND NEW.status = 'resume_failed'
              BEGIN SELECT RAISE(ABORT, 'resume quarantine checkpoint fault'); END
            `
            : `
              CREATE TRIGGER fail_resume_quarantine_control AFTER INSERT ON control_plane_events
              WHEN NEW.idempotency_key LIKE 'approval-resume-quarantine:%'
              BEGIN SELECT RAISE(ABORT, 'resume quarantine control fault'); END
            `);
        } finally {
          database.close();
        }
        assert.throws(() => fixture.store.commitApprovalResumeTerminal({
          kind: "checkpoint_quarantine",
          checkpointId: fixture.checkpoint.id,
          expectedCheckpointStatus: "approved",
          expectedCheckpointRevision: fixture.checkpoint.revision,
          approvalId: fixture.claim.approvalId,
          errorCode: "approval_resume_lineage_invalid",
          errorMessage: "approval_resume_lineage_invalid",
          now: "2026-08-16T01:04:00.000Z",
        }), /resume quarantine .* fault/u);
        assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.status, "approved");
        assert.equal(fixture.store.getApprovalCheckpoint(fixture.checkpoint.id)?.revision, fixture.checkpoint.revision);
        assert.equal(fixture.store.listControlPlaneEvents({ workspaceId: "workspace_default", limit: 100 }).length, 0);
        assert.equal(fixture.store.getRun(fixture.run.id)?.status, "waiting_for_approval");
        assertApprovalResumeConnectionReusable(fixture, `quarantine-${fault}`);
      } finally {
        await fixture.close();
      }
    });
  }
});

function assertApprovalResumeConnectionReusable(fixture, suffix) {
  const event = fixture.store.appendControlPlaneEvent({
    workspaceId: "workspace_default",
    cwd: fixture.cwd,
    domain: "approvals",
    entityType: "approval",
    entityId: fixture.claim.approvalId,
    action: "approval.rollback_recovery_probe",
    data: {},
    idempotencyKey: `approval-resume-rollback-recovery:${suffix}`,
  }, "2026-08-16T01:05:00.000Z");
  assert.equal(event.entityId, fixture.claim.approvalId);
}

function acquireApprovalResumeRuntimeResources(fixture, claim, acquiredAt = "2026-08-16T01:02:10.000Z") {
  assert.ok(fixture.store.acquireResourceLease({
    workspaceId: "workspace_default",
    resourceType: "bound_path",
    resourceKey: fixture.cwd,
    ownerType: "run",
    ownerId: claim.run.id,
    workUnitId: claim.workUnit.id,
    attemptId: claim.attempt.id,
    runtimeInstanceId: claim.attempt.runtimeInstanceId,
    fencingToken: claim.attempt.fencingToken,
    acquiredAt,
    expiresAt: "2026-08-16T02:02:10.000Z",
  }));
  assert.ok(fixture.store.acquireRuntimeSemaphoreSlot({
    workspaceId: "workspace_default",
    resourceType: "runner",
    resourceKey: "pi",
    limit: 4,
    ownerType: "work_unit_attempt",
    ownerId: claim.attempt.id,
    workUnitId: claim.workUnit.id,
    attemptId: claim.attempt.id,
    runtimeInstanceId: claim.attempt.runtimeInstanceId,
    fencingToken: claim.attempt.fencingToken,
    acquiredAt,
    expiresAt: "2026-08-16T02:02:10.000Z",
  }));
}

function approvalResumeSuspensionFaults() {
  return [
    {
      name: "checkpoint",
      trigger: (fixture, claim) => `
        CREATE TRIGGER fail_resume_suspend_checkpoint AFTER UPDATE OF revision ON approval_checkpoints
        WHEN NEW.id = '${fixture.checkpoint.id}' AND NEW.revision > ${claim.checkpoint.revision}
        BEGIN SELECT RAISE(ABORT, 'resume suspension checkpoint fault'); END
      `,
    },
    {
      name: "attempt",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_suspend_attempt AFTER UPDATE OF status ON work_unit_attempts
        WHEN NEW.id = '${claim.attempt.id}' AND NEW.status = 'lost'
        BEGIN SELECT RAISE(ABORT, 'resume suspension attempt fault'); END
      `,
    },
    {
      name: "resource-lease",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_suspend_lease AFTER UPDATE OF status ON resource_leases
        WHEN NEW.owner_type = 'run' AND NEW.owner_id = '${claim.run.id}' AND NEW.status = 'released'
        BEGIN SELECT RAISE(ABORT, 'resume suspension lease fault'); END
      `,
    },
    {
      name: "semaphore",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_suspend_semaphore AFTER UPDATE OF status ON runtime_semaphore_slots
        WHEN NEW.owner_id = '${claim.attempt.id}' AND NEW.status = 'released'
        BEGIN SELECT RAISE(ABORT, 'resume suspension semaphore fault'); END
      `,
    },
    {
      name: "runtime-audit",
      trigger: (_fixture, claim) => `
        CREATE TRIGGER fail_resume_suspend_runtime AFTER INSERT ON runtime_events
        WHEN NEW.attempt_id = '${claim.attempt.id}' AND NEW.type = 'work_unit_stale'
        BEGIN SELECT RAISE(ABORT, 'resume suspension runtime fault'); END
      `,
    },
    {
      name: "control-plane",
      trigger: () => `
        CREATE TRIGGER fail_resume_suspend_control AFTER INSERT ON control_plane_events
        WHEN NEW.idempotency_key LIKE 'approval-resume-suspend:%'
        BEGIN SELECT RAISE(ABORT, 'resume suspension control fault'); END
      `,
    },
  ];
}

async function createApprovalResumeClaimFixture(suffix, options = {}) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-core-approval-resume-claim-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-16T01:00:00.000Z";
  const channel = store.createChannel({ name: `Approval resume ${suffix}`, boundPath: cwd }, now);
  const task = store.createTask({
    channelId: channel.id,
    title: "Atomic resume claim",
    prompt: "Resume the approved command.",
  }, now);
  const run = store.createRun({
    id: `run_resume_claim_${suffix}`,
    cwd,
    taskId: task.id,
    channelId: channel.id,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: task,
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd },
    contextViewId: `context_resume_claim_${suffix}`,
    contextViewCreatedAt: now,
    createdAt: now,
  });
  assert.equal(store.transitionTaskStatus({
    taskId: task.id,
    expectedStatus: "todo",
    event: "claim",
    actor: "system",
    reason: `run:${run.id}`,
    now,
  }).ok, true);
  assert.equal(store.transitionTaskStatus({
    taskId: task.id,
    expectedStatus: "claimed",
    event: "start_run",
    actor: "system",
    reason: `run:${run.id}`,
    currentRunId: run.id,
    now,
  }).ok, true);
  store.markRunStarted(run.id, now);
  const workUnit = store.createWorkUnit({
    id: `work_unit_resume_claim_${suffix}`,
    workspaceId: "workspace_default",
    kind: "task_run",
    ownerType: "run",
    ownerId: run.id,
    channelId: channel.id,
    taskId: task.id,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    idempotencyKey: `resume-claim-${suffix}`,
    createdByActor: "system",
    request: { runId: run.id },
    linkedRunId: run.id,
    now,
  });
  const priorAttempt = store.createWorkUnitAttempt({
    id: `attempt_resume_claim_${suffix}_1`,
    workUnitId: workUnit.id,
    attemptNumber: 1,
    runtimeInstanceId: "runtime_before_restart",
    runnerId: "pi",
    effectiveRunnerId: "pi",
    now,
  });
  store.linkRunToWorkUnit(run.id, workUnit.id, now);
  const priorFence = {
    workUnitId: workUnit.id,
    attemptId: priorAttempt.id,
    runtimeInstanceId: priorAttempt.runtimeInstanceId,
    fencingToken: priorAttempt.fencingToken,
  };
  store.transitionWorkUnitStatus({ ...priorFence, activeAttemptId: priorAttempt.id, expectedStatus: "queued", event: "claim", actor: "system", now });
  store.transitionWorkUnitStatus({ ...priorFence, expectedStatus: "claimed", event: "runner_started", actor: "runner", now });
  store.transitionWorkUnitStatus({ ...priorFence, expectedStatus: "running", event: "approval_requested", actor: "system", now });
  store.updateWorkUnitAttemptStatus({ ...priorFence, status: "waiting_for_approval", now });
  store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "approval_requested", actor: "system", now });
  const sideEffect = { type: "bash", cwd, command: "echo atomic-resume", riskFlags: [] };
  const approval = store.createApprovalRequest({
    runId: run.id,
    taskId: run.taskId,
    toolCallId: `tool_resume_claim_${suffix}`,
    actionType: "bash",
    risk: "medium",
    title: "Approve atomic resume",
    description: "echo atomic-resume",
    payload: sideEffect,
  }, now);
  const initialCheckpoint = store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(initialCheckpoint);
  const resumeBasis = createApprovalResumeBasisV1({
    approvalId: approval.id,
    runId: run.id,
    workUnitId: workUnit.id,
    priorAttemptId: priorAttempt.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    sideEffectFingerprint: approvalSideEffectFingerprintV1({
      actionType: approval.actionType,
      toolCallId: approval.toolCallId,
      sideEffect,
    }),
  });
  assert.ok(store.updateApprovalCheckpointStatus(initialCheckpoint.id, {
    status: "pending",
    expectedStatus: "pending",
    expectedRevision: initialCheckpoint.revision,
    resumeBasis,
  }, now));
  if (options.approve !== false) {
    const approved = store.approveApprovalRequest(approval.id, { reason: "atomic claim" }, "2026-08-16T01:01:00.000Z");
    assert.equal(approved?.status, "approved");
  }
  const checkpoint = store.getApprovalCheckpointForApproval(approval.id);
  assert.ok(checkpoint);
  assert.equal(checkpoint.status, options.approve === false ? "pending" : "approved");
  const attemptId = `attempt_resume_claim_${suffix}_2`;
  const claim = {
    checkpointId: checkpoint.id,
    expectedCheckpointStatus: checkpoint.status,
    expectedCheckpointRevision: checkpoint.revision,
    approvalId: approval.id,
    runId: run.id,
    workUnitId: workUnit.id,
    expectedActiveAttemptId: priorAttempt.id,
    attemptToLoseId: priorAttempt.id,
    replacementAttempt: {
      id: attemptId,
      workUnitId: workUnit.id,
      attemptNumber: 2,
      runtimeInstanceId: "runtime_after_restart",
      runnerId: "pi",
      effectiveRunnerId: "pi",
      now: "2026-08-16T01:02:00.000Z",
    },
    runnerResumeHandle: {
      kind: "ling_continuation",
      runnerId: "pi",
      runId: run.id,
      attemptId,
      verified: true,
      payload: { schemaVersion: 1, approvalId: approval.id },
    },
    mode: "activate_waiting",
    now: "2026-08-16T01:02:00.000Z",
  };
  return {
    cwd,
    store,
    run: store.getRun(run.id),
    task: store.getTask(task.id),
    workUnit: store.getWorkUnit(workUnit.id),
    priorAttempt: store.getWorkUnitAttempt(priorAttempt.id),
    priorFence,
    approval,
    sideEffect,
    checkpoint,
    claim,
    async close() {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("system reviewer approval resolution is fenced by approval, policy, effect, and active Attempt", async () => {
  const approvedFixture = await createApprovalResumeClaimFixture("system-reviewer-approved", { approve: false });
  try {
    const { store, approval, sideEffect, priorFence, run } = approvedFixture;
    const result = store.resolveApprovalBySystemReviewer({
      approvalId: approval.id,
      approvalCreatedAt: approval.createdAt,
      runId: run.id,
      toolCallId: approval.toolCallId,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect,
      }),
      workspacePolicyUpdatedAt: store.getApprovalPolicy().updatedAt,
      sourceFence: priorFence,
      decision: "approve",
      reason: "System reviewer found the scoped command safe.",
    }, "2026-08-16T01:00:30.000Z");
    assert.equal(result.ok, true);
    assert.equal(result.approval.status, "approved");
    assert.equal(result.approval.resolvedBy, "system-reviewer");
    assert.equal(result.approval.decisionKind, "approve_once");
    assert.equal(store.getApprovalCheckpointForApproval(approval.id)?.status, "approved");
  } finally {
    await approvedFixture.close();
  }

  const staleFixture = await createApprovalResumeClaimFixture("system-reviewer-stale", { approve: false });
  try {
    const { store, approval, sideEffect, priorFence, run } = staleFixture;
    const base = {
      approvalId: approval.id,
      approvalCreatedAt: approval.createdAt,
      runId: run.id,
      toolCallId: approval.toolCallId,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect,
      }),
      workspacePolicyUpdatedAt: store.getApprovalPolicy().updatedAt,
      sourceFence: priorFence,
      decision: "deny",
      reason: "System reviewer denied the command.",
    };
    assert.deepEqual(store.resolveApprovalBySystemReviewer({
      ...base,
      sideEffectFingerprint: "stale-effect",
    }, "2026-08-16T01:00:10.000Z"), { ok: false, code: "approval_effect_changed" });
    assert.deepEqual(store.resolveApprovalBySystemReviewer({
      ...base,
      sourceFence: { ...priorFence, fencingToken: "999999" },
    }, "2026-08-16T01:00:20.000Z"), { ok: false, code: "approval_execution_stale" });
    store.updateApprovalPolicy({ allowedWritePaths: [".", "docs"] }, "2026-08-16T01:00:25.000Z");
    assert.deepEqual(store.resolveApprovalBySystemReviewer(base, "2026-08-16T01:00:30.000Z"), {
      ok: false,
      code: "approval_policy_changed",
    });
    assert.equal(store.getApprovalRequest(approval.id)?.status, "pending");
    store.approveApprovalRequest(approval.id, { reason: "Human won the race." }, "2026-08-16T01:00:40.000Z");
    assert.deepEqual(store.resolveApprovalBySystemReviewer({
      ...base,
      workspacePolicyUpdatedAt: store.getApprovalPolicy().updatedAt,
    }, "2026-08-16T01:00:50.000Z"), { ok: false, code: "approval_not_pending" });
    assert.equal(store.getApprovalRequest(approval.id)?.resolvedBy, "local-user");
  } finally {
    await staleFixture.close();
  }
});

test("system reviewer may recover only an exact startup-suspended pending approval wait", async () => {
  const fixture = await createApprovalResumeClaimFixture("system-reviewer-recovery", { approve: false });
  try {
    const { store, approval, sideEffect, priorFence, run, priorAttempt } = fixture;
    const lostAt = "2026-08-16T01:00:10.000Z";
    store.updateWorkUnitAttemptStatus({
      ...priorFence,
      status: "lost",
      now: lostAt,
      endedAt: lostAt,
      errorCode: "runtime_suspend",
      errorMessage: "runtime-startup-recoverable-approval",
    });
    assert.equal(store.isRecoverableApprovalReviewOwner(approval.id, priorFence), true);
    const base = {
      approvalId: approval.id,
      approvalCreatedAt: approval.createdAt,
      runId: run.id,
      toolCallId: approval.toolCallId,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect,
      }),
      workspacePolicyUpdatedAt: store.getApprovalPolicy().updatedAt,
      sourceFence: priorFence,
      decision: "approve",
      reason: "Recovered reviewer approved the immutable action.",
    };
    assert.deepEqual(store.resolveApprovalBySystemReviewer(base, "2026-08-16T01:00:20.000Z"), {
      ok: false,
      code: "approval_execution_stale",
    });
    const recovered = store.resolveApprovalBySystemReviewer({
      ...base,
      sourceAuthority: "recoverable_suspension",
    }, "2026-08-16T01:00:30.000Z");
    assert.equal(recovered.ok, true);
    assert.equal(recovered.approval.resolvedBy, "system-reviewer");

    assert.equal(store.isRecoverableApprovalReviewOwner(approval.id, priorFence), false);
    assert.equal(store.getWorkUnitAttempt(priorAttempt.id)?.status, "lost");
  } finally {
    await fixture.close();
  }

  const wrongLoss = await createApprovalResumeClaimFixture("system-reviewer-non-recoverable", { approve: false });
  try {
    const lostAt = "2026-08-16T01:00:10.000Z";
    wrongLoss.store.updateWorkUnitAttemptStatus({
      ...wrongLoss.priorFence,
      status: "lost",
      now: lostAt,
      endedAt: lostAt,
      errorCode: "runner_crash",
      errorMessage: "untrusted loss",
    });
    assert.equal(wrongLoss.store.isRecoverableApprovalReviewOwner(wrongLoss.approval.id, wrongLoss.priorFence), false);
  } finally {
    await wrongLoss.close();
  }
});

for (const [label, decision] of [
  ["approve-array", ["approve"]], ["deny-array", ["deny"]], ["manual-array", ["manual"]],
  ["nested-array", [["approve"]]], ["manual-string", "manual"], ["unknown-string", "allow"],
  ["boxed-string", new String("approve")], ["coercible-object", { toString: () => "deny" }],
  ["plain-object", { decision: "approve" }], ["null", null], ["undefined", undefined],
  ["boolean", true], ["number", 1],
]) {
  test(`A22 system reviewer Store rejects ${label} without mutating durable approval or checkpoint`, async () => {
    const fixture = await createApprovalResumeClaimFixture(`invalid-review-${label}`, { approve: false });
    try {
      const { store, approval, sideEffect, priorFence, run, workUnit, priorAttempt, checkpoint } = fixture;
      const beforeApproval = store.getApprovalRequest(approval.id);
      const beforeCheckpoint = store.getApprovalCheckpoint(checkpoint.id);
      const beforeRun = store.getRun(run.id);
      const beforeUnit = store.getWorkUnit(workUnit.id);
      const beforeAttempt = store.getWorkUnitAttempt(priorAttempt.id);
      assert.deepEqual(store.resolveApprovalBySystemReviewer({
        approvalId: approval.id,
        approvalCreatedAt: approval.createdAt,
        runId: run.id,
        toolCallId: approval.toolCallId,
        sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: approval.actionType, toolCallId: approval.toolCallId, sideEffect }),
        workspacePolicyUpdatedAt: store.getApprovalPolicy().updatedAt,
        sourceFence: priorFence,
        decision,
        reason: "Malformed value is not a deny verdict.",
      }, "2026-08-16T01:00:30.000Z"), { ok: false, code: "approval_invalid_decision" });
      assert.deepEqual(store.getApprovalRequest(approval.id), beforeApproval);
      assert.deepEqual(store.getApprovalCheckpoint(checkpoint.id), beforeCheckpoint);
      assert.deepEqual(store.getRun(run.id), beforeRun);
      assert.deepEqual(store.getWorkUnit(workUnit.id), beforeUnit);
      assert.deepEqual(store.getWorkUnitAttempt(priorAttempt.id), beforeAttempt);
      assert.equal(store.listEvents(run.id, { limit: 1_000 }).some(event => event.type === "approval_denied"), false);
    } finally {
      await fixture.close();
    }
  });
}

test("recovered system reviewer denial atomically closes the waiting run, work unit, and task", async () => {
  const fixture = await createApprovalResumeClaimFixture("system-reviewer-recovered-denial", { approve: false });
  try {
    const { store, approval, sideEffect, priorFence, run, workUnit, priorAttempt, checkpoint, task } = fixture;
    const lostAt = "2026-08-16T01:00:10.000Z";
    store.updateWorkUnitAttemptStatus({
      ...priorFence,
      status: "lost",
      now: lostAt,
      endedAt: lostAt,
      errorCode: "runtime_suspend",
      errorMessage: "runtime-startup-recoverable-approval",
    });
    const resolved = store.resolveApprovalBySystemReviewer({
      approvalId: approval.id,
      approvalCreatedAt: approval.createdAt,
      runId: run.id,
      toolCallId: approval.toolCallId,
      sideEffectFingerprint: approvalSideEffectFingerprintV1({
        actionType: approval.actionType,
        toolCallId: approval.toolCallId,
        sideEffect,
      }),
      workspacePolicyUpdatedAt: store.getApprovalPolicy().updatedAt,
      sourceFence: priorFence,
      sourceAuthority: "recoverable_suspension",
      decision: "deny",
      reason: "Recovered reviewer rejected the action.",
    }, "2026-08-16T01:00:20.000Z");
    assert.equal(resolved.ok, true);
    const deniedCheckpoint = store.getApprovalCheckpoint(checkpoint.id);
    assert.equal(deniedCheckpoint?.status, "denied");
    assert.equal(store.getApprovalRequest(approval.id)?.resolvedBy, "system-reviewer");
    assert.equal(store.getRun(run.id)?.status, "waiting_for_approval");
    assert.equal(store.getWorkUnit(workUnit.id)?.status, "waiting_for_approval");
    assert.equal(store.getWorkUnitAttempt(priorAttempt.id)?.status, "lost");
    assert.equal(store.getTask(task.id)?.status, "running");

    const terminal = store.commitApprovalResumeTerminal({
      kind: "suspended_approval_denied",
      checkpointId: checkpoint.id,
      expectedCheckpointRevision: deniedCheckpoint.revision,
      approvalId: approval.id,
      runId: run.id,
      workUnitId: workUnit.id,
      attemptId: priorAttempt.id,
      reason: "Recovered reviewer rejected the action.",
      now: "2026-08-16T01:00:30.000Z",
    });
    assert.equal(terminal.ok, true);
    assert.equal(terminal.kind, "suspended_approval_denied");
    assert.equal(store.getRun(run.id)?.status, "failed");
    assert.equal(store.getWorkUnit(workUnit.id)?.status, "failed");
    assert.equal(store.getWorkUnitAttempt(priorAttempt.id)?.status, "lost");
    assert.equal(store.getTask(task.id)?.status, "failed");
    assert.equal(store.getApprovalCheckpoint(checkpoint.id)?.status, "denied");
  } finally {
    await fixture.close();
  }
});

test("sqlite store creates and resolves media approval requests", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-media-approval-"));
  const createdAt = "2026-05-24T00:00:00.000Z";
  const expiresAt = "2026-05-24T00:30:00.000Z";
  let store = createSqliteRunStore(cwd);
  try {
    const job = store.createMediaJob(
      {
        providerPresetId: "provider_seedream",
        operation: "image_generate",
        prompt: "Generate a product image.",
      },
      createdAt,
    );

    const approval = store.createApprovalRequest(
      {
        mediaJobId: job.id,
        actionType: "media_cost",
        risk: "high",
        title: "Approve media job cost",
        description: "Legacy media cost approval.",
        payload: {
          type: "media_cost",
          providerPresetId: "provider_seedream",
          model: "seedream",
          operation: "image_generate",
          promptPreview: "Generate a product image.",
        },
        expiresAt,
      },
      createdAt,
    );

    assert.equal(approval.runId, undefined);
    assert.equal(approval.taskId, undefined);
    assert.equal(approval.mediaJobId, job.id);
    assert.deepEqual(store.listApprovalRequests({ mediaJobId: job.id }), [approval]);
    assert.deepEqual(store.listApprovalRequests({ runId: "run_missing" }), []);

    const approved = store.approveApprovalRequest(approval.id, { reason: "Approved for smoke." }, "2026-05-24T00:05:00.000Z");
    assert.ok(approved);
    assert.equal(approved.status, "approved");
    assert.equal(approved.mediaJobId, job.id);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite migration preserves legacy run approval owners", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-core-approval-migration-"));
  const rootDir = resolve(cwd, ".ling-stack");
  const databasePath = resolve(rootDir, "ling-stack.sqlite");
  const now = "2026-05-24T00:00:00.000Z";
  await mkdir(rootDir, { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE run_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel_id TEXT,
        teammate_id TEXT,
        provider_preset_id TEXT,
        provider_name TEXT NOT NULL,
        provider_model TEXT NOT NULL,
        task_snapshot_json TEXT NOT NULL,
        provider_snapshot_json TEXT NOT NULL,
        request_snapshot_json TEXT NOT NULL,
        event_log_path TEXT NOT NULL,
        summary_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel_id TEXT,
        tool_call_id TEXT,
        action_type TEXT NOT NULL,
        risk TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT,
        decision_reason TEXT,
        FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
      );
    `);
    legacy.prepare(`
      INSERT INTO run_sessions (
        id,
        status,
        cwd,
        task_id,
        provider_name,
        provider_model,
        task_snapshot_json,
        provider_snapshot_json,
        request_snapshot_json,
        event_log_path,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "run_legacy_approval",
      "waiting_for_approval",
      cwd,
      "task_legacy_approval",
      "test-provider",
      "test-model",
      "{}",
      "{}",
      "{}",
      ".ling-stack/sessions/run_legacy_approval.jsonl",
      now,
      now,
    );
    legacy.prepare(`
      INSERT INTO approval_requests (
        id,
        run_id,
        task_id,
        action_type,
        risk,
        title,
        description,
        payload_json,
        status,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "approval_legacy",
      "run_legacy_approval",
      "task_legacy_approval",
      "bash",
      "medium",
      "Approve shell command",
      "echo legacy",
      JSON.stringify({ type: "bash", cwd, command: "echo legacy", riskFlags: [] }),
      "pending",
      now,
      "2026-05-24T00:30:00.000Z",
    );
  } finally {
    legacy.close();
  }

  const store = createSqliteRunStore(cwd);
  try {
    const approvals = store.listApprovalRequests({ runId: "run_legacy_approval" });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].id, "approval_legacy");
    assert.equal(approvals[0].runId, "run_legacy_approval");
    assert.equal(approvals[0].taskId, "task_legacy_approval");
    assert.equal(approvals[0].mediaJobId, undefined);
    const checkpoint = store.getApprovalCheckpointForApproval("approval_legacy");
    assert.ok(checkpoint);
    assert.equal(checkpoint.id, "approval_checkpoint_approval_legacy");
    assert.equal(checkpoint.runId, "run_legacy_approval");
    assert.equal(checkpoint.taskId, "task_legacy_approval");
    assert.equal(checkpoint.status, "pending");
    assert.equal(checkpoint.createdAt, now);
    assert.deepEqual(checkpoint.sideEffect, { type: "bash", cwd, command: "echo legacy", riskFlags: [] });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
