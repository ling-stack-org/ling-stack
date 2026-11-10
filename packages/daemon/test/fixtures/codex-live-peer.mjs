import { createPng } from "../support/native-image-fixtures.mjs";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

const scenario = process.env.LING_CODEX_PEER_SCENARIO;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let selection;
let turnId;
const pendingReplies = new Set();
const thread = () => ({ id: "thread-1", cwd: selection.cwd, model: selection.model,
  modelProvider: selection.modelProvider, turns: [], status: { type: "idle" } });
const turn = (status = "inProgress") => ({ id: turnId, items: [], itemsView: "full", status,
  error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: null });
const complete = (status = "completed") => send({ method: "turn/completed", params: { threadId: "thread-1", turn: turn(status) } });
let index = 0;
process.on("message", message => {
  if (message?.kind === "stream-during-approval" && turnId) {
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "item-1", delta: "stream while human waits" } });
  }
  if (message?.kind === "resolve-approval" && turnId) {
    send({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: `approval-${index}` } });
  }
  if (message?.kind === "patch-update" && turnId) {
    const params = { threadId: "thread-1", turnId, itemId: "item-2", changes: message.changes };
    send({ method: "item/fileChange/patchUpdated", params });
    if (message.finalize) send({ method: "item/started", params: { threadId: params.threadId, turnId,
      item: { type: "fileChange", id: params.itemId, status: "inProgress", changes: params.changes } } });
  }
});
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  process.send?.(message);
  const { id, method, params } = message;
  if (method === "initialize") {
    if (scenario === "hold-initialize") continue;
    send({ id, result: { userAgent: "owned-node-peer", codexHome: process.env.CODEX_HOME ?? "/tmp/ling-codex-live-home",
      platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform } });
  } else if (method === "thread/start" || method === "thread/resume") {
    selection = params;
    const sandbox = params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
    const result = { thread: thread(), model: params.model, modelProvider: params.modelProvider, cwd: params.cwd,
      approvalPolicy: params.approvalPolicy, approvalsReviewer: "user", sandbox };
    if (scenario === "wrong-cwd") result.cwd = "/tmp/wrong";
    if (scenario === "wrong-model") result.model = "another-model";
    if (scenario === "wrong-provider") result.modelProvider = "another-provider";
    if (scenario === "wrong-policy") result.approvalPolicy = "never";
    if (scenario === "wrong-sandbox") result.sandbox.networkAccess = true;
    if (scenario === "wrong-thread") result.thread.id = "another-thread";
    if (scenario?.includes("environment")) {
      const environment = { environmentId: "local", cwd: params.cwd, runtimeWorkspaceRoots: [params.cwd] };
      result.thread.environments = [environment];
      if (scenario === "wrong-environment-id") environment.environmentId = "remote-1";
      if (scenario === "wrong-environment-cwd") environment.cwd = "/tmp/foreign-workspace";
      if (scenario === "wrong-environment-cwd-alias") environment.cwd = `${params.cwd}/alias/..`;
      if (scenario === "wrong-environment-roots") environment.runtimeWorkspaceRoots.push("/tmp/foreign-workspace");
      if (scenario === "wrong-environment-roots-alias") environment.runtimeWorkspaceRoots = [`${params.cwd}/alias/..`];
      if (scenario === "wrong-environment-shape") environment.runtimeWorkspaceRoots = null;
      if (scenario === "wrong-environment-duplicate") result.thread.environments.push({ ...environment });
      if (scenario === "wrong-environment-null") result.thread.environments = null;
    }
    send({ id, result });
  } else if (method === "turn/start") {
    if (scenario === "lost-response") process.exit(0);
    turnId = `${process.env.LING_CODEX_PEER_TURN_PREFIX ?? ""}turn-${++index}`;
    const threadId = scenario === "cross-thread" ? "another-thread" : "thread-1";
    if (scenario === "image-output" || scenario === "image-output-large" || scenario === "image-terminal-invalid") {
      const raw = randomBytes(768 * 512 * 4);
      raw.set([224, 59, 82, 255]);
      const bytes = scenario === "image-output-large" ? createPng({ width: 768, height: 512, data: raw })
        : createPng();
      send({ id, result: { turn: turn() } });
      send({ method: "turn/started", params: { threadId, turn: turn() } });
      const initial = { type: "imageGeneration", id: "image-1", status: "in_progress", result: "", revisedPrompt: null, failure: null };
      send({ method: "item/started", params: { threadId, turnId, item: initial } });
      const image = { ...initial, status: "completed", result: bytes.toString("base64"), savedPath: "/untrusted/private.png" };
      if (scenario === "image-terminal-invalid") image.result = "bm90IGEgcG5n";
      else send({ method: "item/completed", params: { threadId, turnId, item: image } });
      const message = { type: "agentMessage", id: "after-image", text: "image ready" };
      send({ method: "item/completed", params: { threadId, turnId, item: message } });
      send({ method: "turn/completed", params: { threadId, turn: { ...turn("completed"), items: [image, message] } } });
      continue;
    }
    if (scenario === "rich-output") {
      const picture = createPng();
      send({ id, result: { turn: turn() } });
      send({ method: "turn/started", params: { threadId, turn: turn() } });
      const tools = [
        [{ type: "dynamicToolCall", id: "rich-dynamic", namespace: null, tool: "lookup", arguments: {} },
          { contentItems: [{ type: "inputText", text: "rich output", _meta: { value: "private fixture metadata" } },
            { type: "inputImage", imageUrl: `data:image/png;base64,${picture.toString("base64")}` }], success: true }],
        [{ type: "mcpToolCall", id: "rich-mcp", server: "owned", tool: "read", arguments: {} },
          { result: { content: [{ type: "resource", resource: { uri: "owned://document", text: "document",
            _meta: { value: "private fixture metadata" } } }], structuredContent: null, _meta: { value: "private fixture metadata" } }, error: null }],
        [{ type: "webSearch", id: "rich-search", query: "", action: null, results: null },
          { query: "Ling", action: { type: "search", query: "Ling", queries: null }, results: [{ title: "Ling", url: "https://example.com" }] }],
        [{ type: "imageView", id: "rich-image", path: "/nonexistent/owned.png" }, {}],
        [{ type: "sleep", id: "rich-sleep", durationMs: 3600000 }, {}],
        [{ type: "collabAgentToolCall", id: "rich-collab", tool: "spawnAgent", senderThreadId: threadId,
          prompt: "owned", model: null, reasoningEffort: null, receiverThreadIds: [], agentsStates: {} },
          { receiverThreadIds: ["child"], agentsStates: { child: { status: "errored", message: "owned child error" } } }],
      ];
      for (const [initial, result] of tools) {
        send({ method: "item/started", params: { threadId, turnId, item: { ...initial, status: "inProgress" } } });
        send({ method: "item/completed", params: { threadId, turnId, item: { ...initial, ...result, status: "completed" } } });
      }
      for (const value of [
        { type: "functionCallOutput", id: "rich-function", name: "lookup", namespace: null,
          output: [{ type: "input_text", text: "returned" }, { type: "encrypted_content", encrypted_content: "private fixture metadata" }] },
        { type: "subAgentActivity", id: "rich-activity", kind: "started", agentThreadId: "child", agentPath: "/child" },
      ]) {
        for (const stage of ["started", "completed"]) send({ method: `item/${stage}`, params: { threadId, turnId, item: value } });
      }
      complete();
      continue;
    }
    if (scenario === "output-events" || scenario === "empty-output") {
      send({ id, result: { turn: turn() } });
      send({ method: "turn/started", params: { threadId, turn: turn() } });
      if (scenario === "output-events") {
        const item = { type: "commandExecution", id: "tool-output-1", command: "echo owned", cwd: params.cwd,
          status: "inProgress", exitCode: null, aggregatedOutput: null, durationMs: null };
        send({ method: "item/started", params: { threadId, turnId, item } });
        send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: item.id, delta: "owned output " } });
        send({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed", exitCode: 0, aggregatedOutput: "owned output " } } });
        const reasoning = { type: "reasoning", id: "reason-output-1", summary: ["first step", "second owned secret step"], content: [] };
        for (const [summaryIndex, delta] of reasoning.summary.entries()) {
          if (summaryIndex > 0) send({ method: "item/reasoning/summaryPartAdded", params: { threadId, turnId, itemId: reasoning.id, summaryIndex } });
          send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: reasoning.id, summaryIndex, delta } });
        }
        send({ method: "item/completed", params: { threadId, turnId, item: reasoning } });
        for (const delta of ["answer owned ", "secret done "]) send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "text-output-1", delta } });
        send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "text-output-1", text: "answer owned secret done " } } });
      }
      complete();
      continue;
    }
    send({ method: "turn/started", params: { threadId, turn: turn() } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "item-1", delta: "live before approval" } });
    if (!scenario?.startsWith("hold")) {
      const common = { threadId, turnId, itemId: "item-2", startedAtMs: 1 };
      if (scenario?.startsWith("file") && scenario !== "file-missing") {
        const item = { type: "fileChange", id: common.itemId, status: "inProgress",
          changes: [{ path: "owned-fixture.txt", kind: { type: "update", move_path: null }, diff: "-before\n+after" }] };
        if (scenario === "file-move-outside") item.changes[0].kind.move_path = "../outside.txt";
        if (scenario === "file-stream" || scenario === "file-preview-only") {
          for (const diff of ["+partial", "+partial complete\n"]) send({ method: "item/fileChange/patchUpdated", params: {
            threadId, turnId, itemId: item.id, changes: [{ path: "preview-only.txt", kind: { type: "add" }, diff }],
          } });
        }
        if (scenario !== "file-preview-only") send({ method: "item/started", params: { threadId, turnId, item } });
        if (scenario === "file-completed") send({ method: "item/completed", params: { threadId, turnId, item: { ...item, status: "completed" } } });
      }
      const request = scenario?.startsWith("file")
        ? { method: "item/fileChange/requestApproval", params: { ...common, grantRoot: scenario === "file-session" ? params.cwd : null } }
        : scenario?.startsWith("permissions")
          ? { method: "item/permissions/requestApproval", params: { ...common, environmentId: null, cwd: params.cwd,
            reason: "Owned fixture", permissions: { network: { enabled: true }, fileSystem: null } } }
          : { method: "item/commandExecution/requestApproval", params: { ...common, kind: "command", environmentId: null,
            command: "whois example.com", cwd: params.cwd } };
      if (scenario === "permissions-files") request.params.permissions = { network: null, fileSystem: {
        read: null, write: null, globScanMaxDepth: 3, entries: [
          { access: "write", path: { type: "path", path: `${params.cwd}/owned-fixture.txt` } },
          { access: "read", path: { type: "glob_pattern", pattern: `${params.cwd}/src/**/*.ts` } },
          { access: "deny", path: { type: "path", path: `${params.cwd}/.ling-stack` } },
        ],
      } };
      if (scenario === "wrapped-plan") request.params.command = "/bin/zsh -lc 'touch owned-fixture.txt'";
      if (scenario === "native-no-accept") request.params.availableDecisions = ["decline", "cancel"];
      if (scenario === "command-permissions") request.params.additionalPermissions = { network: { enabled: true } };
      if (scenario === "file-local-environment") request.params.environmentId = "local";
      if (scenario?.startsWith("local-environment")) {
        request.params.environmentId = scenario === "local-environment-foreign-request" ? "remote-1" : "local";
        request.params.availableDecisions = ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["whois"] } }, "cancel"];
        if (scenario === "local-environment-expanded-command") request.params.additionalPermissions = { network: { enabled: true } };
      }
      if (scenario === "user-input") {
        request.method = "item/tool/requestUserInput";
        request.params = { ...common, questions: [{ id: "q1", header: "Choice", question: "Continue?", isOther: false,
          isSecret: false, options: [{ label: "Continue", description: "Continue the fixture" }] }] };
      }
      if (scenario === "file-queued") {
        pendingReplies.add("approval-blocker");
        pendingReplies.add(`approval-${index}`);
        send({ id: "approval-blocker", method: "item/commandExecution/requestApproval", params: {
          ...common, itemId: "blocker-item", command: "whois example.org", cwd: params.cwd,
        } });
      }
      send({ id: `approval-${index}`, ...request });
      if (scenario === "two-approvals") {
        pendingReplies.add(`approval-${index}`);
        pendingReplies.add("approval-extra");
        send({ id: "approval-extra", ...request, params: { ...request.params, itemId: "item-3", command: "whois example.org" } });
      }
    }
    if (scenario === "duplicate-response") {
      const response = JSON.stringify({ id, result: { turn: turn() } }) + "\n";
      process.stdout.write(response + response);
    } else send({ id, result: { turn: turn() } });
    if (scenario === "reroute") send({ method: "model/rerouted", params: { threadId, turnId, fromModel: params.model, toModel: "other-model", reason: "rateLimit" } });
    if (scenario === "resolved") {
      send({ method: "serverRequest/resolved", params: { threadId, requestId: `approval-${index}` } });
      complete();
    }
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    if (scenario === "hold-ignore-interrupt") continue;
    complete("interrupted");
  } else if (!method && (id === `approval-${index}` || pendingReplies.has(id))) {
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId, itemId: "item-1", delta: "after decision" } });
    pendingReplies.delete(id);
    if (!pendingReplies.size) complete();
  }
}
