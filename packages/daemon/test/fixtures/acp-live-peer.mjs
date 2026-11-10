import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let active;
let workspaceCwd;
let fileAction;
let terminalId;
let terminalText;
let oauthCommand;
const engine = process.env.LING_ACP_PEER_ENGINE;
const scenario = process.env.LING_ACP_PEER_OUTPUT;
const configured = process.env.LING_ACP_PEER_CONFIGURATION === "true";
const select = (id, currentValue, values) => ({ id, name: id, type: "select", currentValue,
  options: values.map(value => ({ value, name: value })) });
let configOptions = engine === "kimi-acp" ? [select("model", "model-a", ["model-a", "model-b"]),
  select("mode", "default", ["default", "plan", "auto", "yolo"]), select("thinking", "low", ["low", "high"])]
  : [select("thought_level", "low", ["low", "high"])];
let modes = { currentModeId: engine === "kimi-acp" ? "default" : "low", availableModes:
  (engine === "kimi-acp" ? ["default", "plan", "auto", "yolo"] : ["low", "high"]).map(id => ({ id, name: id })) };
let writes = Promise.resolve();
const send = value => {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  writes = writes.then(async () => {
    const split = Math.max(1, bytes.indexOf(Buffer.from("中文")) + 1);
    for (const chunk of [bytes.subarray(0, split), bytes.subarray(split)]) {
      await new Promise((resolve, reject) => process.stdout.write(chunk, error => error ? reject(error) : resolve()));
    }
  });
  return writes;
};
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const update = text => send({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId: "owned-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
} });

async function requestOAuthModel() {
  const configuration = JSON.parse(process.env.LING_ACP_MODEL_PROJECTION);
  const model = configuration.models[configuration.default_model], provider = configuration.providers[model.provider];
  const response = await fetch(`${provider.base_url}/chat/completions`, { method: "POST",
    headers: { ...provider.custom_headers, "content-type": "application/json" },
    body: JSON.stringify({ model: model.model, stream: true, messages: [] }) });
  if (response.status !== 200) throw Error("Synthetic OAuth relay failed");
  const text = await response.text();
  for (let index = 0; index < text.length; index += 7) await update(text.slice(index, index + 7));
  return text;
}

if (scenario === "oauth-pending") process.on("message", message => {
  if (message?.method !== "fixture-refresh" || active === undefined) return;
  void requestOAuthModel().then(() => process.send?.({ method: "owned-oauth-refreshed" }), () => {
    process.stderr.write("Synthetic pending OAuth request failed\n"); process.exit(1);
  });
});

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  process.send?.(message);
  switch (message.method) {
    case "initialize":
      if (scenario === "hold-initialize") break;
      await result(message.id, { protocolVersion: 1, agentInfo: {
        name: engine === "openclaw-acp" ? "openclaw-acp" : "Kimi Code CLI", version: "owned-peer-1",
      }, agentCapabilities: { loadSession: true }, authMethods: [] });
      break;
    case "session/new":
      workspaceCwd = message.params.cwd;
      await result(message.id, { sessionId: "owned-session", ...(configured ? { configOptions, modes } : {}) }); break;
    case "session/load": workspaceCwd = message.params.cwd; await result(message.id, configured ? { configOptions, modes } : {}); break;
    case "session/set_config_option":
      if (configured) {
        const { configId, value } = message.params;
        const option = configOptions.find(option => option.id === configId);
        if (message.params.sessionId !== "owned-session" || !option?.options.some(option => option.value === value)) {
          await send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid fixture configuration" } }); break;
        }
        configOptions = configOptions.map(option => option.id === configId ? { ...option, currentValue: value } : option);
        if (configId === "mode" || configId === "thought_level") {
          modes = { ...modes, currentModeId: value };
          await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
            update: { sessionUpdate: "current_mode_update", currentModeId: value } } });
        }
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "config_option_update", configOptions } } });
        await result(message.id, { configOptions });
      }
      break;
    case "session/prompt":
      active = message.id;
      if (scenario?.startsWith("oauth-")) {
        const text = await requestOAuthModel();
        oauthCommand = `/usr/bin/printf '%s' '${text}'`;
        if (scenario === "oauth-pending") process.send?.({ method: "owned-oauth-command", params: { command: oauthCommand } });
      }
      if (scenario?.startsWith("model-relay")) {
        const configuration = JSON.parse(process.env.LING_ACP_MODEL_PROJECTION);
        const model = configuration.models[configuration.default_model], provider = configuration.providers[model.provider];
        const headers = { ...provider.custom_headers, "content-type": "application/json", authorization: "Bearer native-placeholder" };
        let response;
        try {
          response = await fetch(`${provider.base_url}/chat/completions`, { method: "POST", headers,
            body: JSON.stringify({ model: model.model, stream: true, messages: [] }) });
          const text = await response.text();
          let directBlocked = false;
          try { await fetch(`${process.env.LING_ACP_MODEL_UPSTREAM}/chat/completions`, { signal: AbortSignal.timeout(1500) }); }
          catch { directBlocked = true; }
          let credentialsBlocked = false;
          try { readFileSync(join(process.env.LING_ACP_NATIVE_HOME, "credentials", "sentinel")); }
          catch (error) { credentialsBlocked = error.code === "EPERM" || error.code === "EACCES"; }
          process.send?.({ method: "owned-model-result", params: { status: response.status, text, directBlocked, credentialsBlocked,
            configContainsSecret: readFileSync(join(process.env.KIMI_CODE_HOME, "config.toml"), "utf8").includes("host-secret-sentinel") } });
        } catch {
          if (scenario === "model-relay-hold") break;
          throw Error("Owned model request failed");
        }
        await update("Inference finished.");
        await result(active, { stopReason: "end_turn" }); active = undefined;
        break;
      }
      if (scenario === "lost-response") { process.exit(0); }
      if (scenario === "result-only") {
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "usage_update", used: 1, size: 100 } } });
        await result(active, { stopReason: "end_turn" }); active = undefined;
        break;
      }
      if (["max_tokens", "max_turn_requests", "refusal"].includes(scenario)) {
        await update("Stopped without completing the requested task.");
        await result(active, { stopReason: scenario }); active = undefined;
        break;
      }
      if (scenario === "hold" || scenario === "hold-ignore-cancel") {
        await update("Waiting for explicit cancellation.");
        break;
      }
      if (scenario === "host-read") {
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "tool_call", toolCallId: "1:host-read", title: "Read fixture text", kind: "read",
            status: "in_progress", rawInput: { path: "native-file.txt", line_offset: 2, n_lines: 1 } } } });
        await send({ jsonrpc: "2.0", id: "owned-host-read", method: "fs/read_text_file",
          params: { sessionId: "owned-session", path: join(workspaceCwd, "native-file.txt") } });
        break;
      }
      if (scenario === "host-terminal") {
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "tool_call", toolCallId: "1:host-terminal", title: "Bash fixture", kind: "execute",
            status: "in_progress", rawInput: { command: "./fixture-command" } } } });
        await send({ jsonrpc: "2.0", id: "owned-host-terminal", method: "terminal/create", params: {
          sessionId: "owned-session", command: "/bin/bash", cwd: workspaceCwd,
          args: ["-c", `cd '${workspaceCwd.replaceAll("'", "'\\''")}' && ./fixture-command`],
          env: [{ name: "NO_COLOR", value: "1" }, { name: "TERM", value: "dumb" },
            { name: "GIT_TERMINAL_PROMPT", value: "0" }, { name: "SHELL", value: "/bin/bash" }] } });
        break;
      }
      if (["host-write", "host-append", "host-edit", "host-write-token"].includes(scenario)) {
        const token = scenario === "host-write-token" ? Object.values(JSON.parse(process.env.LING_ACP_MODEL_PROJECTION).providers)[0].custom_headers["x-ling-model-token"] : undefined;
        fileAction = scenario === "host-edit"
          ? { tool: "Edit", input: { path: "native-file.txt", old_string: "First", new_string: "Second", replace_all: true } }
          : { tool: "Write", input: { path: "native-file.txt", content: token ?? (scenario === "host-append" ? "\nAdded" : "Replaced"),
            ...(scenario === "host-append" ? { mode: "append" } : {}) } };
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "tool_call", toolCallId: "1:host-write", title: "File operation", kind: "edit",
            status: "in_progress", rawInput: fileAction.input } } });
        await send({ jsonrpc: "2.0", id: scenario.startsWith("host-write") ? "owned-host-write" : "owned-host-baseline",
          method: scenario.startsWith("host-write") ? "fs/write_text_file" : "fs/read_text_file",
          params: { sessionId: "owned-session", path: join(workspaceCwd, "native-file.txt"),
            ...(scenario.startsWith("host-write") ? { content: fileAction.input.content } : {}) } });
        break;
      }
      if (scenario === "native-boundary") {
        const attempt = operation => { try { return { value: operation() }; } catch (error) { return { code: error.code }; } };
        const observations = {
          workspaceWrite: attempt(() => { writeFileSync(join(workspaceCwd, "boundary-output.txt"), "Workspace output"); return "written"; }),
          sessionWrite: attempt(() => { writeFileSync(join(process.env.KIMI_CODE_HOME, "sessions", "boundary.txt"), "Session output"); return "written"; }),
          outsideRead: attempt(() => readFileSync(process.env.LING_ACP_BOUNDARY_OUTSIDE, "utf8")),
          internalRead: attempt(() => readFileSync(join(workspaceCwd, ".ling-stack", "boundary-private.txt"), "utf8")),
          symlinkWrite: attempt(() => { writeFileSync(join(workspaceCwd, "outside-link"), "Overwritten"); return "written"; }),
          configWrite: attempt(() => { writeFileSync(join(process.env.KIMI_CODE_HOME, "config.toml"), "Overwritten"); return "written"; }),
        };
        process.send?.({ method: "owned-boundary-result", params: observations });
        await update("Native boundary operations finished.");
        await result(active, { stopReason: "end_turn" }); active = undefined;
        break;
      }
      if (scenario === "native-home") {
        const home = process.env.KIMI_CODE_HOME, source = process.env.LING_ACP_NATIVE_HOME;
        const attempt = operation => { try { return { value: operation() }; } catch (error) { return { code: error.code }; } };
        const data = {};
        for (const name of ["sessions", "store", "cache", "logs", "blobs"]) {
          const path = join(home, name, "continuation.txt");
          let previous = 0;
          try { previous = Number(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
          writeFileSync(path, String(previous + 1)); data[name] = previous + 1;
        }
        const replacement = join(process.cwd(), "config-replacement.toml"); writeFileSync(replacement, "Never accepted");
        const observations = { data,
          configWrite: attempt(() => writeFileSync(join(home, "config.toml"), "Overwritten")),
          configReplace: attempt(() => renameSync(replacement, join(home, "config.toml"))),
          credentialRead: attempt(() => readFileSync(join(home, "credentials", "synthetic.txt"), "utf8")),
          credentialWrite: attempt(() => writeFileSync(join(home, "credentials", "synthetic.txt"), "Overwritten")),
          sourceConfigRead: attempt(() => readFileSync(join(source, "config.toml"), "utf8")),
          sourceConfigWrite: attempt(() => writeFileSync(join(source, "config.toml"), "Overwritten")),
        };
        process.send?.({ method: "owned-home-result", params: observations });
        await update("Native data continuation verified.");
        await result(active, { stopReason: "end_turn" }); active = undefined;
        break;
      }
      if (process.env.LING_ACP_PEER_OUTPUT === "assistant") {
        await update("Owned attachments. ");
        for (const content of [
          { type: "image", data: process.env.LING_ACP_PEER_IMAGE, mimeType: "image/png", uri: null, annotations: null },
          { type: "resource", resource: { uri: "file:///no-native-path-access/report.txt", text: "Returned report fixture-secret", mimeType: null } },
          { type: "resource_link", uri: "https://127.0.0.1:1/no-fetch", name: "Reference", description: null },
        ]) await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "agent_message_chunk", content } } });
        await update("Completed.");
        await result(active, { stopReason: "end_turn" });
        active = undefined;
        break;
      }
      if (process.env.LING_ACP_PEER_OUTPUT === "rich") {
        const notify = update => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session", update } });
        await notify({ sessionUpdate: "session_info_update", title: "Native-only title" });
        await notify({ sessionUpdate: "available_commands_update", availableCommands: [] });
        await notify({ sessionUpdate: "tool_call", toolCallId: "1:owned-edit", title: "Edit preview", kind: "edit", status: "in_progress",
          content: [{ type: "diff", path: "/no-native-path-access/note.txt", oldText: null, newText: "fixture-secret" }] });
        await notify({ sessionUpdate: "tool_call_update", toolCallId: "1:owned-edit", status: "completed", content: [
          { type: "content", content: { type: "resource", resource: { uri: "file:///no-native-path-access/report.txt",
            text: "Returned report fixture-secret" } } },
        ] });
        await update("Owned output completed.");
        await notify({ sessionUpdate: "usage_update", used: 256, size: 32000 });
        await result(active, { stopReason: "end_turn" });
        active = undefined;
        break;
      }
      await update("中文 streaming before decision");
      fileAction = ({
        "file-write": { tool: "Write", input: { path: "native-file.txt", content: "Replaced" } },
        "file-append": { tool: "Write", input: { path: "native-file.txt", content: "\nAdded", mode: "append" } },
        "file-edit": { tool: "Edit", input: { path: "native-file.txt", old_string: "First", new_string: "Second", replace_all: true } },
        "file-read": { tool: "Read", input: { path: "native-file.txt", line_offset: -2, n_lines: 1 } },
      })[scenario];
      if (engine === "kimi-acp") await send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "owned-session", update: { sessionUpdate: "tool_call", toolCallId: "1:owned-tool",
          kind: fileAction ? fileAction.tool === "Read" ? "read" : "edit" : "execute", title: "Running an owned fixture", status: "in_progress",
          rawInput: fileAction?.input ?? { command: scenario === "approval-token"
            ? `/usr/bin/printf '%s' '${Object.values(JSON.parse(process.env.LING_ACP_MODEL_PROJECTION).providers)[0].custom_headers["x-ling-model-token"]}'`
            : oauthCommand ?? "/usr/bin/whois 'example.com'", timeout: 60 } },
      } });
      const nativeOpenClaw = engine === "openclaw-acp" && process.env.LING_ACP_PEER_OPENCLAW_NATIVE === "true";
      const openclawApprovalId = "gateway-approval-1";
      const openclawCommand = scenario === "approval-token"
        ? "/usr/bin/printf '%s' 'private-openclaw-fixture-token'" : "whois example.com";
      await send({ jsonrpc: "2.0", id: "owned-permission", method: "session/request_permission", params: {
        sessionId: "owned-session", toolCall: engine === "kimi-acp" ? { toolCallId: "1:owned-tool", title: fileAction?.tool ?? "Bash" }
          : nativeOpenClaw ? { toolCallId: "gateway-tool-call", title: "Command approval requested", kind: "execute", status: "pending",
            rawInput: { name: "exec", approvalId: openclawApprovalId, command: openclawCommand, host: "gateway" },
            _meta: { toolName: "exec", approvalId: openclawApprovalId } }
            : { toolCallId: "owned-tool", title: "Synthetic operation", kind: "execute" },
        options: engine === "kimi-acp" ? [
          { optionId: "approve_once", kind: "allow_once", name: "Once" },
          { optionId: "approve_always", kind: "allow_always", name: "Session" },
          { optionId: "reject", kind: "reject_once", name: "Reject" },
        ] : nativeOpenClaw ? [
          { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
          { optionId: "allow-always", kind: "allow_always", name: "Allow always" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ] : [{ optionId: "once", kind: "allow_once", name: "Once" }, { optionId: "deny", kind: "reject_once", name: "Deny" }],
      } });
      await update("中文 streaming during decision");
      break;
    case "session/cancel":
      if (scenario === "hold-ignore-cancel" || scenario === "result-only") break;
      await update("final cancellation output");
      await result(active, { stopReason: "cancelled" }); active = undefined;
      break;
    default:
      if (active !== undefined && scenario === "host-terminal" && message.id?.startsWith?.("owned-host-terminal")) {
        const next = (id, method) => send({ jsonrpc: "2.0", id, method, params: { sessionId: "owned-session", terminalId } });
        if (message.error || message.id === "owned-host-terminal-release") {
          await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
            update: { sessionUpdate: "tool_call_update", toolCallId: "1:host-terminal", status: message.error ? "failed" : "completed" } } });
          await update(message.error ? "Host terminal failed" : terminalText);
          await result(active, { stopReason: "end_turn" }); active = undefined;
        } else if (message.id === "owned-host-terminal") {
          terminalId = message.result.terminalId;
          await next("owned-host-terminal-exit", "terminal/wait_for_exit");
        } else if (message.id === "owned-host-terminal-exit") await next("owned-host-terminal-output", "terminal/output");
        else if (message.id === "owned-host-terminal-output") {
          terminalText = message.result.output;
          await next("owned-host-terminal-release", "terminal/release");
        }
        break;
      }
      if (active !== undefined && message.id === "owned-host-baseline") {
        if (message.result || scenario === "host-append" && message.error?.code === -32002) {
          const original = message.result?.content ?? "";
          const content = scenario === "host-append" ? original + fileAction.input.content
            : original.replaceAll(fileAction.input.old_string, fileAction.input.new_string);
          await send({ jsonrpc: "2.0", id: "owned-host-write", method: "fs/write_text_file",
            params: { sessionId: "owned-session", path: join(workspaceCwd, "native-file.txt"), content } });
        } else {
          await update("Host baseline failed"); await result(active, { stopReason: "end_turn" }); active = undefined;
        }
      }
      if (active !== undefined && message.id === "owned-host-write") {
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "tool_call_update", toolCallId: "1:host-write", status: message.error ? "failed" : "completed" } } });
        await update(message.error ? "Host write failed" : "Approved host write completed");
        await result(active, { stopReason: "end_turn" }); active = undefined;
      }
      if (active !== undefined && message.id === "owned-host-read") {
        await send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session",
          update: { sessionUpdate: "tool_call_update", toolCallId: "1:host-read", status: message.error ? "failed" : "completed" } } });
        await update(message.result?.content ?? "Host read failed");
        await result(active, { stopReason: "end_turn" }); active = undefined;
      }
      if (active !== undefined && message.id === "owned-permission" && message.result?.outcome.outcome === "selected") {
        if (scenario === "oauth-pending" && message.result.outcome.optionId === "approve_once") {
          process.send?.({ method: "owned-approved-command", params: { command: oauthCommand } });
        }
        // Only an owned fixture file is touched, and only after a saved once decision returns over ACP.
        if (fileAction && message.result.outcome.optionId === "approve_once") {
          const path = join(workspaceCwd, "native-file.txt");
          const input = fileAction.input;
          let output;
          if (fileAction.tool === "Write") {
            if (input.mode === "append") appendFileSync(path, input.content);
            else writeFileSync(path, input.content);
          } else if (fileAction.tool === "Edit") {
            writeFileSync(path, readFileSync(path, "utf8").replaceAll(input.old_string, input.new_string));
          } else {
            const lines = readFileSync(path, "utf8").split("\n");
            output = lines.slice(lines.length + input.line_offset, lines.length + input.line_offset + input.n_lines).join("\n");
          }
          process.send?.({ method: "owned-file-result", params: { tool: fileAction.tool, output } });
        }
        if (engine === "kimi-acp" && process.env.LING_ACP_PEER_JOURNALED === "true") await send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "owned-session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:owned-tool", status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Synthetic result; no command executed" } }] },
        } });
        await update("final decision output"); await result(active, { stopReason: "end_turn" }); active = undefined;
      }
  }
}
await writes;
if (process.connected) process.disconnect();
