import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGstackShellCallSites } from "./inspect-shell-call-sites.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";

const wrappers = new Set(["exec", "command", "env", "timeout", "gtimeout", "nohup", "nice", "xargs"]);
const shells = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const interpreters = new Set([...shells, "node", "bun", "python", "python3", "perl", "ruby", "pwsh", "powershell", "powershell.exe"]);
const scriptFile = fileURLToPath(import.meta.url);
const checksum = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const commandName = argument => typeof argument?.literal === "string" ? argument.literal.split("/").at(-1) : undefined;
const unknown = reason => ({ resolution: "unresolved", reason });
const duration = value => typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(value)
  && Number.isFinite(Number(value.replace(/[smhd]$/, ""))) && Number(value.replace(/[smhd]$/, "")) > 0;

// Identify positional boundaries only. Source expressions, stdin programs and
// package-task names remain requirements, never instructions to run or resolve.
export function analyzeGstackShellInvocation(args) {
  if (!Array.isArray(args) || !args.length || args.length > 4096 || args.some(argument =>
    !argument || typeof argument.raw !== "string" || !(argument.literal === null || typeof argument.literal === "string"))) {
    throw new Error("gstack_shell_invocation_arguments_invalid");
  }
  const first = commandName(args[0]);
  if (first === "find") {
    if (!args.some(argument => ["-exec", "-execdir", "-ok", "-okdir"].includes(argument.literal))) return undefined;
    return { kind: "argument-transform", wrappers: [], runtimeAcceptance: "pending", ...unknown("find-execution-boundary") };
  }
  if (!wrappers.has(first) && !interpreters.has(first)) return undefined;
  const chain = [];
  let index = 0;
  while (wrappers.has(commandName(args[index]))) {
    if (chain.length === 16) return { kind: "wrapped-command", wrappers: chain, runtimeAcceptance: "pending", ...unknown("wrapper-depth-exceeded") };
    const name = commandName(args[index]), wrapper = { name, argumentIndex: index };
    chain.push(wrapper);
    const parsed = parseWrapper(args, index, wrapper);
    if (parsed.resolution === "unresolved") return { kind: "wrapped-command", wrappers: chain, runtimeAcceptance: "pending", ...parsed };
    if (parsed.kind) return { wrappers: chain, runtimeAcceptance: "pending", resolution: "identified", ...parsed };
    index = parsed.next;
  }
  if (!args[index]) return { kind: "no-executable", wrappers: chain, runtimeAcceptance: "pending", resolution: "identified" };
  const effectiveCommand = args[index], name = commandName(effectiveCommand);
  if (effectiveCommand.literal === null) return { kind: "wrapped-command", wrappers: chain, runtimeAcceptance: "pending",
    boundaryArgumentIndex: index, boundaryArgument: effectiveCommand, ...unknown("dynamic-effective-command") };
  return { kind: chain.length ? "wrapped-command" : "interpreter", wrappers: chain,
    effectiveCommandIndex: index, effectiveCommand, runtimeAcceptance: "pending",
    resolution: "identified",
    ...(interpreters.has(name) ? { interpreter: parseInterpreter(args, index, name) } : {}) };
}

function parseWrapper(args, start, wrapper) {
  const { name } = wrapper;
  if (name === "xargs") return unknown("input-dependent-argument-transform");
  let index = start + 1, query = false, boundary = false;
  const seen = new Set();
  const mark = key => { if (seen.has(key)) return false; seen.add(key); return true; };
  const value = () => args[index]?.literal;
  while (index < args.length) {
    const word = value();
    if (word === null) return query ? { kind: "discovery", queryArguments: args.slice(index) }
      : { boundaryArgumentIndex: index, boundaryArgument: args[index], ...unknown("dynamic-wrapper-boundary") };
    if (word === "--") { index++; boundary = true; break; }
    if (name === "env" && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "-")) break;
    if (!word.startsWith("-")) break;
    if (name === "command" && /^-[pvV]+$/.test(word)) {
      for (const flag of word.slice(1)) {
        if (!mark(flag) || flag === "v" && seen.has("V") || flag === "V" && seen.has("v")) return unknown("conflicting-wrapper-option");
        if (flag === "v" || flag === "V") query = true;
      }
      index++; continue;
    }
    if (name === "exec" && /^-[cl]+$/.test(word)) {
      for (const flag of word.slice(1)) if (!mark(flag)) return unknown("duplicate-wrapper-option");
      index++; continue;
    }
    if (name === "exec" && word === "-a") {
      if (!mark("argv0") || typeof args[index + 1]?.literal !== "string") return unknown("dynamic-or-missing-wrapper-option-value");
      wrapper.argv0 = args[index + 1]; index += 2; continue;
    }
    if (name === "env" && ["-i", "--ignore-environment", "-"].includes(word)) {
      if (!mark("ignore-environment")) return unknown("duplicate-wrapper-option");
      wrapper.clearEnvironment = true; index++; continue;
    }
    const option = word.split("=", 1)[0];
    const valueOptions = name === "env" ? { "-u": "unset", "--unset": "unset", "-C": "chdir", "--chdir": "chdir" }
      : ["timeout", "gtimeout"].includes(name) ? { "-s": "signal", "--signal": "signal", "-k": "kill-after", "--kill-after": "kill-after" }
        : name === "nice" ? { "-n": "adjustment", "--adjustment": "adjustment" } : {};
    if (Object.hasOwn(valueOptions, option)) {
      const key = valueOptions[option], joined = word.includes("="), item = joined ? word.slice(word.indexOf("=") + 1) : args[index + 1]?.literal;
      if (!mark(key) || typeof item !== "string" || !item ||
        key === "unset" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item) ||
        key === "kill-after" && !duration(item) || key === "adjustment" && !/^[+-]?\d+$/.test(item)) return unknown("invalid-or-duplicate-wrapper-option-value");
      wrapper[key] = item; index += joined ? 1 : 2; continue;
    }
    if (["timeout", "gtimeout"].includes(name) && ["--foreground", "--preserve-status", "-v", "--verbose"].includes(word)) {
      const key = word === "-v" ? "--verbose" : word;
      if (!mark(key)) return unknown("duplicate-wrapper-option");
      index++; continue;
    }
    return unknown("unreviewed-wrapper-option");
  }
  if (name === "env") {
    while (index < args.length) {
      const word = value();
      if (word === null) return unknown("dynamic-wrapper-boundary");
      if (!boundary && word === "-") { wrapper.clearEnvironment = true; index++; continue; }
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) break;
      const key = word.slice(0, word.indexOf("="));
      if (!mark(`assignment:${key}`)) return unknown("duplicate-environment-assignment");
      index++;
    }
  }
  if (["timeout", "gtimeout"].includes(name)) {
    if (!args[index] || args[index].literal === null || !duration(value())) return unknown("dynamic-or-invalid-duration");
    wrapper.duration = args[index++];
    if (!args[index]) return unknown("missing-wrapped-command");
  }
  if (query) return { kind: "discovery", queryArguments: args.slice(index) };
  if (index === args.length) return { kind: "no-executable" };
  return { next: index };
}

function parseInterpreter(args, start, name) {
  let index = start + 1;
  const base = { name }, unresolved = reason => ({ ...base, mode: "unresolved", reason });
  const resource = (mode, at, extra = {}) => args[at]
    ? { ...base, mode, resourceIndex: at, resource: args[at], ...extra } : unresolved("missing-interpreter-resource");
  const inlineAt = (at, offset) => ({ ...base, mode: "inline", resourceIndex: at, resource: args[at], embeddedValueOffset: offset });
  while (index < args.length) {
    const word = args[index].literal;
    if (word === null) return unresolved("dynamic-interpreter-boundary");
    if (word === "--") { index++; break; }
    if (["--version", "-v"].includes(word) && ["node", "bun"].includes(name)) return { ...base, mode: "probe" };
    if (["python", "python3"].includes(name) && ["--version", "-V"].includes(word)) return { ...base, mode: "probe" };
    if (word === "-") return { ...base, mode: "stdin", resourceIndex: index };
    if (shells.has(name)) {
      if (["--noprofile", "--norc"].includes(word)) { index++; continue; }
      if (/^-[a-zA-Z]+$/.test(word)) {
        // Unknown flags can consume the next word or change the execution mode.
        if (!/^-[abefhiklmnptuvxBCEHPTcs]+$/.test(word)) return unresolved("unreviewed-interpreter-option");
        const modes = [...word.slice(1)].filter(flag => flag === "c" || flag === "s");
        if (modes.length > 1) return unresolved("ambiguous-interpreter-mode");
        if (word.includes("c")) return resource("inline", index + 1);
        if (word.includes("s")) return { ...base, mode: "stdin", resourceIndex: index };
        index++; continue;
      }
    } else if (["node", "bun"].includes(name)) {
      if (["-e", "--eval", "-p", "--print"].includes(word)) return resource("inline", index + 1);
      if (word.startsWith("--eval=") || word.startsWith("--print=")) return inlineAt(index, word.indexOf("=") + 1);
      if (name === "bun" && ["install", "build", "test", "add", "remove", "update", "x", "create", "init", "link", "unlink", "pm"].includes(word)) {
        return { ...base, mode: "package-operation", operationIndex: index, operation: args[index], arguments: args.slice(index + 1) };
      }
      if (name === "bun" && word === "run") {
        const target = args[index + 1];
        if (!target || target.literal === null || target.literal.startsWith("-")) return unresolved("dynamic-package-task-or-resource");
        return resource(target.literal.includes("/") || /\.[cm]?[jt]sx?$/.test(target.literal) ? "file" : "package-task", index + 1);
      }
      if (name === "bun" && !word.startsWith("-") && !word.includes("/") && !/\.[cm]?[jt]sx?$/.test(word)) {
        return unresolved("package-task-or-operation-requires-review");
      }
      if (["--no-warnings", "--trace-warnings", "--enable-source-maps"].includes(word)) { index++; continue; }
      if (["--require", "-r", "--import", "--loader"].includes(word) || /^(?:--require|--import|--loader)=/.test(word)) {
        return unresolved("preload-resource-requires-review");
      }
    } else if (["python", "python3"].includes(name)) {
      if (word === "-c") return resource("inline", index + 1);
      if (word === "-m") return resource("module", index + 1);
      if (/^-[BIEsSu]+$/.test(word)) { index++; continue; }
    } else if (["perl", "ruby"].includes(name)) {
      if (word === "-e" || name === "perl" && word === "-E") return resource("inline", index + 1);
    } else if (["pwsh", "powershell", "powershell.exe"].includes(name)) {
      const option = word.toLowerCase();
      if (option === "-file") return resource("file", index + 1);
      if (option === "-command") return resource("inline", index + 1);
      if (["-noprofile", "-noninteractive", "-nologo"].includes(option)) { index++; continue; }
      if (option === "-encodedcommand") return resource("encoded-inline", index + 1);
    }
    if (word.startsWith("-")) return unresolved("unreviewed-interpreter-option");
    return resource("file", index);
  }
  if (!args[index]) return { ...base, mode: "stdin" };
  return args[index].literal === null ? unresolved("dynamic-interpreter-boundary") : resource("file", index);
}

export async function inspectGstackShellInvocations(options) {
  const ownInput = await readGstackClosureFileRecord(scriptFile);
  const calls = await inspectGstackShellCallSites(options), invocations = [];
  for (const script of calls.scripts) {
    for (const call of script.calls) {
      const interpretation = analyzeGstackShellInvocation(call.arguments);
      if (interpretation) invocations.push({ consumerPath: script.path, consumerChecksum: script.checksum, ...call, interpretation });
    }
  }
  if ((await readGstackClosureFileRecord(scriptFile)).checksum !== ownInput.checksum) throw new Error("gstack_shell_invocation_tool_changed");
  const toolInputs = [...calls.toolInputs, { path: "inspect-shell-invocations.mjs", checksum: ownInput.checksum, sizeBytes: ownInput.sizeBytes }];
  return { schemaVersion: 1, deliveryStage: "resource-prerequisites", validationMode: "static-invocation-analysis",
    upstreamRevision: calls.upstreamRevision, sourceManifestChecksum: calls.sourceManifestChecksum,
    callGraphChecksum: calls.callGraphChecksum, invocationGraphChecksum: checksum(JSON.stringify(invocations)), invocations,
    toolInputs, toolInputGraphChecksum: checksum(JSON.stringify(toolInputs)),
    dependencyClosure: "pending", hostAcceptance: "pending", packageAcceptance: "pending", releaseEligible: false,
    pendingGates: ["review-every-effective-executable-and-interpreter-resource", "stdin-and-inline-program-resource-closure",
      "argument-transform-and-dynamic-boundary-adaptation", "owned-runtime-policy-enforcement", "redistribution-review",
      "native-windows-validation", "real-skill-execution", "installed-client-acceptance"] };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptFile) {
  const [runtimeRoot, parserPath, expectedParserChecksum, reportPath, shellPath = "/bin/bash"] = process.argv.slice(2);
  if (!runtimeRoot || !parserPath || !reportPath) throw new Error("Usage: node inspect-shell-invocations.mjs <runtime-root> <parser-path> <parser-sha256> <report-path> [bash-path]");
  const inventory = JSON.parse((await readGstackClosureFileRecord(fileURLToPath(new URL("./pinned-shell-inventory.json", import.meta.url)), { retain: true })).bytes);
  const interpreter = await realpath(shellPath);
  const report = await inspectGstackShellInvocations({ runtimeRoot, parserPath, expectedParserChecksum,
    expectedSourceManifestChecksum: inventory.sourceManifestChecksum, expectedUpstreamRevision: inventory.upstreamRevision,
    shellPath: interpreter, expectedShellChecksum: (await readGstackClosureFileRecord(interpreter)).checksum });
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await writeFile(reportPath, bytes, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ receiptChecksum: checksum(bytes), invocations: report.invocations.length,
    invocationGraphChecksum: report.invocationGraphChecksum, releaseEligible: false }));
}
