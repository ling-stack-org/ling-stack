export type ComposerSlashIntent =
  | { readonly kind: "none" }
  | {
      readonly kind: "global_command";
      readonly commandId: string;
      readonly commandLabel: string;
      readonly args: string;
      readonly raw: string;
    }
  | {
      readonly kind: "agent_command";
      readonly teammateId: string;
      readonly teammateLabel: string;
      readonly commandId: string;
      readonly commandLabel: string;
      readonly args: string;
      readonly raw: string;
    }
  | {
      readonly kind: "multi_agent_command";
      readonly teammates: readonly ComposerSlashMentionOption[];
      readonly commandId: string;
      readonly commandLabel: string;
      readonly args: string;
      readonly raw: string;
    };

export interface ComposerSlashMentionOption {
  readonly id: string;
  readonly label: string;
}

export interface ComposerSlashCommandOption {
  readonly id: string;
  readonly label: string;
}

export interface ComposerSlashFallbackSkill {
  readonly id: string;
  readonly name: string;
}

export interface ComposerSlashRegistryEntry {
  readonly id: string;
  readonly definition: {
    readonly name: string;
  };
  readonly reviewStatus: string;
  readonly visibility?: {
    readonly workspaceVisible?: boolean;
  };
}

export interface BuildComposerSlashCommandOptionsInput {
  readonly fallbackSkills?: readonly ComposerSlashFallbackSkill[];
  readonly registryEntries?: readonly ComposerSlashRegistryEntry[];
}

export interface ParseComposerSlashIntentOptions {
  readonly teammateMentions?: readonly ComposerSlashMentionOption[];
  readonly commands?: readonly ComposerSlashCommandOption[];
}

const slashCommandPattern = /^\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?=\s|$)/;

export function buildComposerSlashCommandOptions(input: BuildComposerSlashCommandOptionsInput = {}): readonly ComposerSlashCommandOption[] {
  const fallbackSkills = input.fallbackSkills ?? [];
  if (input.registryEntries === undefined) {
    return uniqueCommandOptions(fallbackSkills.map((skill) => ({ id: skill.id, label: skill.name || skill.id })));
  }

  const registryById = new Map(input.registryEntries.map((entry) => [entry.id, entry]));
  const commands: ComposerSlashCommandOption[] = [];
  const addedIds = new Set<string>();

  for (const skill of fallbackSkills) {
    const registryEntry = registryById.get(skill.id);
    if (registryEntry) {
      addRegistryCommand(commands, addedIds, registryEntry);
    } else {
      addCommand(commands, addedIds, { id: skill.id, label: skill.name || skill.id });
    }
  }

  for (const registryEntry of input.registryEntries) {
    addRegistryCommand(commands, addedIds, registryEntry);
  }

  return commands;
}

export function parseComposerSlashIntent(text: string, options: ParseComposerSlashIntentOptions = {}): ComposerSlashIntent {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: "none" };
  }

  const mentionRead = readLeadingMentions(trimmed, options.teammateMentions ?? []);
  if (mentionRead) {
    const commandText = mentionRead.remaining.trimStart();
    const command = readRegisteredCommand(commandText, options.commands ?? []);
    if (!command) {
      return { kind: "none" };
    }
    if (mentionRead.teammates.length > 1) {
      return {
        kind: "multi_agent_command",
        teammates: mentionRead.teammates,
        commandId: command.option.id,
        commandLabel: command.option.label,
        args: command.args,
        raw: trimmed,
      };
    }
    const teammate = mentionRead.teammates[0];
    return {
      kind: "agent_command",
      teammateId: teammate.id,
      teammateLabel: teammate.label,
      commandId: command.option.id,
      commandLabel: command.option.label,
      args: command.args,
      raw: trimmed,
    };
  }

  const command = readRegisteredCommand(trimmed, options.commands ?? []);
  if (!command) {
    return { kind: "none" };
  }
  return {
    kind: "global_command",
    commandId: command.option.id,
    commandLabel: command.option.label,
    args: command.args,
    raw: trimmed,
  };
}

function readLeadingMentions(
  text: string,
  teammateMentions: readonly ComposerSlashMentionOption[],
): { readonly teammates: readonly ComposerSlashMentionOption[]; readonly remaining: string } | undefined {
  let remaining = text;
  const teammates: ComposerSlashMentionOption[] = [];
  const seenIds = new Set<string>();
  while (true) {
    const mention = readLeadingTeammateMention(remaining, teammateMentions, seenIds);
    if (!mention) {
      break;
    }
    teammates.push(mention.teammate);
    seenIds.add(mention.teammate.id);
    remaining = remaining.slice(mention.raw.length).trimStart();
  }
  return teammates.length > 0 ? { teammates, remaining } : undefined;
}

function readLeadingTeammateMention(
  text: string,
  teammateMentions: readonly ComposerSlashMentionOption[],
  seenIds: ReadonlySet<string>,
): { readonly teammate: ComposerSlashMentionOption; readonly raw: string } | undefined {
  const aliases = teammateMentions
    .filter((teammate) => !seenIds.has(teammate.id))
    .flatMap((teammate) => teammateMentionAliases(teammate).map((alias) => ({ teammate, alias })))
    .sort((left, right) => right.alias.length - left.alias.length);

  for (const { teammate, alias } of aliases) {
    const raw = `@${alias}`;
    if (startsWithCaseInsensitive(text, raw) && hasMentionBoundary(text, raw.length)) {
      return { teammate, raw: text.slice(0, raw.length) };
    }
  }
  return undefined;
}

function readRegisteredCommand(
  text: string,
  commands: readonly ComposerSlashCommandOption[],
): { readonly option: ComposerSlashCommandOption; readonly args: string } | undefined {
  const match = slashCommandPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const commandToken = match[1] ?? "";
  const option = commands.find((candidate) => commandMatches(candidate, commandToken));
  if (!option) {
    return undefined;
  }
  return {
    option,
    args: text.slice(match[0].length).trimStart(),
  };
}

function addRegistryCommand(commands: ComposerSlashCommandOption[], addedIds: Set<string>, entry: ComposerSlashRegistryEntry): void {
  if (!registryEntryIsCommandVisible(entry)) {
    return;
  }
  addCommand(commands, addedIds, { id: entry.id, label: entry.definition.name || entry.id });
}

function addCommand(commands: ComposerSlashCommandOption[], addedIds: Set<string>, command: ComposerSlashCommandOption): void {
  const id = command.id.trim();
  if (!id || addedIds.has(id)) {
    return;
  }
  addedIds.add(id);
  commands.push({ id, label: command.label.trim() || id });
}

function uniqueCommandOptions(commands: readonly ComposerSlashCommandOption[]): readonly ComposerSlashCommandOption[] {
  const unique: ComposerSlashCommandOption[] = [];
  const addedIds = new Set<string>();
  for (const command of commands) {
    addCommand(unique, addedIds, command);
  }
  return unique;
}

function registryEntryIsCommandVisible(entry: ComposerSlashRegistryEntry): boolean {
  return (entry.reviewStatus === "builtin" || entry.reviewStatus === "published") && entry.visibility?.workspaceVisible !== false;
}

function commandMatches(command: ComposerSlashCommandOption, token: string): boolean {
  const normalizedToken = normalizeLabel(token);
  return normalizeLabel(command.id) === normalizedToken || normalizeLabel(command.label) === normalizedToken;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function teammateMentionAliases(teammate: ComposerSlashMentionOption): readonly string[] {
  return uniqueStrings([
    teammate.label.trim(),
    teammate.id.trim(),
    normalizeLabel(teammate.label),
    normalizeLabel(teammate.id),
  ]);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    if (!value || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function hasMentionBoundary(value: string, index: number): boolean {
  const next = value[index];
  return next === undefined || /\s/u.test(next);
}
