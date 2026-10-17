import assert from "node:assert/strict";
import test from "node:test";

const analyze = async values => (await import("./inspect-shell-invocations.mjs"))
  .analyzeGstackShellInvocation(values.map(value => typeof value === "string"
    ? { raw: JSON.stringify(value), literal: value } : { raw: value.raw, literal: null }));

test("nested wrappers retain the effective interpreter, code argument and deadline", async () => {
  const result = await analyze(["env", "-i", "LANG=C", "timeout", "90", "exec", "node", "-e", { raw: '"$PROBE"' }]);
  assert.deepEqual(result.wrappers.map(item => item.name), ["env", "timeout", "exec"]);
  assert.equal(result.effectiveCommandIndex, 6);
  assert.equal(result.effectiveCommand.literal, "node");
  assert.equal(result.interpreter.mode, "inline");
  assert.equal(result.interpreter.resourceIndex, 8);
  assert.equal(result.interpreter.resource.literal, null);
  assert.equal(result.wrappers[1].duration.literal, "90");
  assert.equal(result.runtimeAcceptance, "pending");
});

test("wrapped variable and forwarded executables remain unresolved", async () => {
  for (const raw of ['"$@"', '"$BROWSE_BIN"', "$sudo"]) {
    const result = await analyze(["exec", { raw }, "--version"]);
    assert.equal(result.boundaryArgumentIndex, 1);
    assert.equal(result.boundaryArgument.raw, raw);
    assert.equal(result.effectiveCommand, undefined);
    assert.equal(result.resolution, "unresolved");
    assert.equal(result.interpreter, undefined);
  }
  const optional = await analyze(["timeout", "120", { raw: "$sudo" }, "apt-get", "install"]);
  assert.equal(optional.boundaryArgument.raw, "$sudo");
  assert.equal(optional.resolution, "unresolved");
});

test("discovery and descriptor-only calls cannot become executable dependencies", async () => {
  const query = await analyze(["command", "-pv", { raw: '"$tool"' }]);
  assert.equal(query.kind, "discovery");
  assert.equal(query.effectiveCommand, undefined);
  assert.equal(query.queryArguments[0].raw, '"$tool"');
  for (const name of ["exec", "command", "env"]) {
    const result = await analyze([name]);
    assert.equal(result.kind, "no-executable");
    assert.equal(result.effectiveCommand, undefined);
  }
});

test("unknown, duplicate and argument-changing wrapper options never guess a target", async () => {
  for (const argv of [
    ["env", "-S", "node -e code"], ["env", "--unknown", "node"],
    ["env", "--unset", { raw: "$KEY" }, "node"],
    ["timeout", "--signal", "TERM", "--signal=KILL", "20", "node"],
    ["timeout", "Infinity", "node"], ["timeout", "0", "node"],
    ["exec", "-a"], ["nice", "-n", { raw: "$NICE" }, "node"],
    ["xargs", "-r", "ls", "-t"], ["find", ".", "-exec", "rm", "{}", ";"],
  ]) {
    const result = await analyze(argv);
    assert.equal(result.resolution, "unresolved", JSON.stringify(argv));
    assert.equal(result.effectiveCommand, undefined, JSON.stringify(argv));
    assert.ok(result.reason);
  }
});

test("wrapper option boundaries stop at the executable", async () => {
  const result = await analyze(["env", "--", "node", "--unset", "HOME"]);
  assert.equal(result.effectiveCommandIndex, 2);
  assert.equal(result.interpreter.mode, "unresolved");
  assert.equal(result.interpreter.reason, "unreviewed-interpreter-option");
  const alias = await analyze(["exec", "-a", "worker", "--", "node", "script.js", "--eval", "other"]);
  assert.equal(alias.effectiveCommandIndex, 4);
  assert.equal(alias.interpreter.mode, "file");
  assert.equal(alias.interpreter.resource.literal, "script.js");
});

test("shell combined command flags and Python/Node inline forms retain code identity", async () => {
  for (const argv of [
    ["bash", "-lc", "echo data"], ["/bin/sh", "-c", { raw: '"$CODE"' }],
    ["python3", "-I", "-c", "print('data')"], ["node", "--eval=console.log(1)"],
    ["bun", "-e", "console.log(1)"], ["ruby", "-e", "puts 1"],
  ]) {
    const result = await analyze(argv);
    assert.equal(result.interpreter.mode, "inline", JSON.stringify(argv));
    assert.ok(result.interpreter.resource);
  }
});

test("interpreter modules, stdin, package tasks and build commands are distinct requirements", async () => {
  for (const [argv, mode] of [
    [["python3", "-m", "json.tool"], "module"],
    [["python3", "-", { raw: '"$@"' }], "stdin"],
    [["bash", "-s", "--", "arg"], "stdin"],
    [["bun", "run", "gen:skill-docs:user"], "package-task"],
    [["bun", "run", "scripts/models.ts"], "file"],
    [["bun", "run", { raw: '"$ENTRY"' }], "unresolved"],
    [["bun", "install", "--frozen-lockfile"], "package-operation"],
    [["bun", "build", "--compile", "src/cli.ts"], "package-operation"],
    [["node", "--version"], "probe"],
    [["pwsh", "-File", "scripts/build.ps1"], "file"],
  ]) {
    const result = await analyze(argv);
    assert.equal(result.interpreter.mode, mode, JSON.stringify(argv));
    assert.equal(result.runtimeAcceptance, "pending");
  }
});

test("dynamic options and resources cannot masquerade as literal entry files", async () => {
  for (const argv of [
    ["node", { raw: '"$OPTIONS"' }, "script.js"],
    ["bash", { raw: '"$MODE"' }, "script.sh"],
    ["python3", "--unknown", "script.py"],
    ["node", "--require", { raw: '"$MODULE"' }, "script.js"],
  ]) {
    const result = await analyze(argv);
    assert.equal(result.interpreter.mode, "unresolved");
    assert.ok(result.interpreter.reason);
  }
});

test("ordinary commands are not reclassified and nested wrappers have a finite budget", async () => {
  assert.equal(await analyze(["printf", "node -e code"]), undefined);
  const result = await analyze([...Array(17).fill("exec"), "node", "--version"]);
  assert.equal(result.resolution, "unresolved");
  assert.equal(result.reason, "wrapper-depth-exceeded");
});

test("ambiguous shell modes, preload programs and language-specific flags stay unresolved", async () => {
  for (const argv of [
    ["bash", "-sc", "echo data"], ["bash", "-cc", "echo data"],
    ["ruby", "-v", "script.rb"], ["node", "--import", "preload.js", "script.js"],
    ["ruby", "-E", "UTF-8", "script.rb"],
  ]) {
    const result = await analyze(argv);
    assert.equal(result.interpreter.mode, "unresolved", JSON.stringify(argv));
  }
});

test("Perl extended inline code is not confused with Ruby encoding selection", async () => {
  const perl = await analyze(["perl", "-E", "say 1"]);
  assert.equal(perl.interpreter.mode, "inline");
  assert.equal(perl.interpreter.resource.literal, "say 1");
});

test("Bun package linking retains its operation and never invents a file dependency", async () => {
  for (const [operation, tail] of [["link", ["--silent"]], ["unlink", ["package-name"]], ["pm", ["ls"]]]) {
    const result = await analyze(["env", "LANG=C", "bun", operation, ...tail]);
    assert.equal(result.interpreter.mode, "package-operation", operation);
    assert.equal(result.interpreter.operationIndex, 3);
    assert.equal(result.interpreter.operation.literal, operation);
    assert.deepEqual(result.interpreter.arguments.map(argument => argument.literal), tail);
    assert.equal(result.interpreter.resource, undefined);
    assert.equal(result.runtimeAcceptance, "pending");
  }
});

test("Bun bare words need package context before they can become file resources", async () => {
  for (const word of ["custom-script", "future-operation", "outdated", "publish"]) {
    const result = await analyze(["bun", word, "--silent"]);
    assert.equal(result.interpreter.mode, "unresolved", word);
    assert.equal(result.interpreter.reason, "package-task-or-operation-requires-review");
    assert.equal(result.interpreter.resource, undefined);
  }
  for (const word of ["scripts/models.ts", "./entry", "entry.ts"]) {
    const result = await analyze(["bun", word]);
    assert.equal(result.interpreter.mode, "file", word);
    assert.equal(result.interpreter.resource.literal, word);
  }
});
