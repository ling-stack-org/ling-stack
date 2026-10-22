import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("doctor reports a ready workspace", async () => {
  const daemon = await startDoctorDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    await prepareDoctorWorkspace(cwd);
    const result = await runCli(daemon.url, cwd, ["doctor"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Ling Stack doctor/);
    assert.match(result.stdout, /daemon\.health\s+daemon is reachable/);
    assert.match(result.stdout, /workspace\.paths\s+runtime paths exist/);
    assert.match(result.stdout, /workspace\.sqlite\s+database file exists/);
    assert.match(result.stdout, /providers\.configured\s+1 runnable provider\(s\) configured/);
    assert.match(result.stdout, /providers\.preflight\s+1 provider\(s\) passed preflight/);
    assert.match(result.stdout, /channels\.configured\s+1 channel\(s\) configured/);
    assert.match(result.stdout, /approval_policy\.load\s+approval policy loads/);
    assert.match(result.stdout, /skills\.registry\s+effective skill registry loads/);
    assert.match(result.stdout, /memory\.review_policy\s+memory review policy loads/);
    assert.match(result.stdout, /runtime\.leases\s+no active leases/);
    assert.match(result.stdout, /runtime\.shell_snapshots\s+shell snapshot diagnostics are healthy/);
    assert.ok(daemon.requests.includes("GET /health"));
    assert.ok(daemon.requests.includes("GET /control-plane/snapshot"));
    assert.ok(daemon.requests.includes("GET /channels"));
    assert.ok(daemon.requests.includes("GET /tasks"));
    assert.ok(daemon.requests.includes("GET /runs"));
    assert.ok(daemon.requests.includes("GET /runs/run_shell/shell-snapshots"));
    assert.ok(daemon.requests.includes("GET /runs/run_shell/artifacts"));
    assert.ok(!daemon.requests.includes("GET /providers"));
    assert.ok(!daemon.requests.includes("GET /approval-policy"));
    assert.ok(!daemon.requests.includes("GET /skills"));
    assert.ok(!daemon.requests.includes("GET /memory/review-policy"));
    assert.ok(daemon.requests.includes("GET /runtime/leases"));
    assert.ok(!daemon.requests.includes("GET /runtime/stuck"));
    assert.ok(!daemon.requests.includes("GET /mcp/servers"));
    assert.ok(!daemon.requests.includes("GET /runners"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor exits non-zero and prints next step when provider preflight is missing", async () => {
  const daemon = await startDoctorDaemon({
    providers: [
      {
        ...readyProvider(),
        lastCheck: undefined,
      },
    ],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    await prepareDoctorWorkspace(cwd);
    // Control only the fixed Web health probe; daemon requests still use HTTP.
    const webHealthFixture = resolve(cwd, "web-health.mjs");
    await writeFile(webHealthFixture, `
      const upstreamFetch = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        if (String(input) === "http://127.0.0.1:5173") {
          return Promise.resolve(new Response("<title>Ling Stack</title>", {
            status: process.env.LING_TEST_WEB_REACHABLE === "1" ? 200 : 503,
            headers: { "content-type": "text/html" },
          }));
        }
        return upstreamFetch(input, options);
      };
    `);
    for (const webReachable of ["1", "0"]) {
      const env = {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(webHealthFixture).href}`.trim(),
        LING_TEST_WEB_REACHABLE: webReachable,
        npm_lifecycle_event: "ling",
      };
      const result = await runCli(daemon.url, cwd, ["doctor"], { env });
      assert.equal(result.code, 4, result.stderr);
      assert.match(result.stdout, /Status: fail/);
      assert.match(result.stdout, webReachable === "1" ? /ok\s+web\.health/ : /warning\s+web\.health/);
      assert.match(result.stdout, /providers\.preflight\s+no runnable provider has a successful preflight check/);
      assert.match(result.stdout, /corepack pnpm(?: --dir [^\n]+)? ling provider check-all/);
      const installed = await runCli(daemon.url, cwd, ["doctor"], { env: { ...env, npm_lifecycle_event: "" } });
      assert.equal(installed.code, 4, installed.stderr);
      assert.match(installed.stdout, /^  ling-stack provider check-all$/m);
      assert.doesNotMatch(installed.stdout, /corepack pnpm/);
      const summary = await runCli(daemon.url, cwd, ["doctor", "--summary"], { env });
      assert.equal(summary.code, 4, summary.stderr);
      assert.match(summary.stdout, webReachable === "1"
        ? /^Next: corepack pnpm ling provider check-all$/m
        : /^Next: corepack pnpm ling ui --foreground$/m);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor json exposes readiness counters", async () => {
  const daemon = await startDoctorDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    await prepareDoctorWorkspace(cwd);
    const result = await runCli(daemon.url, cwd, ["doctor", "--json"]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.cwd, cwd);
    assert.equal(body.daemonUrl, daemon.url);
    assert.ok(["ok", "warning"].includes(body.overallStatus));
    const checks = new Map(body.checks.map((check) => [check.id, check]));
    assert.equal(checks.get("providers.configured").details.total, 1);
    assert.equal(checks.get("providers.configured").details.runnable, 1);
    assert.equal(checks.get("providers.preflight").details.preflightReady, 1);
    assert.equal(checks.get("channels.configured").details.total, 1);
    assert.equal(checks.get("skills.registry").details.total, 2);
    assert.equal(checks.get("skills.registry").details.builtin, 1);
    assert.equal(checks.get("skills.registry").details.published, 1);
    assert.equal(checks.get("memory.review_policy").details.mode, "manual-review");
    assert.equal(checks.get("runtime.leases").details.activeLeases, 0);
    assert.equal(checks.get("runtime.shell_snapshots").details.capabilityAdvertised, true);
    assert.equal(checks.get("runtime.shell_snapshots").details.snapshots, 2);
    assert.equal(checks.get("runtime.shell_snapshots").details.unreadableJsonArtifacts, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor json continues when daemon is down", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-down-"));
  try {
    await prepareDoctorWorkspace(cwd);
    const result = await runCli("http://127.0.0.1:9", cwd, ["doctor", "--json"]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 4);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.overallStatus, "fail");
    const checks = new Map(body.checks.map((check) => [check.id, check]));
    assert.equal(checks.get("daemon.health").status, "fail");
    assert.equal(checks.get("daemon.process_state").status, "ok");
    assert.equal(checks.get("workspace.paths").status, "ok");
    assert.equal(checks.get("workspace.sqlite").status, "ok");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor flags missing skills and memory routes without refreshing or repairing", async () => {
  const daemon = await startDoctorDaemon({
    missingRoutes: ["/control-plane/snapshot", "/skills", "/memory/review-policy"],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-routes-"));
  try {
    await prepareDoctorWorkspace(cwd);
    const result = await runCli(daemon.url, cwd, ["doctor", "--json"]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 4);
    assert.equal(body.overallStatus, "fail");
    const checks = new Map(body.checks.map((check) => [check.id, check]));
    assert.equal(checks.get("skills.registry").status, "fail");
    assert.equal(checks.get("skills.registry").details.error.status, 404);
    assert.equal(checks.get("memory.review_policy").status, "fail");
    assert.equal(checks.get("memory.review_policy").details.error.status, 404);
    assert.ok(daemon.requests.includes("GET /skills"));
    assert.ok(daemon.requests.includes("GET /memory/review-policy"));
    assert.ok(daemon.requests.includes("GET /control-plane/snapshot"));
    assert.ok(!daemon.requests.includes("POST /skills/refresh"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor json redacts secret-like daemon URL fields", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-redact-"));
  try {
    await prepareDoctorWorkspace(cwd);
    const result = await runCli("http://user:supersecret@127.0.0.1:9?api_key=sk-test-secret", cwd, ["doctor", "--json"]);
    const text = result.stdout + result.stderr;
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 4);
    assert.match(body.daemonUrl, /<redacted>/);
    assert.doesNotMatch(text, /supersecret/);
    assert.doesNotMatch(text, /sk-test-secret/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor warns when shell snapshot diagnostics cannot read a route and does not mutate", async () => {
  const daemon = await startDoctorDaemon({ shellSnapshotStatus: 500 });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-shell-snapshots-"));
  try {
    await prepareDoctorWorkspace(cwd);
    const result = await runCli(daemon.url, cwd, ["doctor", "--json"]);
    const body = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    const checks = new Map(body.checks.map((check) => [check.id, check]));
    const check = checks.get("runtime.shell_snapshots");
    assert.equal(check.status, "warning");
    assert.equal(check.details.routeFailures.length, 1);
    assert.ok(daemon.requests.includes("GET /runs/run_shell/shell-snapshots"));
    assert.ok(daemon.requests.every((request) => request.startsWith("GET ")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("doctor config audits .ling-stack state and flags root logs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-config-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-user-config-"));
  try {
    await prepareDoctorWorkspace(cwd);
    await writeFile(resolve(userRoot, "config.json"), JSON.stringify({ schemaVersion: 1, product: "ling-stack" }), "utf8");
    await writeFile(resolve(userRoot, "settings.json"), JSON.stringify({ schemaVersion: 1, theme: "system" }), "utf8");
    await mkdir(resolve(userRoot, "providers"), { recursive: true });
    await writeFile(resolve(userRoot, "providers", "profiles.json"), JSON.stringify({ schemaVersion: 1, profiles: [] }), "utf8");
    await writeFile(resolve(cwd, ".ling-stack", "config.json"), JSON.stringify({ version: 1 }), "utf8");
    await mkdir(resolve(cwd, ".ling-stack", "sessions"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "artifacts"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "attachments"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "pi"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "plugins", "cache"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "logs"), { recursive: true });
    await mkdir(resolve(cwd, ".logs"), { recursive: true });

    const result = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    const body = JSON.parse(result.stdout);
    const checks = new Map(body.checks.map((check) => [check.id, check]));

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.overallStatus, "warning");
    assert.equal(checks.get("config.user_root").status, "ok");
    assert.equal(checks.get("config.user_root").details.path, userRoot);
    assert.equal(checks.get("config.user_config").details.path, resolve(userRoot, "config.json"));
    assert.equal(checks.get("config.user_settings").details.path, resolve(userRoot, "settings.json"));
    assert.equal(checks.get("config.user_provider_profiles").details.path, resolve(userRoot, "providers", "profiles.json"));
    assert.equal(checks.get("config.workspace_config").status, "ok");
    assert.equal(checks.get("workspace.sqlite").status, "ok");
    assert.equal(checks.get("config.plugins_cache").status, "ok");
    assert.equal(checks.get("config.root_logs").status, "warning");
    assert.match(checks.get("config.root_logs").summary, /root \.logs/);
    assert.doesNotMatch(result.stdout + result.stderr, /sk-/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("doctor config treats missing user layer as built-in defaults", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-config-missing-user-"));
  const userRoot = resolve(await mkdtemp(resolve(tmpdir(), "ling-stack-cli-user-config-parent-")), "missing-user-root");
  try {
    await prepareDoctorWorkspace(cwd);
    await writeFile(resolve(cwd, ".ling-stack", "config.json"), JSON.stringify({ version: 1 }), "utf8");
    await mkdir(resolve(cwd, ".ling-stack", "sessions"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "artifacts"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "attachments"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "pi"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "plugins", "cache"), { recursive: true });
    await mkdir(resolve(cwd, ".ling-stack", "logs"), { recursive: true });

    const result = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    const body = JSON.parse(result.stdout);
    const checks = new Map(body.checks.map((check) => [check.id, check]));

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.overallStatus, "ok");
    assert.equal(checks.get("config.user_root").status, "ok");
    assert.equal(checks.get("config.user_root").details.exists, false);
    assert.equal(checks.get("config.user_config").status, "ok");
    assert.equal(checks.get("config.user_config").details.exists, false);
    assert.equal(checks.get("config.user_settings").status, "ok");
    assert.equal(checks.get("config.user_provider_profiles").status, "ok");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(dirname(userRoot), { recursive: true, force: true });
  }
});

test("init can opt a workspace into user-data-dir state and doctor resolves it", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-user-data-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-user-data-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--workspace-state-location",
      "user-data-dir",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);
    const initBody = JSON.parse(init.stdout);
    assert.equal(initBody.stateLocation, "user-data-dir");
    assert.equal(initBody.rootDir.startsWith(resolve(userRoot, "workspaces")), true);
    assert.equal(initBody.databasePath, resolve(initBody.rootDir, "ling-stack.sqlite"));

    const pointer = JSON.parse(await readFile(resolve(cwd, ".ling-stack", "config.json"), "utf8"));
    assert.equal(pointer.workspaceStateLocation, "user-data-dir");
    assert.equal(pointer.workspaceId, initBody.workspaceId);
    assert.equal(pointer.stateRoot, initBody.rootDir);

    const doctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorBody = JSON.parse(doctor.stdout);
    const checks = new Map(doctorBody.checks.map((check) => [check.id, check]));

    assert.equal(doctorBody.overallStatus, "ok");
    assert.equal(checks.get("workspace.identity").details.stateLocation, "user-data-dir");
    assert.equal(checks.get("workspace.identity").details.stateRoot, initBody.rootDir);
    assert.equal(checks.get("workspace.repo_local_state").status, "ok");
    assert.equal(checks.get("workspace.repo_local_state").details.authoritativeDatabasePath, initBody.databasePath);
    assert.equal(checks.get("config.workspace_config").details.path, initBody.configPath);
    assert.equal(checks.get("workspace.sqlite").details.databasePath, initBody.databasePath);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("doctor config warns when the workspace registry row is stale", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-stale-registry-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-stale-registry-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);

    const database = new DatabaseSync(resolve(userRoot, "global.sqlite"));
    try {
      database
        .prepare("UPDATE workspaces_registry SET state_root = ? WHERE canonical_cwd = ?")
        .run(resolve(userRoot, "workspaces", "stale-workspace"), cwd);
    } finally {
      database.close();
    }

    const doctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    const body = JSON.parse(doctor.stdout);
    const checks = new Map(body.checks.map((check) => [check.id, check]));

    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(body.overallStatus, "warning");
    assert.equal(checks.get("workspace.registry").status, "warning");
    assert.deepEqual(checks.get("workspace.registry").details.mismatches, ["state_root"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("workspace repair-registry previews and repairs a stale registry row", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-repair-registry-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-repair-registry-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);
    const initBody = JSON.parse(init.stdout);

    const staleStateRoot = resolve(userRoot, "workspaces", "stale-workspace");
    const database = new DatabaseSync(resolve(userRoot, "global.sqlite"));
    try {
      database
        .prepare("UPDATE workspaces_registry SET state_root = ? WHERE canonical_cwd = ?")
        .run(staleStateRoot, cwd);
    } finally {
      database.close();
    }

    const dryRun = await runCli("http://127.0.0.1:9", cwd, [
      "workspace",
      "registry",
      "repair",
      "--dry-run",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryRunBody = JSON.parse(dryRun.stdout);

    assert.equal(dryRunBody.dryRun, true);
    assert.equal(dryRunBody.changed, true);
    assert.deepEqual(dryRunBody.mismatches, ["state_root"]);
    assert.equal(dryRunBody.registry.stateRoot, staleStateRoot);
    assert.equal(dryRunBody.resolved.stateRoot, initBody.rootDir);
    assert.ok(dryRunBody.checks.some((check) => check.id === "registry_row" && check.status === "warning"));

    const staleDoctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    const staleDoctorBody = JSON.parse(staleDoctor.stdout);
    const staleChecks = new Map(staleDoctorBody.checks.map((check) => [check.id, check]));
    assert.equal(staleChecks.get("workspace.registry").status, "warning");

    const repair = await runCli("http://127.0.0.1:9", cwd, [
      "workspace",
      "repair-registry",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(repair.code, 0, repair.stderr);
    const repairBody = JSON.parse(repair.stdout);
    assert.equal(repairBody.dryRun, false);
    assert.equal(repairBody.changed, true);
    assert.ok(repairBody.checks.some((check) => check.id === "registry_written" && check.status === "ok"));

    const doctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorBody = JSON.parse(doctor.stdout);
    const checks = new Map(doctorBody.checks.map((check) => [check.id, check]));
    assert.equal(doctorBody.overallStatus, "ok");
    assert.equal(checks.get("workspace.registry").status, "ok");
    assert.equal(checks.get("workspace.registry").details.registry.stateRoot, initBody.rootDir);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("doctor config treats read-only cwd as ok when user-data-dir state is selected", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-readonly-user-data-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-readonly-user-data-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--workspace-state-location",
      "user-data-dir",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);

    await chmod(cwd, 0o555);
    const doctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    const body = JSON.parse(doctor.stdout);
    const checks = new Map(body.checks.map((check) => [check.id, check]));

    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(body.overallStatus, "ok");
    assert.equal(checks.get("workspace.cwd_writable").status, "ok");
    assert.equal(checks.get("workspace.cwd_writable").details.writable, false);
    assert.equal(checks.get("workspace.cwd_writable").details.stateLocation, "user-data-dir");
  } finally {
    await chmod(cwd, 0o755).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("workspace migrate-state dry-run reports a migration plan without copying state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-dry-run-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-dry-run-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);
    await writeFile(resolve(cwd, ".ling-stack", "sessions", "run_dry.jsonl"), "{\"event\":\"dry\"}\n", "utf8");

    const dryRun = await runCli("http://127.0.0.1:9", cwd, [
      "workspace",
      "migrate-state",
      "--to",
      "user-data-dir",
      "--dry-run",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const body = JSON.parse(dryRun.stdout);

    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    assert.equal(body.canMigrate, true);
    assert.equal(body.source.stateLocation, "repo-local");
    assert.equal(body.target.stateLocation, "user-data-dir");
    assert.equal(body.plan.sourceWillRemain, true);
    assert.equal(body.plan.targetWillBeBackedUp, false);
    assert.equal(body.plan.repoPointerWillBeWritten, true);
    assert.ok(body.plan.previewManifestPath.includes("dry-run"));
    assert.ok(body.checks.some((check) => check.id === "daemon_stopped" && check.status === "ok"));
    assert.ok(body.checks.some((check) => check.id === "repo_pointer" && check.status === "ok"));

    await assert.rejects(stat(body.target.rootDir), { code: "ENOENT" });
    await assert.rejects(stat(body.plan.previewManifestPath), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("workspace migrate-state dry-run reports blockers without mutating", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-dry-run-blocked-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-dry-run-blocked-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);

    const dryRun = await runCli("http://127.0.0.1:9", cwd, [
      "workspace",
      "migrate-state",
      "--to",
      "repo-local",
      "--dry-run",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(dryRun.code, 4);
    const body = JSON.parse(dryRun.stdout);
    const checks = new Map(body.checks.map((check) => [check.id, check]));

    assert.equal(body.ok, false);
    assert.equal(body.canMigrate, false);
    assert.equal(checks.get("direction").status, "fail");
    assert.match(checks.get("direction").summary, /already repo-local/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("workspace migrate-state moves repo-local state to user-data-dir", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-to-user-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-to-user-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);

    await writeFile(resolve(cwd, ".ling-stack", "sessions", "run_migrate.jsonl"), "{\"event\":\"ok\"}\n", "utf8");
    await writeFile(resolve(cwd, ".ling-stack", "runtime-settings.json"), "{\"mode\":\"repo-local\"}\n", "utf8");

    const migration = await runCli("http://127.0.0.1:9", cwd, [
      "workspace",
      "migrate-state",
      "--to",
      "user-data-dir",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(migration.code, 0, migration.stderr);
    const body = JSON.parse(migration.stdout);

    assert.equal(body.source.stateLocation, "repo-local");
    assert.equal(body.target.stateLocation, "user-data-dir");
    assert.equal(body.target.rootDir.startsWith(resolve(userRoot, "workspaces")), true);
    assert.equal(await readFile(resolve(body.target.rootDir, "sessions", "run_migrate.jsonl"), "utf8"), "{\"event\":\"ok\"}\n");
    assert.equal(await readFile(resolve(body.target.rootDir, "runtime-settings.json"), "utf8"), "{\"mode\":\"repo-local\"}\n");

    const pointer = JSON.parse(await readFile(resolve(cwd, ".ling-stack", "config.json"), "utf8"));
    assert.equal(pointer.workspaceStateLocation, "user-data-dir");
    assert.equal(pointer.workspaceId, body.workspaceId);
    assert.equal(pointer.stateRoot, body.target.rootDir);

    const manifest = JSON.parse(await readFile(body.manifestPath, "utf8"));
    assert.equal(manifest.status, "succeeded");
    assert.equal(manifest.source.stateLocation, "repo-local");
    assert.equal(manifest.target.stateLocation, "user-data-dir");
    assert.ok(manifest.copiedPaths.includes("ling-stack.sqlite"));
    assert.ok(manifest.copiedPaths.includes("sessions"));

    const doctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorBody = JSON.parse(doctor.stdout);
    const checks = new Map(doctorBody.checks.map((check) => [check.id, check]));
    assert.equal(doctorBody.overallStatus, "warning");
    assert.equal(checks.get("workspace.identity").details.stateLocation, "user-data-dir");
    assert.equal(checks.get("workspace.identity").details.stateRoot, body.target.rootDir);
    assert.equal(checks.get("workspace.repo_local_state").status, "warning");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("workspace migrate-state moves user-data-dir state back to repo-local", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-to-repo-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-migrate-to-repo-root-"));
  try {
    const init = await runCli("http://127.0.0.1:9", cwd, [
      "init",
      "--workspace-state-location",
      "user-data-dir",
      "--no-provider-templates",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(init.code, 0, init.stderr);
    const initBody = JSON.parse(init.stdout);

    await writeFile(resolve(initBody.rootDir, "artifacts", "artifact.txt"), "artifact\n", "utf8");

    const migration = await runCli("http://127.0.0.1:9", cwd, [
      "workspace",
      "migrate-state",
      "--to",
      "repo-local",
      "--json",
    ], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(migration.code, 0, migration.stderr);
    const body = JSON.parse(migration.stdout);

    assert.equal(body.source.stateLocation, "user-data-dir");
    assert.equal(body.target.stateLocation, "repo-local");
    assert.equal(body.target.rootDir, resolve(cwd, ".ling-stack"));
    assert.equal(await readFile(resolve(cwd, ".ling-stack", "artifacts", "artifact.txt"), "utf8"), "artifact\n");
    assert.equal(await readFile(resolve(initBody.rootDir, "artifacts", "artifact.txt"), "utf8"), "artifact\n");

    const config = JSON.parse(await readFile(resolve(cwd, ".ling-stack", "config.json"), "utf8"));
    assert.equal(config.workspaceStateLocation, "repo-local");
    assert.equal(config.workspaceId, body.workspaceId);

    const manifest = JSON.parse(await readFile(body.manifestPath, "utf8"));
    assert.equal(manifest.status, "succeeded");
    assert.equal(manifest.source.stateLocation, "user-data-dir");
    assert.equal(manifest.target.stateLocation, "repo-local");
    assert.equal(typeof manifest.backups.targetExistingRoot, "string");

    const doctor = await runCli("http://127.0.0.1:9", cwd, ["doctor", "config", "--json"], {
      env: { LING_STACK_HOME: userRoot },
    });
    assert.equal(doctor.code, 0, doctor.stderr);
    const doctorBody = JSON.parse(doctor.stdout);
    const checks = new Map(doctorBody.checks.map((check) => [check.id, check]));
    assert.equal(doctorBody.overallStatus, "ok");
    assert.equal(checks.get("workspace.identity").details.stateLocation, "repo-local");
    assert.equal(checks.get("workspace.identity").details.stateRoot, resolve(cwd, ".ling-stack"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("daemon status remains a thin health check", async () => {
  const daemon = await startDoctorDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-doctor-"));
  try {
    const result = await runCli(daemon.url, cwd, ["daemon", "status"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Daemon: ok/);
    assert.doesNotMatch(result.stdout, /Ready:/);
    assert.deepEqual(daemon.requests, ["GET /health"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

function runCli(daemonUrl, cwd, args, options = {}) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliPath, "--daemon-url", daemonUrl, "--cwd", cwd, ...args], {
      env: {
        ...process.env,
        ...options.env,
      },
    }, (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function prepareDoctorWorkspace(cwd) {
  await mkdir(resolve(cwd, ".ling-stack"), { recursive: true });
  await writeFile(resolve(cwd, ".ling-stack", "ling-stack.sqlite"), "", "utf8");
}

async function startDoctorDaemon(overrides = {}) {
  const requests = [];
  const providers = overrides.providers ?? [readyProvider()];
  const channels = overrides.channels ?? [readyChannel()];
  const tasks = overrides.tasks ?? [readyTask()];
  const skills = overrides.skills ?? [readyBuiltinSkill(), readyPublishedSkill()];
  const runners = overrides.runners ?? [readyRunner()];
  const runs = overrides.runs ?? [readyRun()];
  const artifactsByRun = overrides.artifactsByRun ?? { run_shell: readyShellSnapshotArtifacts("run_shell") };
  const snapshotsByRun = overrides.snapshotsByRun ?? { run_shell: readyShellSnapshots("run_shell") };
  const missingRoutes = new Set(overrides.missingRoutes ?? []);
  const policy = overrides.policy ?? {
    workspaceId: "workspace_default",
    toolDecisions: {
      read: "allow",
      grep: "allow",
      find: "allow",
      ls: "allow",
      bash: "ask",
      edit: "ask",
      write: "ask",
    },
    allowedWritePaths: ["."],
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
  const reviewPolicy = overrides.reviewPolicy ?? {
    workspaceId: "workspace_default",
    mode: "manual-review",
    autoActiveSameScope: false,
    autoActiveUserExplicit: false,
    requireManualForWorkspace: true,
    requireManualForPersona: true,
    requireManualForCrossScope: true,
    quarantineSecretAdjacent: true,
    updatedAt: "2026-05-21T00:00:00.000Z",
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}`);

    if (missingRoutes.has(url.pathname)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "ling-stack-daemon" });
      return;
    }

    if (!url.searchParams.get("cwd")) {
      writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/control-plane/snapshot") {
      writeJson(response, 200, controlPlaneSnapshot({
        cwd: url.searchParams.get("cwd"),
        providers,
        skills,
        reviewPolicy,
        runners,
      }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/providers") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), providers });
      return;
    }

    if (request.method === "GET" && url.pathname === "/channels") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), channels });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tasks") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), tasks });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), runs });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runners") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), runners });
      return;
    }

    const shellSnapshotMatch = url.pathname.match(/^\/runs\/([^/]+)\/shell-snapshots$/);
    if (request.method === "GET" && shellSnapshotMatch) {
      if (overrides.shellSnapshotStatus) {
        writeJson(response, overrides.shellSnapshotStatus, { error: "shell_snapshot_error", message: "shell snapshots failed" });
        return;
      }
      const runId = decodeURIComponent(shellSnapshotMatch[1]);
      writeJson(response, 200, { runId, snapshots: snapshotsByRun[runId] ?? [] });
      return;
    }

    const artifactsMatch = url.pathname.match(/^\/runs\/([^/]+)\/artifacts$/);
    if (request.method === "GET" && artifactsMatch) {
      const runId = decodeURIComponent(artifactsMatch[1]);
      writeJson(response, 200, { runId, artifacts: artifactsByRun[runId] ?? [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/approval-policy") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), policy });
      return;
    }

    if (request.method === "GET" && url.pathname === "/skills") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), skills });
      return;
    }

    if (request.method === "GET" && url.pathname === "/memory/review-policy") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), policy: reviewPolicy });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runtime/leases") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), leases: [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/runtime/stuck") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), workUnits: [] });
      return;
    }

    if (request.method === "GET" && url.pathname === "/mcp/servers") {
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), servers: [] });
      return;
    }

    writeJson(response, 404, { error: "not_found" });
  });

  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    }),
  };
}

function readyProvider() {
  return {
    id: "provider_ready",
    kind: "openai-compatible",
    displayName: "Ready Provider",
    providerId: "local-relay",
    model: "gpt-5.5",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKeyRef: "env:LOCAL_RELAY_API_KEY",
    apiKeyConfigured: true,
    enabled: true,
    capabilities: ["chat", "tool_call", "reasoning"],
    input: ["text"],
    lastCheck: {
      ok: true,
      code: "ok",
      message: "ready",
      checkedAt: "2026-05-21T00:00:00.000Z",
    },
  };
}

function readyRunner() {
  return {
    id: "pi-local",
    displayName: "Pi local",
    enabled: true,
    available: true,
    experimental: false,
    capabilities: ["stream_text", "tool_events", "approval_interception", "artifacts", "runtime:shell-snapshot"],
  };
}

function readyRun() {
  return {
    id: "run_shell",
    status: "succeeded",
    cwd: "/tmp/ling-stack-cli-doctor",
    taskId: "task_ready",
    providerName: "Ready Provider",
    providerModel: "gpt-5.5",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: "/tmp/ling-stack-cli-doctor/.ling-stack/runs/run_shell/events.jsonl",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:01.000Z",
    endedAt: "2026-05-21T00:00:01.000Z",
  };
}

function readyShellSnapshots(runId) {
  return [
    {
      id: `shell_snapshot:${runId}:tool_call_shell:000001`,
      runId,
      toolCallId: "tool_call_shell",
      sequence: 1,
      createdAt: "2026-05-21T00:00:00.100Z",
      source: "exec_start",
      status: "starting",
      commandPreview: "echo ok",
      durationMs: 2,
      artifactId: "artifact_shell_snapshot_1_json",
      textArtifactId: "artifact_shell_snapshot_1_text",
    },
    {
      id: `shell_snapshot:${runId}:tool_call_shell:000002`,
      runId,
      toolCallId: "tool_call_shell",
      sequence: 2,
      createdAt: "2026-05-21T00:00:00.200Z",
      source: "exec_end",
      status: "exited",
      commandPreview: "echo ok",
      durationMs: 25,
      exitCode: 0,
      artifactId: "artifact_shell_snapshot_2_json",
      textArtifactId: "artifact_shell_snapshot_2_text",
    },
  ];
}

function readyShellSnapshotArtifacts(runId) {
  return [
    readyArtifact("artifact_shell_snapshot_1_json", runId, `${runId}/shell-snapshots/tool_call_shell/000001.json`, "json"),
    readyArtifact("artifact_shell_snapshot_1_text", runId, `${runId}/shell-snapshots/tool_call_shell/000001.txt`, "log"),
    readyArtifact("artifact_shell_snapshot_2_json", runId, `${runId}/shell-snapshots/tool_call_shell/000002.json`, "json"),
    readyArtifact("artifact_shell_snapshot_2_text", runId, `${runId}/shell-snapshots/tool_call_shell/000002.txt`, "log"),
  ];
}

function readyArtifact(id, runId, path, type) {
  return {
    id,
    runId,
    type,
    path,
    title: id,
    contentType: type === "json" ? "application/json" : "text/plain; charset=utf-8",
    sizeBytes: 128,
    createdAt: "2026-05-21T00:00:00.000Z",
  };
}

function controlPlaneSnapshot({ cwd, providers, skills, reviewPolicy, runners }) {
  return {
    cwd,
    workspaceId: "workspace_default",
    generatedAt: "2026-05-21T00:00:00.000Z",
    latestEventSeq: 1,
    domains: {
      providers: {
        ok: true,
        revision: 1,
        data: {
          counts: {
            total: providers.length,
            enabled: providers.filter((provider) => provider.enabled).length,
            runnable: providers.filter((provider) => provider.enabled && provider.capabilities.includes("chat")).length,
            preflightReady: providers.filter((provider) => provider.lastCheck?.ok === true).length,
            missingSecrets: providers.filter((provider) => provider.apiKeyRef && provider.apiKeyConfigured !== true).length,
          },
          providers: providers.map((provider) => ({
            id: provider.id,
            displayName: provider.displayName,
            kind: provider.kind,
            api: provider.api,
            enabled: provider.enabled,
            capabilities: provider.capabilities,
            input: provider.input,
            runnable: provider.enabled && provider.capabilities.includes("chat"),
            secretStatus: provider.apiKeyRef ? (provider.apiKeyConfigured ? "configured" : "missing") : "not_required",
            secretRefKind: provider.apiKeyRef ? "env" : undefined,
            lastCheck: provider.lastCheck ? {
              ok: provider.lastCheck.ok,
              code: provider.lastCheck.code,
              checkedAt: provider.lastCheck.checkedAt,
            } : undefined,
          })),
        },
      },
      skills: {
        ok: true,
        revision: 1,
        data: {
          registryGeneration: 2,
          counts: {
            total: skills.length,
            builtin: skills.filter((skill) => skill.reviewStatus === "builtin").length,
            published: skills.filter((skill) => skill.reviewStatus === "published").length,
            draft: 0,
            archived: 0,
          },
          skills,
        },
      },
      approvals: {
        ok: true,
        revision: 1,
        data: {
          policy: {
            mode: "workspace_policy",
            toolDecisionCounts: { allow: 4, ask: 3 },
            allowedWritePathCount: 1,
          },
          pending: [],
          counts: { pending: 0, highRisk: 0, expired: 0 },
        },
      },
      memory: {
        ok: true,
        revision: 1,
        data: {
          reviewPolicy,
          promotionInbox: { pending: 0, quarantined: 0 },
          recentCandidates: [],
        },
      },
      mcp: {
        ok: true,
        revision: 1,
        data: {
          counts: { total: 0, enabled: 0, failed: 0, missingSecrets: 0, syncedTools: 0 },
          servers: [],
        },
      },
      work_units: {
        ok: true,
        revision: 1,
        data: {
          counts: { total: 0, active: 0, pending: 0, failed: 0, blocked: 0 },
          active: [],
          queued: [],
          stale: [],
        },
      },
      runners: {
        ok: true,
        revision: 1,
        data: {
          defaultRunnerId: runners[0]?.id ?? "pi-local",
          allowedRunnerIds: runners.map((runner) => runner.id),
          runners,
        },
      },
    },
  };
}

function readyBuiltinSkill() {
  return readySkill("qa", "builtin");
}

function readyPublishedSkill() {
  return readySkill("workspace-code-review", "published");
}

function readySkill(id, reviewStatus) {
  return {
    id,
    workspaceId: "workspace_default",
    packId: reviewStatus === "builtin" ? "gstack-default" : "workspace-custom",
    source: reviewStatus === "builtin" ? "builtin" : "custom",
    definition: {
      id,
      name: id,
      description: `Skill ${id}`,
      tools: [],
      prompts: [],
    },
    visibility: {
      workspaceVisible: true,
      promotableToWorkspace: true,
    },
    reviewStatus,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function readyChannel() {
  return {
    id: "channel_engineering",
    workspaceId: "workspace_default",
    name: "Engineering",
    boundPath: ".",
    defaultProviderPresetId: "provider_ready",
    allowedTools: ["read", "grep", "find", "ls"],
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function readyTask() {
  return {
    id: "task_ready",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: "Inspect workspace",
    prompt: "Summarize the repo.",
    status: "todo",
    assigneeTeammateId: null,
    currentRunId: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
