import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createA11PublicHttpNetworkFixture } from "./support/a11-public-http-network-fixture.mjs";

const cases = [
  "policy-private", "policy-mixed", "policy-dns", "success",
  "submit-private", "submit-mixed", "submit-dns", "submit-truncated", "submit-http-error",
  "poll-dns", "poll-truncated", "poll-http-error", "collect-truncated", "collect-http-error",
  "collect-second-truncated", "collect-second-http-error",
];
const childCase = process.env.LING_A11_PUBLIC_API_CASE;
const graph = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: "Default prompt" } },
  "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
};
// Transport/content persistence evidence, not a claim of playable generated media.
const mediaBytes = Buffer.from("A11-owned-upstream-video-bytes");

function assertIsolation(environment = process.env) {
  for (const key of ["LING_STACK_HOME", "LING_STACK_DEFAULT_WORKSPACE_CWD"]) {
    const value = environment[key];
    assert.ok(value && isAbsolute(value) && resolve(value) === value && value !== process.cwd() && value !== "/",
      `${key} must name an explicit isolated directory before product import`);
    assert.ok(statSync(value).isDirectory());
  }
}

/** Each case owns its process, listener, SQLite directory and builtin hooks. */
async function runChild(caseName) {
  const root = await mkdtemp(join(tmpdir(), "ling-a11-public-api-"));
  const home = join(root, "user"), workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const env = {
    PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC",
    LING_STACK_HOME: home, LING_STACK_DEFAULT_WORKSPACE_CWD: workspace,
    LING_A11_PUBLIC_API_CASE: caseName,
  };
  // The launcher does not import product code; validate the owned scope it
  // actually passes to the child, not unused parent-process overrides.
  assertIsolation(env);
  // Do not inherit Node test context, Provider credentials or daily user storage.
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", import.meta.filename],
    { env, stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  process.stdout.write(stdout); if (stderr) process.stderr.write(stderr);
  assert.equal(exit.signal, null, `${caseName}: child must complete rather than be killed`);
  assert.equal(exit.code, 0, `${caseName}\n${stdout}\n${stderr}`);
  assert.ok(stdout.includes(`A11 public API child entered: ${caseName}`));
  assert.match(stdout, /# tests 1\b/u); assert.match(stdout, /# pass 1\b/u);
  assert.match(stdout, /# fail 0\b/u); assert.match(stdout, /# skipped 0\b/u);
}

if (!childCase) {
  for (const caseName of cases) test(`A11 public media workflow API ${caseName}`, { timeout: 50_000 },
    () => runChild(caseName));
} else {
  test(`A11 public workflow real API child ${childCase}`, { timeout: 40_000 }, async t => {
    assertIsolation(); assert.ok(cases.includes(childCase));
    console.log(`A11 public API child entered: ${childCase}`);
    const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD;
    let mode = "healthy", daemon, db, runnerCalls = 0;
    const bodies = [];
    const fixture = await createA11PublicHttpNetworkFixture(t, {
      async onRequest(request, response, observation) {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString("utf8");
        bodies.push({ ...observation, body: text ? JSON.parse(text) : undefined });
        const url = new URL(observation.path, fixture.baseUrl), path = url.pathname;
        const submit = request.method === "POST" && path === "/api/prompt";
        const jobs = path.startsWith("/api/jobs/");
        const collect = path === "/api/view";
        const partialCollection = mode.startsWith("collect-second-");
        const selected = (submit && mode.startsWith("submit-")) || (jobs && mode.startsWith("poll-"))
          || (collect && mode.startsWith("collect-") && (!partialCollection || url.searchParams.get("filename") === "fixture-second.mp4"));
        if (selected && mode.endsWith("truncated")) {
          response.writeHead(200, { "content-type": collect ? "video/mp4" : "application/json", "content-length": "1000" });
          response.flushHeaders(); response.write("partial");
          setImmediate(() => response.destroy());
          return;
        }
        if (selected && mode.endsWith("http-error")) return sendJson(response, 500, { error: "owned-upstream-failure" });
        if (path === "/api/object_info") return sendJson(response, 200, { CLIPTextEncode: {}, SaveVideo: {} });
        if (submit) return sendJson(response, 200, { prompt_id: "fixture-prompt-1" });
        if (jobs) return sendJson(response, 200, {
          id: "fixture-prompt-1", status: "completed",
          outputs: { "9": { videos: [{ filename: "fixture.mp4", type: "output" },
            ...(partialCollection ? [{ filename: "fixture-second.mp4", type: "output" }] : [])] } },
        });
        if (collect) {
          response.writeHead(200, { "content-type": "video/mp4", "content-length": String(mediaBytes.length) });
          response.end(mediaBytes); return;
        }
        sendJson(response, 404, { error: "not_found" });
      },
    });
    try {
      // Hooks precede product import; fetch/dispatcher/Response/Host facts are real.
      const { createDaemonServer } = await import("../dist/index.js");
      const { resolveStoragePaths } = await import("../../core/dist/index.js");
      daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd }, {
        runner: { async runTask() { runnerCalls++; throw new Error("A11 workflow must not call an LLM runner"); } },
      });
      await daemon.start();
      const port = daemon.server.address().port; fixture.allowApiPort(port);
      const base = `http://127.0.0.1:${port}`;
      async function api(path, body) {
        const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, {
          method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(35_000),
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      }
      const created = await api("/media-workflow-connections", {
        name: "A11 isolated public Comfy", authMode: "none", networkPolicy: "public_only",
        protocolVariant: "jobs_v1",
        baseUrl: childCase === "policy-private" ? `http://127.0.0.1:${fixture.port}` : fixture.baseUrl,
      });
      assert.equal(created.status, 201);
      const connectionId = created.body.connection.id;
      const storagePaths = resolveStoragePaths(cwd).workspace;
      const databasePath = storagePaths.databasePath;
      assert.ok(databasePath.startsWith(`${cwd}/`) || databasePath.startsWith(`${process.env.LING_STACK_HOME}/`));
      db = new DatabaseSync(databasePath, { readOnly: true });
      const tableCount = table => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
      const definitionsBefore = tableCount("media_workflow_definitions"), versionsBefore = tableCount("media_workflow_versions");
      if (childCase.startsWith("policy-")) {
        setPolicyFailure(fixture, childCase);
        const checked = await api(`/media-workflow-connections/${connectionId}/check`, {});
        assert.equal(checked.status, 200); assert.equal(checked.body.connection.status, "error");
        assert.equal(checked.body.connection.health.ok, false);
        for (const path of ["/media-workflows/analyze", "/media-workflows/import"]) {
          const result = await api(path, { connectionId, name: "Must not persist", graph });
          assert.equal(result.status, 400); assert.equal(result.body.error, "media_workflow_error");
        }
        const listed = await api("/media-workflows");
        assert.equal(listed.status, 200); assert.deepEqual(listed.body.workflows, []);
        const connection = await api(`/media-workflow-connections/${connectionId}`);
        assert.equal(connection.body.connection.status, "error"); assert.equal(connection.body.connection.health.ok, false);
        const stored = db.prepare("SELECT status,health_json FROM media_workflow_connections WHERE id=?").get(connectionId);
        assert.equal(stored.status, "error"); assert.equal(JSON.parse(stored.health_json).ok, false);
        assert.equal(tableCount("media_workflow_definitions"), definitionsBefore);
        assert.equal(tableCount("media_workflow_versions"), versionsBefore);
        assert.equal(tableCount("media_jobs"), 0); assert.equal(tableCount("work_units"), 0);
        assert.equal(fixture.requests.length, 0);
        assert.equal(fixture.connects.filter(item => item.kind === "upstream").length, 0);
      } else {
        const checked = await api(`/media-workflow-connections/${connectionId}/check`, {});
        assert.equal(checked.status, 200); assert.equal(checked.body.connection.status, "ready");
        assert.equal(checked.body.connection.health.ok, true);
        const imported = await api("/media-workflows/import", { connectionId, name: "A11 graph", graph });
        assert.equal(imported.status, 201); assert.equal(imported.body.analysis.validation.ok, true);
        assert.equal(tableCount("media_workflow_definitions"), definitionsBefore + 1);
        assert.equal(tableCount("media_workflow_versions"), versionsBefore + 1);
        const definitionId = imported.body.definition.id, versionId = imported.body.importedVersion.id;
        const connectionSnapshot = db.prepare("SELECT * FROM media_workflow_connections WHERE id=?").get(connectionId);
        const definitionSnapshot = db.prepare("SELECT * FROM media_workflow_definitions WHERE id=?").get(definitionId);
        const versionSnapshot = { ...db.prepare("SELECT * FROM media_workflow_versions WHERE id=?").get(versionId) };
        delete versionSnapshot.test_media_job_id;
        const prompt = imported.body.importedVersion.inputFields.find(field => field.semantic === "prompt");
        assert.ok(prompt); mode = childCase;
        if (childCase.startsWith("submit-")) setPolicyFailure(fixture, childCase);
        const inputValues = { [prompt.id]: "A11 real API persistence" };
        const submitted = await api(`/media-workflows/${definitionId}/test`, {
          versionId, inputValues,
        });
        assert.equal(submitted.status, 202); assert.equal(submitted.body.mediaJob.status, "queued");
        const jobId = submitted.body.mediaJob.id;
        if (childCase === "poll-dns") {
          await waitUntil(async () => db.prepare("SELECT external_operation_id FROM media_job_execution_handles WHERE media_job_id=?")
            .get(jobId)?.external_operation_id === "fixture-prompt-1", "durable submitted handle");
          fixture.setDnsFailure(Object.assign(new Error("owned post-submission DNS failure"), { code: "ENOTFOUND" }));
        }
        const expected = childCase === "success" ? "succeeded" : "failed";
        const terminal = await waitUntil(async () => {
          const result = await api(`/media-jobs/${jobId}`);
          assert.equal(result.status, 200);
          if (result.body.mediaJob.status !== expected) return undefined;
          const unit = db.prepare("SELECT * FROM work_units WHERE linked_media_job_id=?").get(jobId);
          const attempt = unit?.active_attempt_id
            ? db.prepare("SELECT * FROM work_unit_attempts WHERE id=?").get(unit.active_attempt_id) : undefined;
          return unit?.status === expected && attempt?.status === expected ? result.body.mediaJob : undefined;
        }, `${jobId} ${expected}`);
        const jobRow = db.prepare("SELECT * FROM media_jobs WHERE id=?").get(jobId);
        assert.equal(jobRow.status, expected);
        assert.equal(jobRow.source_kind, "workflow");
        assert.equal(jobRow.provider_preset_id, null);
        assert.equal(jobRow.workflow_version_id, versionId);
        assert.equal(terminal.executionSource.kind, "workflow");
        assert.equal(terminal.executionSource.workflowVersionId, versionId);
        assert.equal(jobRow.prompt, inputValues[prompt.id]);
        assert.deepEqual(JSON.parse(jobRow.input_json), { workflowInputValues: inputValues, workflowTest: true });
        assert.deepEqual(db.prepare("SELECT * FROM media_workflow_connections WHERE id=?").get(connectionId), connectionSnapshot,
          "execution failure must not erase or silently edit its configured connection");
        assert.deepEqual(db.prepare("SELECT * FROM media_workflow_definitions WHERE id=?").get(definitionId), definitionSnapshot);
        const versionAfter = { ...db.prepare("SELECT * FROM media_workflow_versions WHERE id=?").get(versionId) };
        assert.equal(versionAfter.test_media_job_id, jobId);
        delete versionAfter.test_media_job_id;
        assert.deepEqual(versionAfter, versionSnapshot, "graph/source digest/mappings/validation remain unchanged");
        const units = db.prepare("SELECT * FROM work_units WHERE linked_media_job_id=?").all(jobId);
        assert.equal(units.length, 1); const unit = units[0]; assert.equal(unit.status, expected);
        assert.equal(unit.attempt_count, 1);
        const attempts = db.prepare("SELECT * FROM work_unit_attempts WHERE work_unit_id=?").all(unit.id);
        assert.equal(attempts.length, 1); assert.equal(attempts[0].status, expected);
        assert.equal(unit.active_attempt_id, attempts[0].id);
        const slots = db.prepare("SELECT * FROM runtime_semaphore_slots WHERE work_unit_id=? AND attempt_id=?")
          .all(unit.id, attempts[0].id);
        assert.ok(slots.length >= 1, "the exact Attempt must really have acquired a provider semaphore");
        for (const slot of slots) {
          assert.equal(slot.owner_type, "work_unit_attempt"); assert.equal(slot.owner_id, attempts[0].id);
          assert.equal(slot.resource_type, "media_provider"); assert.equal(slot.resource_key, `workflow:${connectionId}`);
          assert.equal(slot.fencing_token, attempts[0].fencing_token);
          assert.equal(slot.runtime_instance_id, attempts[0].runtime_instance_id);
          assert.equal(slot.status, "released"); assert.ok(slot.acquired_at); assert.ok(slot.released_at);
        }
        const acquired = db.prepare("SELECT * FROM runtime_events WHERE work_unit_id=? AND attempt_id=? AND type='semaphore_acquired'")
          .all(unit.id, attempts[0].id);
        assert.ok(acquired.length >= 1);
        for (const event of acquired) {
          assert.equal(event.fencing_token, attempts[0].fencing_token);
          const data = JSON.parse(event.data_json);
          assert.ok(slots.some(slot => slot.id === data.id)); assert.equal(data.resourceKey, `workflow:${connectionId}`);
        }
        assert.equal(db.prepare("SELECT count(*) AS count FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active'")
          .get(attempts[0].id).count, 0, "terminal exact Attempt retains zero active provider slots");
        const posts = fixture.requests.filter(item => item.method === "POST" && item.path === "/api/prompt");
        const deniedSubmission = ["submit-private", "submit-mixed", "submit-dns"].includes(childCase);
        assert.equal(posts.length, deniedSubmission ? 0 : 1, "no implicit POST replay");
        const partialCollection = childCase.startsWith("collect-second-");
        const artifacts = db.prepare("SELECT id,path,size_bytes FROM artifacts WHERE media_job_id=? AND type='video'").all(jobId);
        if (expected === "failed") {
          assert.ok(terminal.errorMessage); assert.ok(jobRow.error_message);
          assert.ok(unit.error_code); assert.equal(unit.error_code, attempts[0].error_code);
          const expectedArtifacts = partialCollection ? 1 : 0;
          assert.equal(artifacts.length, expectedArtifacts);
          assert.deepEqual(JSON.parse(jobRow.artifact_ids_json), artifacts.map(artifact => artifact.id));
          assert.deepEqual(terminal.artifactIds, artifacts.map(artifact => artifact.id));
          assert.equal(db.prepare("SELECT count(*) AS count FROM runtime_events WHERE work_unit_id=? AND type='work_unit_succeeded'")
            .get(unit.id).count, 0);
          assert.ok(!fixture.requests.some(item => new URL(item.path, fixture.baseUrl).pathname === "/api/view")
            || childCase.startsWith("collect-"));
          const activation = await api(`/media-workflows/${definitionId}/activate`, { versionId });
          assert.equal(activation.status, 400);
          assert.equal(activation.body.error, "media_workflow_error");
          assert.match(activation.body.message, /试运行.*未成功/);
          assert.deepEqual(db.prepare("SELECT * FROM media_workflow_definitions WHERE id=?").get(definitionId), definitionSnapshot,
            "a failed test cannot activate or erase the draft definition");
        } else {
          assert.equal(terminal.artifactIds.length, 1);
          assert.equal(artifacts.length, 1);
        }
        if (expected === "succeeded" || partialCollection) {
          assert.equal(artifacts[0].size_bytes, mediaBytes.length);
          assert.equal(isAbsolute(artifacts[0].path), false, "stored artifact paths are relative to the artifact root");
          const absoluteArtifactPath = resolve(storagePaths.artifactsDir, artifacts[0].path);
          assert.ok(absoluteArtifactPath.startsWith(`${storagePaths.artifactsDir}/`));
          assert.deepEqual(await readFile(absoluteArtifactPath), mediaBytes);
        }
        const handle = db.prepare("SELECT * FROM media_job_execution_handles WHERE media_job_id=?").get(jobId);
        if (childCase.startsWith("poll-") || childCase.startsWith("collect-")) {
          assert.ok(handle, "poll/collect failure must retain the actual submitted operation, not a pending intent");
          assert.equal(handle.adapter_kind, "comfyui"); assert.equal(handle.external_operation_id, "fixture-prompt-1");
          assert.equal(handle.next_poll_at, null); assert.equal(handle.work_unit_id, null); assert.equal(handle.attempt_id, null);
          assert.equal(handle.poll_attempts, childCase.startsWith("collect-") ? 1 : 0,
            "settlement preserves the real submitted poll counter: failed first poll=0, terminal observation before collect=1");
          const recovery = JSON.parse(handle.recovery_json);
          assert.equal(recovery.protocolVariant, "jobs_v1"); assert.equal(recovery.workflowVersionId, versionId);
          if (childCase.startsWith("collect-")) {
            assert.equal(recovery.resultPayload.status, "completed");
            const downloads = fixture.requests.filter(item => new URL(item.path, fixture.baseUrl).pathname === "/api/view");
            assert.equal(downloads.length, partialCollection ? 2 : 1);
            if (partialCollection) assert.deepEqual(downloads.map(item => new URL(item.path, fixture.baseUrl).searchParams.get("filename")),
              ["fixture.mp4", "fixture-second.mp4"], "the first real download succeeds before the second fails");
          } else assert.equal(Object.hasOwn(recovery, "resultPayload"), false, "failed poll must not invent terminal output recovery");
        } else {
          assert.equal(handle, undefined, "submit failure and successful completion delete their pending/execution handle");
        }
        // Let an accidental zero-delay resubmit surface; do not shorten product poll timers.
        await delay(100);
        assert.equal(fixture.requests.filter(item => item.method === "POST" && item.path === "/api/prompt").length, posts.length);
        console.log(`A11 API SQLite lineage: ${JSON.stringify({ case: childCase, jobId, job: jobRow.status,
          unitId: unit.id, unit: unit.status, attemptId: attempts[0].id, attempt: attempts[0].status,
          errorCode: unit.error_code, posts: posts.length, artifacts: terminal.artifactIds.length,
          acquiredSlots: slots.length, releasedSlots: slots.filter(slot => slot.status === "released").length,
          acquiredEvents: acquired.length, retainedHandle: handle?.external_operation_id ?? null,
          handleSchedule: handle ? { nextPollAt: handle.next_poll_at, workUnitId: handle.work_unit_id,
            attemptId: handle.attempt_id, pollAttempts: handle.poll_attempts } : null })}`);
      }
      assert.equal(runnerCalls, 0);
      assert.ok(fixture.requests.every(item => item.host === `${fixture.hostname}:${fixture.port}`), "original Host preserved");
      assert.ok(fixture.connects.every(item => item.allowed), "no unowned network destination");
      console.log(`A11 API network evidence: ${JSON.stringify({ case: childCase, node: process.version,
        databasePath, runnerCalls, requests: fixture.requests, connects: fixture.connects,
        upstreamDns: fixture.dnsLookups.filter(item => item.hostname === fixture.hostname), bodies })}`);
    } finally {
      db?.close();
      try { await daemon?.stop(); } finally { await fixture.close(); }
    }
  });
}

function setPolicyFailure(fixture, caseName) {
  if (caseName.endsWith("mixed")) fixture.setDnsAnswers(["203.0.113.10", "127.0.0.1"]);
  else if (caseName.endsWith("dns")) fixture.setDnsFailure(Object.assign(new Error("owned DNS rejection"), { code: "ENOTFOUND" }));
  else if (caseName === "submit-private") fixture.setDnsAnswers(["127.0.0.1"]);
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}

async function waitUntil(read, label) {
  const deadline = Date.now() + 12_000;
  do {
    const result = await read(); if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`A11 timed out waiting for ${label}`);
}
