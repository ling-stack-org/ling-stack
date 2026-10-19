import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";
import { matchesKimiBashTerminal } from "../dist/runtime/acp/kimi-bash-actions.js";

const native = { requestId: "permission", params: { sessionId: "session", toolCall: { toolCallId: "1:tool", title: "Bash" },
  options: [{ optionId: "approve_once", kind: "allow_once", name: "Once" },
    { optionId: "approve_always", kind: "allow_always", name: "Session" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } };
const event = (rawInput = { command: "whois example.com" }, extra = {}) => ({ sessionId: "session", update: {
  sessionUpdate: "tool_call", toolCallId: "1:tool", kind: "execute", status: "in_progress", title: "Arbitrary display", rawInput, ...extra } });
function fixture(t, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-kimi-actions-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  return { cwd, actions: new KimiActionPreparer({ sessionId: "session", cwd,
    policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [cwd] }, ...options }) };
}

test("Kimi host terminal binds the exact pinned Bash invocation and preserves foreground timeout", t => {
  const f = fixture(t, { terminalShell: { executable: "/bin/bash", platform: "posix" } });
  const input = { command: "whois example.com", timeout: 120 };
  f.actions.receive(event(input));
  const prepared = f.actions.prepareHostTerminal({ sessionId: "session", command: "/bin/bash",
    args: ["-c", `cd '${f.cwd}' && whois example.com`], cwd: f.cwd,
    env: [{ name: "NO_COLOR", value: "1" }, { name: "TERM", value: "dumb" },
      { name: "GIT_TERMINAL_PROMPT", value: "0" }, { name: "SHELL", value: "/bin/bash" }],
    outputByteLimit: 4194304 });
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.toolCallId, "1:tool");
  assert.equal(prepared.tool, "Bash");
  assert.deepEqual(prepared.input, input);
  assert.equal(prepared.timeoutMs, 120000);
  assert.equal(prepared.contextCwd, realpathSync(f.cwd));
  assert.equal(prepared.contextRevision, f.actions.prepare(native).contextRevision);
  assert.deepEqual(prepared.approval, f.actions.prepare(native).approval);
  assert.equal(prepared.policyDecision.decision, "ask");
});

const terminalShell = { executable: "/bin/bash", platform: "posix" };
const terminalRequest = (cwd, patch = {}) => ({ sessionId: "session", command: "/bin/bash",
  args: ["-c", `cd '${cwd}' && whois example.com`], cwd,
  env: [{ name: "NO_COLOR", value: "1" }, { name: "TERM", value: "dumb" },
    { name: "GIT_TERMINAL_PROMPT", value: "0" }, { name: "SHELL", value: "/bin/bash" }],
  outputByteLimit: 4194304, ...patch });

test("Kimi host terminal keeps the session cwd distinct from the quoted effective tool directory", t => {
  const f = fixture(t, { terminalShell });
  const path = join(f.cwd, "team's work"); mkdirSync(path);
  f.actions.receive(event({ command: 'printf "%s" "literal words"', cwd: "team's work" }));
  const request = terminalRequest(f.cwd, { args: ["-c", `cd '${f.cwd}/team'\\''s work' && printf "%s" "literal words"`] });
  const prepared = f.actions.prepareHostTerminal(request);
  assert.equal(prepared.contextCwd, realpathSync(path));
  assert.equal(prepared.approval.payload.cwd, path);
  assert.equal(prepared.approval.payload.command, 'printf "%s" "literal words"');
  assert.equal(prepared.timeoutMs, 60000);
  assert.equal(f.actions.prepareHostTerminal({ ...request, cwd: path }), undefined);
  assert.equal(f.actions.prepareHostTerminal({ ...request, args: ["-c", `cd '${f.cwd}' && printf "%s" "literal words"`] }), undefined);
});

test("Kimi host terminal rejects substituted shell, argv, cwd, command and explicit environment", t => {
  const f = fixture(t, { terminalShell }); f.actions.receive(event());
  const original = terminalRequest(f.cwd);
  const changes = [{ command: "/bin/sh" }, { command: "bash" }, { args: undefined }, { args: ["-lc", original.args[1]] },
    { args: [...original.args, "extra"] }, { args: ["-c", "whois example.com"] },
    { args: ["-c", `cd '${f.cwd}' && whois different.example`] }, { args: ["-c", `${original.args[1]} && touch extra`] },
    { args: ["-c", `cd "${f.cwd}" && whois example.com`] }, { cwd: undefined }, { cwd: `${f.cwd}/.` },
    { sessionId: "other" }, { env: undefined }, { env: [] }, { env: original.env.slice(0, 3) },
    { env: [...original.env, { name: "PATH", value: "/untrusted" }] },
    { env: [original.env[0], original.env[0], original.env[2], original.env[3]] },
    ...original.env.map((_, i) => ({ env: original.env.map((item, index) => index === i ? { ...item, value: "changed" } : item) }))];
  for (const patch of changes) assert.equal(f.actions.prepareHostTerminal({ ...original, ...patch }), undefined, JSON.stringify(patch));
  assert.ok(f.actions.prepareHostTerminal({ ...original, env: [...original.env].reverse() }), "environment order is not execution identity");
});

test("Kimi host terminal requires one live enabled Bash context and a host-owned shell", t => {
  for (const options of [{}, { nativeTools: ["Read"], terminalShell }, { nativeTools: [], terminalShell }]) {
    const f = fixture(t, options); f.actions.receive(event());
    assert.equal(f.actions.prepareHostTerminal(terminalRequest(f.cwd)), undefined);
  }
  const f = fixture(t, { terminalShell, nativeTools: ["Bash"] });
  const request = terminalRequest(f.cwd);
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
  f.actions.receive(event(undefined, { status: "pending" }));
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
  f.actions.receive(event(undefined, { sessionUpdate: "tool_call_update" }));
  assert.ok(f.actions.prepareHostTerminal(request));
  f.actions.receive(event(undefined, { toolCallId: "2:tool" }));
  assert.equal(f.actions.prepareHostTerminal(request), undefined, "duplicate live inputs have no request-to-tool identity");
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "2:tool", status: "completed" } });
  assert.equal(f.actions.prepareHostTerminal(request).toolCallId, "1:tool");
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:tool", status: "failed" } });
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
});

test("Kimi host terminal snapshots cannot revive changed-back, cleared or completed Bash revisions", t => {
  const shell = { ...terminalShell };
  const f = fixture(t, { terminalShell: shell }); shell.executable = "/untrusted";
  const input = event(); f.actions.receive(input); input.update.rawInput.command = "mutated";
  const request = terminalRequest(f.cwd);
  const first = f.actions.prepareHostTerminal(request);
  assert.ok(first);
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:tool", title: "Running" } });
  assert.deepEqual(f.actions.prepareHostTerminal(request), first);
  f.actions.receive(event({ command: "whois other.example" }, { sessionUpdate: "tool_call_update" }));
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
  f.actions.receive(event(undefined, { sessionUpdate: "tool_call_update" }));
  const restored = f.actions.prepareHostTerminal(request);
  assert.ok(restored.contextRevision > first.contextRevision);
  restored.input.command = "mutated"; restored.approval.payload.command = "mutated";
  assert.equal(f.actions.prepareHostTerminal(request).input.command, "whois example.com");
  f.actions.receive(event({ command: "whois example.com", timeout: 5 }, { sessionUpdate: "tool_call_update" }));
  const retimed = f.actions.prepareHostTerminal(request);
  assert.equal(retimed.timeoutMs, 5000);
  assert.ok(retimed.contextRevision > restored.contextRevision);
  f.actions.clear(); assert.equal(f.actions.prepareHostTerminal(request), undefined);
  f.actions.receive(event()); assert.ok(f.actions.prepareHostTerminal(request).contextRevision > retimed.contextRevision);
});

test("Kimi host terminal revalidates symlink targets, missing directories and workspace replacement", t => {
  const f = fixture(t, { terminalShell });
  const other = fixture(t);
  const one = join(f.cwd, "one"), two = join(f.cwd, "two"), link = join(f.cwd, "current");
  mkdirSync(one); mkdirSync(two); symlinkSync(one, link);
  f.actions.receive(event({ command: "whois example.com", cwd: "current" }));
  const request = terminalRequest(f.cwd, { args: ["-c", `cd '${f.cwd}/current' && whois example.com`] });
  const first = f.actions.prepareHostTerminal(request);
  assert.equal(first.contextCwd, realpathSync(one));
  rmSync(link); symlinkSync(two, link);
  assert.notDeepEqual(f.actions.prepareHostTerminal(request), first);
  rmSync(link); symlinkSync(other.cwd, link);
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
  rmSync(link);
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
  renameSync(f.cwd, `${f.cwd}-moved`); symlinkSync(`${f.cwd}-moved`, f.cwd);
  t.after(() => rmSync(`${f.cwd}-moved`, { recursive: true, force: true }));
  assert.equal(f.actions.prepareHostTerminal(request), undefined);
});

test("Kimi host-only policy retains allow while native permission, Plan and mandatory approval remain authoritative", t => {
  for (const [options, command, decision] of [
    [{ policy: { toolDecisions: { bash: "allow" }, allowedWritePaths: ["."] } }, "whois example.com", "allow"],
    [{ policy: { toolDecisions: { bash: "deny" }, allowedWritePaths: ["."] } }, "whois example.com", "deny"],
    [{ effectivePolicySnapshot: { conversationMode: "plan" } }, "touch file.txt", "deny"],
    [{ effectivePolicySnapshot: { conversationMode: "plan" } }, "whois example.com", "ask"],
    [{ policy: { toolDecisions: { bash: "allow" }, allowedWritePaths: ["."] }, approvalProfile: { requiredForTools: ["bash"] } }, "whois example.com", "ask"],
  ]) {
    const f = fixture(t, { ...options, terminalShell }); f.actions.receive(event({ command }));
    assert.equal(f.actions.prepareHostTerminal(terminalRequest(f.cwd, { args: ["-c", `cd '${f.cwd}' && ${command}`] })).policyDecision.decision, decision);
    assert.equal(f.actions.prepare(native).policyDecision.decision, decision === "allow" ? "ask" : decision);
  }
  const f = fixture(t, { terminalShell, policy: { toolDecisions: { bash: "allow" }, allowedWritePaths: ["."] } });
  f.actions.receive(event({ command: "git push --force" }));
  const action = f.actions.prepareHostTerminal(terminalRequest(f.cwd, { args: ["-c", `cd '${f.cwd}' && git push --force`] }));
  assert.equal(action.policyDecision.decision, "ask");
  assert.equal(action.approval.actionType, "git_push");
  assert.equal(action.approval.risk, "critical");
});

test("Kimi host terminal cannot authorize unmapped input or shell constructs through a matching wrapper", t => {
  for (const input of [{ command: "whois example.com", run_in_background: true },
    { command: "whois example.com", disable_timeout: true }, { command: "whois example.com", timeout: 301 },
    { command: "whois example.com", env: {} }, { command: "whois example.com | sh" },
    { command: "whois $DOMAIN" }, { command: "sudo whois example.com" }]) {
    const f = fixture(t, { terminalShell }); f.actions.receive(event(input));
    assert.equal(f.actions.prepareHostTerminal(terminalRequest(f.cwd, { args: ["-c", `cd '${f.cwd}' && ${input.command}`] })), undefined);
  }
});

test("Kimi terminal spelling keeps the pinned Windows Git Bash path and NUL rewrite separate from POSIX", () => {
  const shell = { executable: "C:\\Program Files\\Git\\bin\\bash.exe", platform: "win32" };
  const request = { ...terminalRequest("C:\\Work\\team's repo"), command: shell.executable,
    args: ["-c", "cd '/c/Work/team'\\''s repo' && echo test 2>/dev/null"],
    env: terminalRequest("").env.map(item => item.name === "SHELL" ? { ...item, value: shell.executable } : item) };
  assert.equal(matchesKimiBashTerminal(request, shell, "C:\\Work\\team's repo", "echo test 2>NUL"), true);
  assert.equal(matchesKimiBashTerminal(request, { ...shell, platform: "posix" }, "C:\\Work\\team's repo", "echo test 2>NUL"), false);
  assert.equal(matchesKimiBashTerminal({ ...request, args: ["-c", "cd '//server/share/folder' && echo NUL"] },
    shell, "\\\\server\\share\\folder", "echo NUL"), true);
  assert.equal(matchesKimiBashTerminal({ ...request, args: ["-c", "cd '/c/work' && echo NUL >NUL.txt"] },
    shell, "C:\\work", "echo NUL >NUL.txt"), true);
});

test("Kimi validates native Bash parameters rather than silently dropping lifecycle or cwd fields", t => {
  for (const extra of [{ run_in_background: true }, { disable_timeout: true }, { cwd: 42 }, { cwd: "" },
    { timeout: "60" }, { timeout: 301 }, { timeout: 0 }, { description: false }, { run_in_background: "false" },
    { env: { MODE: "unmapped" } }]) {
    const f = fixture(t);
    f.actions.receive(event({ command: "whois example.com", ...extra }));
    assert.equal(f.actions.prepare(native).kind, "unsupported", JSON.stringify(extra));
  }
  const f = fixture(t);
  f.actions.receive(event({ command: "whois example.com", cwd: f.cwd, timeout: 300,
    description: "User-facing purpose", run_in_background: false, disable_timeout: false }));
  assert.equal(f.actions.prepare(native).kind, "action");
});

const fileRequest = title => ({ ...structuredClone(native), params: { ...structuredClone(native.params),
  toolCall: { toolCallId: "1:tool", title } } });
const fileEvent = (rawInput, title = "Write", extra = {}) => event(rawInput,
  { kind: title === "Read" ? "read" : "edit", ...extra });

test("Kimi native Write offers a bounded one-time file proposal without modifying the target", t => {
  const f = fixture(t);
  const path = join(f.cwd, "note.txt");
  writeFileSync(path, "Existing content");
  f.actions.receive(fileEvent({ path: "note.txt", content: "中文\n", mode: "append" }));
  const action = f.actions.prepare(fileRequest("Write"));
  assert.equal(action.kind, "action");
  assert.equal(action.policyDecision.decision, "ask");
  assert.equal(action.approval.actionType, "write");
  assert.equal(action.approval.payload.type, "file_write");
  assert.equal(action.approval.payload.path, realpathSync(path));
  assert.equal(action.approval.payload.bytes, 7);
  assert.match(action.approval.description, /"mode":"append"/);
  assert.equal(action.approval.payload.preview, "中文\n");
  assert.equal(readFileSync(path, "utf8"), "Existing content");
});

test("Kimi native Read preserves its native line range in a workspace-scoped one-time proposal", t => {
  const f = fixture(t);
  const path = join(f.cwd, "note.txt");
  writeFileSync(path, "First\nSecond\nThird\n");
  f.actions.receive(fileEvent({ path: "note.txt", line_offset: -2, n_lines: 1 }, "Read"));
  const action = f.actions.prepare(fileRequest("Read"));
  assert.equal(action.kind, "action");
  assert.equal(action.policyDecision.decision, "ask");
  assert.equal(action.approval.actionType, "read");
  assert.equal(action.approval.risk, "low");
  assert.deepEqual(action.approval.payload, { type: "tool_call", toolName: "read", cwd: realpathSync(f.cwd),
    input: { path: realpathSync(path), line_offset: -2, n_lines: 1, readScope: "whole_file" } });
  assert.deepEqual(JSON.parse(action.approval.description), { tool: "Read", path: "note.txt", line_offset: -2, n_lines: 1 });
  assert.equal(readFileSync(path, "utf8"), "First\nSecond\nThird\n");
});

test("Kimi native Edit preserves exact replacement parameters without applying an inferred patch", t => {
  const f = fixture(t);
  const path = join(f.cwd, "note.txt");
  writeFileSync(path, "First\nFirst\n");
  f.actions.receive(fileEvent({ path: "note.txt", old_string: "First", new_string: "", replace_all: true }, "Edit"));
  const action = f.actions.prepare(fileRequest("Edit"));
  assert.equal(action.kind, "action");
  assert.equal(action.policyDecision.decision, "ask");
  assert.equal(action.approval.actionType, "edit");
  assert.deepEqual(action.approval.payload, { type: "file_edit", path: realpathSync(path),
    diffPreview: JSON.stringify({ old_string: "First", new_string: "", replace_all: true }, null, 2) });
  assert.deepEqual(JSON.parse(action.approval.description), { tool: "Edit", path: "note.txt", replace_all: true });
  assert.equal(readFileSync(path, "utf8"), "First\nFirst\n");
});

test("Kimi Write preserves overwrite defaults and permits a missing file without creating its parents", t => {
  const f = fixture(t);
  f.actions.receive(fileEvent({ path: "new/nested/file.txt", content: "" }));
  const action = f.actions.prepare(fileRequest("Write"));
  assert.equal(action.kind, "action");
  assert.equal(action.policyDecision.decision, "ask");
  assert.equal(action.approval.payload.path, join(realpathSync(f.cwd), "new/nested/file.txt"));
  assert.equal(action.approval.payload.bytes, 0);
  assert.equal(JSON.parse(action.approval.description).mode, "overwrite");
  assert.equal(existsSync(join(f.cwd, "new")), false);
});

const fileInputs = {
  Read: { path: "note.txt" }, Write: { path: "note.txt", content: "Next" },
  Edit: { path: "note.txt", old_string: "First", new_string: "Second" },
};
for (const [tool, invalid] of Object.entries({
  Read: [{ line_offset: 0 }, { line_offset: -1001 }, { line_offset: 1.5 }, { line_offset: "1" },
    { n_lines: 0 }, { n_lines: -1 }, { n_lines: "3" }, { n_lines: 2.5 }, { offset: 1 }, { n_lines: null }],
  Write: [{ content: null }, { content: 3 }, { mode: "insert" }, { mode: null }, { append: true }],
  Edit: [{ old_string: "" }, { old_string: null }, { new_string: null }, { replace_all: "true" },
    { replace_all: null }, { edits: [] }, { oldText: "First" }],
})) test(`Kimi ${tool} rejects invalid or unmapped native fields`, t => {
  for (const patch of invalid) {
    const f = fixture(t); writeFileSync(join(f.cwd, "note.txt"), "First");
    f.actions.receive(fileEvent({ ...fileInputs[tool], ...patch }, tool));
    assert.equal(f.actions.prepare(fileRequest(tool)).kind, "unsupported", JSON.stringify(patch));
  }
});

test("Kimi Read accepts official positive and tail offsets; Edit defaults to one replacement", t => {
  for (const extra of [{}, { line_offset: 1 }, { line_offset: -1000 }, { n_lines: 10000 }]) {
    const f = fixture(t); writeFileSync(join(f.cwd, "note.txt"), "First");
    f.actions.receive(fileEvent({ ...fileInputs.Read, ...extra }, "Read"));
    const action = f.actions.prepare(fileRequest("Read"));
    assert.equal(action.kind, "action");
    assert.deepEqual(action.approval.payload.input, { path: join(realpathSync(f.cwd), "note.txt"), ...extra, readScope: "whole_file" });
  }
  const f = fixture(t); writeFileSync(join(f.cwd, "note.txt"), "First");
  f.actions.receive(fileEvent(fileInputs.Edit, "Edit"));
  assert.equal(JSON.parse(f.actions.prepare(fileRequest("Edit")).approval.payload.diffPreview).replace_all, false);
});

for (const tool of ["Read", "Write", "Edit"]) test(`Kimi ${tool} retains deny/Plan/profile boundaries instead of auto-granting a native request`, t => {
  for (const [options, expected] of [
    [{ policy: { toolDecisions: { [tool.toLowerCase()]: "deny" }, allowedWritePaths: ["."] } }, "deny"],
    [{ effectivePolicySnapshot: { conversationMode: "plan" } }, tool === "Read" ? "ask" : "deny"],
    [{ policy: { toolDecisions: { [tool.toLowerCase()]: "allow" }, allowedWritePaths: ["."] } }, "ask"],
    [{ approvalProfile: { requiredForTools: [tool.toLowerCase()] } }, "ask"],
  ]) {
    const f = fixture(t, options); writeFileSync(join(f.cwd, "note.txt"), "First");
    f.actions.receive(fileEvent(fileInputs[tool], tool));
    const action = f.actions.prepare(fileRequest(tool));
    assert.equal(action.kind, "action");
    assert.equal(action.policyDecision.decision, expected);
    assert.equal(readFileSync(join(f.cwd, "note.txt"), "utf8"), "First");
  }
});

test("Kimi file proposals reject invalid local paths, missing reads/edits and non-regular targets", t => {
  for (const tool of ["Read", "Write", "Edit"]) {
    for (const path of ["", "  ", "\u0000", "file\n.txt", "~/note.txt", "file:///tmp/note.txt", "https://host/note.txt",
      "\\\\host\\file.txt", "Z:\\file.txt", ".", "directory", "dangling", "hardlink.txt"]) {
      const f = fixture(t); mkdirSync(join(f.cwd, "directory"));
      writeFileSync(join(f.cwd, "note.txt"), "First");
      linkSync(join(f.cwd, "note.txt"), join(f.cwd, "hardlink.txt"));
      symlinkSync(join(f.cwd, "missing.txt"), join(f.cwd, "dangling"));
      f.actions.receive(fileEvent({ ...fileInputs[tool], path }, tool));
      assert.equal(f.actions.prepare(fileRequest(tool)).kind, "unsupported", `${tool}:${path}`);
    }
  }
  for (const tool of ["Read", "Edit"]) {
    const f = fixture(t); f.actions.receive(fileEvent(fileInputs[tool], tool));
    assert.equal(f.actions.prepare(fileRequest(tool)).kind, "unsupported");
  }
});

test("Kimi protects internal state through literal, nested and symlink-alias paths", t => {
  for (const tool of ["Read", "Write", "Edit"]) {
    const f = fixture(t);
    for (const folder of [".ling-stack", "nested/.ling-stack"]) {
      mkdirSync(join(f.cwd, folder), { recursive: true }); writeFileSync(join(f.cwd, folder, "note.txt"), "First");
    }
    symlinkSync(join(f.cwd, ".ling-stack"), join(f.cwd, "alias"));
    for (const path of [".ling-stack/note.txt", "nested/.ling-stack/note.txt", "alias/note.txt"]) {
      const actions = new KimiActionPreparer({ sessionId: "session", cwd: f.cwd,
        policy: { toolDecisions: {}, allowedWritePaths: [f.cwd] } });
      actions.receive(fileEvent({ ...fileInputs[tool], path }, tool));
      assert.equal(actions.prepare(fileRequest(tool)).kind, "unsupported", `${tool}:${path}`);
    }
  }
});

test("Kimi writes require explicit external scope while reads remain confined to the workspace", t => {
  const outside = fixture(t); const path = join(outside.cwd, "note.txt"); writeFileSync(path, "First");
  for (const tool of ["Read", "Write", "Edit"]) {
    const denied = fixture(t);
    symlinkSync(outside.cwd, join(denied.cwd, "escape"));
    denied.actions.receive(fileEvent({ ...fileInputs[tool], path: "escape/note.txt" }, tool));
    assert.equal(denied.actions.prepare(fileRequest(tool)).kind, "unsupported");
    const allowed = fixture(t, { policy: { toolDecisions: {}, allowedWritePaths: [outside.cwd] } });
    allowed.actions.receive(fileEvent({ ...fileInputs[tool], path }, tool));
    const action = allowed.actions.prepare(fileRequest(tool));
    assert.equal(action.kind, tool === "Read" ? "unsupported" : "action");
    if (action.kind === "action") { assert.equal(action.policyDecision.decision, "ask"); assert.equal(action.approval.risk, "high"); }
  }
  assert.equal(readFileSync(path, "utf8"), "First");
});

test("Kimi file revalidation detects in-workspace symlink substitution and a replaced workspace root", t => {
  const f = fixture(t);
  for (const file of ["first", "second"]) writeFileSync(join(f.cwd, file), "First");
  const link = join(f.cwd, "current"); symlinkSync(join(f.cwd, "first"), link);
  f.actions.receive(fileEvent({ ...fileInputs.Write, path: "current" }));
  const first = f.actions.prepare(fileRequest("Write")); assert.equal(first.kind, "action");
  rmSync(link); symlinkSync(join(f.cwd, "second"), link);
  const second = f.actions.prepare(fileRequest("Write")); assert.equal(second.kind, "action");
  assert.notDeepEqual(first, second);
  const outer = fixture(t); const original = join(outer.cwd, "original");
  renameSync(f.cwd, original); symlinkSync(original, f.cwd);
  assert.equal(f.actions.prepare(fileRequest("Write")).kind, "unsupported");
});

test("Kimi file context requires finalized matching inputs and never revives changed-and-restored proposals", t => {
  const f = fixture(t); writeFileSync(join(f.cwd, "note.txt"), "First");
  f.actions.receive(fileEvent(fileInputs.Write, "Write", { status: "pending" }));
  assert.equal(f.actions.prepare(fileRequest("Write")).kind, "unsupported");
  f.actions.receive(fileEvent(fileInputs.Write, "Write", { sessionUpdate: "tool_call_update" }));
  const original = f.actions.prepare(fileRequest("Write")); assert.equal(original.kind, "action");
  for (const input of [{ ...fileInputs.Write, content: "Different" }, fileInputs.Write]) {
    f.actions.receive(fileEvent(input, "Write", { sessionUpdate: "tool_call_update" }));
  }
  assert.notEqual(f.actions.prepare(fileRequest("Write")).contextRevision, original.contextRevision);
  for (const patch of [{ kind: "read" }, { rawInput: fileInputs.Write }]) {
    const request = fileRequest("Write"); Object.assign(request.params.toolCall, patch);
    assert.equal(f.actions.prepare(request).kind, "unsupported");
  }
  assert.equal(f.actions.prepare(fileRequest("Read")).kind, "unsupported");
  assert.equal(f.actions.prepare(fileRequest("Edit")).kind, "unsupported");
});

test("Kimi requires a real create/finalize lifecycle and cannot reopen a terminal tool", t => {
  const orphan = fixture(t);
  assert.throws(() => orphan.actions.receive(event(undefined, { sessionUpdate: "tool_call_update" })), { code: "protocol_error" });
  const f = fixture(t);
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call", toolCallId: "1:tool", title: "Bash",
    kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: '{"command":"whois' } }] } });
  assert.equal(f.actions.prepare(native).kind, "unsupported");
  f.actions.receive(event(undefined, { sessionUpdate: "tool_call_update" }));
  const prepared = f.actions.prepare(native);
  assert.equal(prepared.kind, "action");
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:tool", title: "Running..." } });
  assert.deepEqual(f.actions.prepare(native), prepared, "cosmetic progress cannot invalidate an unchanged action");
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:tool", status: "completed" } });
  assert.equal(f.actions.prepare(native).kind, "unsupported");
  assert.throws(() => f.actions.receive(event(undefined, { sessionUpdate: "tool_call_update" })), { code: "protocol_error" });
  assert.throws(() => f.actions.receive(event()), { code: "protocol_error" });
});

test("Kimi optional presentation updates agree with ACP output merging but cannot clear or grant executable input", t => {
  const f = fixture(t);
  f.actions.receive(event(undefined, { status: undefined }));
  assert.equal(f.actions.prepare(native).kind, "unsupported", "missing initial status defaults to pending, not execution");
  f.actions.receive(event(undefined, { sessionUpdate: "tool_call_update" }));
  const prepared = f.actions.prepare(native);
  assert.equal(prepared.kind, "action");
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:tool",
    title: null, status: null, kind: null, content: null } });
  assert.deepEqual(f.actions.prepare(native), prepared);
  f.actions.receive({ sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "1:tool", rawInput: null } });
  assert.equal(f.actions.prepare(native).kind, "unsupported", "explicit invalid input is not presentation metadata");
});

test("Kimi context is bounded, cloned, and clearing cannot reuse an older revision", t => {
  const f = fixture(t, { limits: { items: 1, bytes: 256 } });
  const input = event();
  f.actions.receive(input);
  input.update.rawInput.command = "mutated-outside";
  const first = f.actions.prepare(native);
  assert.equal(first.approval.payload.command, "whois example.com");
  assert.throws(() => f.actions.receive(event(undefined, { toolCallId: "1:other" })), { code: "output_limit" });
  assert.throws(() => f.actions.receive(event({ command: "a".repeat(300) }, { sessionUpdate: "tool_call_update" })), { code: "output_limit" });
  assert.deepEqual(f.actions.prepare(native), first, "failed context update preserves the previous snapshot");
  f.actions.clear();
  assert.equal(f.actions.prepare(native).kind, "unsupported");
  f.actions.receive(event());
  assert.ok(f.actions.prepare(native).contextRevision > first.contextRevision);
  assert.throws(() => f.actions.receive({ ...event(), sessionId: "different-session" }), { code: "binding_mismatch" });
});

test("Kimi cwd is a current local workspace directory and symlink replacement invalidates preparation", t => {
  const f = fixture(t);
  const outside = fixture(t);
  const subdir = join(f.cwd, "source"); mkdirSync(subdir);
  const link = join(f.cwd, "current"); symlinkSync(subdir, link);
  f.actions.receive(event({ command: "whois example.com", cwd: link }));
  assert.equal(f.actions.prepare(native).kind, "action");
  rmSync(link); symlinkSync(outside.cwd, link);
  assert.equal(f.actions.prepare(native).kind, "unsupported");
  for (const cwd of [outside.cwd, "../outside", "https://remote.example/work", join(f.cwd, "missing")]) {
    f.actions.receive(event({ command: "whois example.com", cwd }, { sessionUpdate: "tool_call_update" }));
    assert.equal(f.actions.prepare(native).kind, "unsupported", cwd);
  }
});

test("Kimi applies shared deny, Plan Mode, required approval and wrapped-command risk policy", t => {
  for (const [options, command, decision, action, risk] of [
    [{ policy: { toolDecisions: { bash: "deny" }, allowedWritePaths: ["."] } }, "whois example.com", "deny", "bash", "medium"],
    [{ effectivePolicySnapshot: { conversationMode: "plan" } }, "/bin/zsh -lc 'touch file.txt'", "deny", "bash", "medium"],
    [{ policy: { toolDecisions: { bash: "allow" }, allowedWritePaths: ["."] } }, "whois example.com", "ask", "bash", "medium"],
    [{ approvalProfile: { mode: "strict" } }, "git commit -m fixture", "ask", "git_commit", "medium"],
    [{}, '/bin/sh -c \'"git" "push" "--force"\'', "ask", "git_push", "critical"],
  ]) {
    const f = fixture(t, options); f.actions.receive(event({ command }));
    const actual = f.actions.prepare(native);
    assert.equal(actual.kind, "action", command);
    assert.equal(actual.policyDecision.decision, decision, command);
    assert.equal(actual.approval.actionType, action, command);
    assert.equal(actual.approval.risk, risk, command);
  }
});

test("Kimi never infers a command or native decision from titles, plan options or contradictory payloads", t => {
  const f = fixture(t); f.actions.receive(event());
  for (const patch of [{ title: "Terminal" }, { title: "whois example.com" }, { kind: "edit" },
    { rawInput: { command: "a different command" } }]) {
    const request = structuredClone(native); Object.assign(request.params.toolCall, patch);
    assert.equal(f.actions.prepare(request).kind, "unsupported", JSON.stringify(patch));
  }
  const plan = structuredClone(native); plan.params.options[0].optionId = "plan_approve";
  assert.equal(f.actions.prepare(plan).kind, "unsupported");
  for (const command of ["whois example.com | sh", "whois $DOMAIN", "sudo whois example.com", "node -e 'process.exit()'"]) {
    f.actions.receive(event({ command }, { sessionUpdate: "tool_call_update" }));
    assert.equal(f.actions.prepare(native).kind, "unsupported", command);
  }
});
