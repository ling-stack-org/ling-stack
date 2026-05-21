import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const defaultToolDecisions = {
  read: "allow",
  grep: "allow",
  find: "allow",
  ls: "allow",
  bash: "ask",
  edit: "ask",
  write: "ask",
};
const defaultAllowedWritePaths = ["."];

test("policy show reads the workspace approval policy", async () => {
  const daemon = await startPolicyDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-policy-"));
  try {
    const result = await runCli(daemon.url, cwd, ["policy", "show"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Workspace: workspace_default/);
    assert.match(result.stdout, /bash\s+ask/);
    assert.match(result.stdout, /Allowed write paths: \./);
    assert.deepEqual(daemon.requests.map((request) => request.method), ["GET"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("policy set sends tool decisions and allowed write paths", async () => {
  const daemon = await startPolicyDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-policy-"));
  try {
    const result = await runCli(daemon.url, cwd, [
      "policy",
      "set",
      "--tool",
      "bash=allow",
      "--tool",
      "write=deny",
      "--write-path",
      ".",
      "--write-path",
      "docs",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /bash\s+allow/);
    assert.match(result.stdout, /write\s+deny/);
    assert.match(result.stdout, /Allowed write paths: \., docs/);
    assert.deepEqual(daemon.requests.at(-1), {
      method: "PATCH",
      body: {
        toolDecisions: {
          bash: "allow",
          write: "deny",
        },
        allowedWritePaths: [".", "docs"],
      },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("policy reset restores default decisions and write paths", async () => {
  const daemon = await startPolicyDaemon({
    toolDecisions: {
      ...defaultToolDecisions,
      bash: "allow",
      write: "deny",
    },
    allowedWritePaths: [".", "docs"],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-policy-"));
  try {
    const result = await runCli(daemon.url, cwd, ["policy", "reset"]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(daemon.requests.at(-1), {
      method: "PATCH",
      body: {
        toolDecisions: defaultToolDecisions,
        allowedWritePaths: defaultAllowedWritePaths,
      },
    });
    assert.match(result.stdout, /write\s+ask/);
    assert.match(result.stdout, /Allowed write paths: \./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("policy set rejects invalid tool decisions before contacting the daemon", async () => {
  const result = await runCli("http://127.0.0.1:9", process.cwd(), [
    "policy",
    "set",
    "--tool",
    "write=maybe",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /bad_decision/);
});

function runCli(daemonUrl, cwd, args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliPath, "--daemon-url", daemonUrl, "--cwd", cwd, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function startPolicyDaemon(initialPolicy = {}) {
  const requests = [];
  let policy = {
    workspaceId: "workspace_default",
    toolDecisions: {
      ...defaultToolDecisions,
      ...(initialPolicy.toolDecisions ?? {}),
    },
    allowedWritePaths: initialPolicy.allowedWritePaths ?? defaultAllowedWritePaths,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/approval-policy" || !url.searchParams.get("cwd")) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "GET") {
      requests.push({ method: "GET" });
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), policy });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request);
      requests.push({ method: "PATCH", body });
      policy = {
        ...policy,
        toolDecisions: {
          ...policy.toolDecisions,
          ...(body.toolDecisions ?? {}),
        },
        allowedWritePaths: body.allowedWritePaths ?? policy.allowedWritePaths,
        updatedAt: "2026-05-21T00:01:00.000Z",
      };
      writeJson(response, 200, { cwd: url.searchParams.get("cwd"), policy });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed" });
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

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolveBody(body.trim() ? JSON.parse(body) : {});
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
