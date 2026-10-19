import { basename } from "node:path";
import { parse } from "shell-quote";

const shells = new Set(["sh", "bash", "zsh", "dash"]);
const wrappers = new Set(["env", "sudo", "xargs", "exec", "eval", "command", "builtin", "nohup", "time", "timeout", "nice", "fish", "csh", "tcsh",
  "python", "python3", "node", "nodejs", "perl", "ruby", "php", "osascript", "powershell", "pwsh", "cmd"]);

/** Policy classification only. Never execute this normalized string in place of native input. */
export function commandForPolicy(command: string, depth = 0): string | undefined {
  if (depth > 2 || /[\r\n`]/.test(command)) return undefined;
  let parts: ReturnType<typeof parse>;
  try { parts = parse(command, () => { throw new Error("shell_expansion"); }); }
  catch { return undefined; }
  if (!parts.length || parts.some(part => typeof part !== "string")) return undefined;
  const argv = parts as string[];
  if (!argv[0] || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) return undefined;
  const program = basename(argv[0]);
  if (shells.has(program)) return argv.length === 3 && ["-c", "-lc"].includes(argv[1]!) ? commandForPolicy(argv[2]!, depth + 1) : undefined;
  if (wrappers.has(program) || /^(?:python[\d.]*|node[\d.]*|powershell\.exe|pwsh\.exe|cmd\.exe)$/.test(program)) return undefined;
  return [program, ...argv.slice(1)].join(" ");
}
