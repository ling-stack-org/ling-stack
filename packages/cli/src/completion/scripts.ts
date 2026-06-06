import { commandSpec, globalOptions, type CommandSpec, type OptionSpec } from "./command-spec.js";

export const supportedCompletionShells = ["bash", "zsh", "fish"] as const;

export type CompletionShell = typeof supportedCompletionShells[number];

export function generateCompletionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion(commandSpec);
    case "zsh":
      return generateZshCompletion(commandSpec);
    case "fish":
      return generateFishCompletion(commandSpec);
  }
}

function generateBashCompletion(root: CommandSpec): string {
  const rootCommands = (root.subcommands ?? []).map((command) => command.name).join(" ");
  const cases = flattenCommandCases(root)
    .map(({ path, words }) => {
      const caseKey = path.join(" ");
      return `    ${shellSingleQuote(caseKey)}) candidates=${shellSingleQuote(words.join(" "))} ;;`;
    })
    .join("\n");

  return `# bash completion for ling-stack
_ling_stack_completion() {
  local cur path candidates
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [[ "\${cur}" == --* ]]; then
    candidates=${shellSingleQuote(optionWords(root).join(" "))}
    COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
    return 0
  fi
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    candidates=${shellSingleQuote(rootCommands)}
    COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
    return 0
  fi
  path="\${COMP_WORDS[1]}"
  if [[ \${COMP_CWORD} -ge 3 ]]; then
    path="\${path} \${COMP_WORDS[2]}"
  fi
  if [[ \${COMP_CWORD} -ge 4 ]]; then
    path="\${path} \${COMP_WORDS[3]}"
  fi
  case "\${path}" in
${cases}
    *) candidates=${shellSingleQuote(rootCommands)} ;;
  esac
  COMPREPLY=( $(compgen -W "\${candidates}" -- "\${cur}") )
  return 0
}
complete -F _ling_stack_completion ling-stack
`;
}

function generateZshCompletion(root: CommandSpec): string {
  const rootCommands = (root.subcommands ?? [])
    .map((command) => `${command.name}:${escapeZsh(command.summary)}`)
    .join(" ");
  const allWords = allCompletionWords(root).join(" ");
  return `#compdef ling-stack
# zsh completion for ling-stack
_ling_stack() {
  local -a commands words
  commands=(${rootCommands})
  words=(${allWords})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  else
    _describe 'ling-stack word' words
  fi
}
_ling_stack "$@"
`;
}

function generateFishCompletion(root: CommandSpec): string {
  const lines: string[] = ["# fish completion for ling-stack"];
  for (const command of root.subcommands ?? []) {
    lines.push(`complete -c ling-stack -f -n '__fish_use_subcommand' -a ${fishQuote(command.name)} -d ${fishQuote(command.summary)}`);
    for (const subcommand of command.subcommands ?? []) {
      lines.push(`complete -c ling-stack -f -n '__fish_seen_subcommand_from ${fishQuote(command.name)}' -a ${fishQuote(subcommand.name)} -d ${fishQuote(subcommand.summary)}`);
      for (const nested of subcommand.subcommands ?? []) {
        lines.push(`complete -c ling-stack -f -n '__fish_seen_subcommand_from ${fishQuote(subcommand.name)}' -a ${fishQuote(nested.name)} -d ${fishQuote(nested.summary)}`);
      }
    }
  }
  for (const option of allOptionWords(root)) {
    if (option.startsWith("--")) {
      lines.push(`complete -c ling-stack -l ${fishQuote(option.slice(2))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function flattenCommandCases(root: CommandSpec): Array<{ path: readonly string[]; words: readonly string[] }> {
  const cases: Array<{ path: readonly string[]; words: readonly string[] }> = [];
  for (const command of root.subcommands ?? []) {
    collectCases(command, [command.name], cases);
  }
  return cases;
}

function collectCases(command: CommandSpec, path: readonly string[], cases: Array<{ path: readonly string[]; words: readonly string[] }>): void {
  cases.push({ path, words: commandWords(command) });
  for (const subcommand of command.subcommands ?? []) {
    collectCases(subcommand, [...path, subcommand.name], cases);
  }
}

function commandWords(command: CommandSpec): readonly string[] {
  return [
    ...(command.subcommands ?? []).map((subcommand) => subcommand.name),
    ...optionWords(command),
    ...(command.positional?.values ?? []),
  ];
}

function allCompletionWords(root: CommandSpec): readonly string[] {
  const words = new Set<string>();
  for (const command of root.subcommands ?? []) {
    collectWords(command, words);
  }
  return [...words].sort();
}

function allOptionWords(root: CommandSpec): readonly string[] {
  const words = new Set<string>(optionWords(root));
  for (const command of root.subcommands ?? []) {
    collectOptionWords(command, words);
  }
  return [...words].sort();
}

function collectOptionWords(command: CommandSpec, words: Set<string>): void {
  for (const word of optionWords(command)) {
    words.add(word);
  }
  for (const subcommand of command.subcommands ?? []) {
    collectOptionWords(subcommand, words);
  }
}

function collectWords(command: CommandSpec, words: Set<string>): void {
  words.add(command.name);
  for (const word of commandWords(command)) {
    words.add(word);
  }
  for (const subcommand of command.subcommands ?? []) {
    collectWords(subcommand, words);
  }
}

function optionWords(command: CommandSpec): readonly string[] {
  const words: string[] = [];
  const options = command.name === "ling-stack"
    ? command.options ?? []
    : [...globalOptions, ...(command.options ?? [])];
  for (const option of options) {
    words.push(option.name);
    if (option.alias) {
      words.push(option.alias);
    }
    if (option.values) {
      words.push(...option.values);
    }
  }
  return [...new Set(words)];
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function fishQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeZsh(value: string): string {
  return value.replace(/:/g, "\\:");
}
