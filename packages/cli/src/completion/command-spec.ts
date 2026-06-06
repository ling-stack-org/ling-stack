export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly subcommands?: readonly CommandSpec[];
  readonly options?: readonly OptionSpec[];
  readonly positional?: PositionalSpec;
}

export interface OptionSpec {
  readonly name: string;
  readonly alias?: string;
  readonly value?: "none" | "required" | "optional";
  readonly repeatable?: boolean;
  readonly values?: readonly string[];
  readonly valueHint?: "file" | "directory" | "provider" | "channel" | "task" | "run";
  readonly global?: boolean;
}

export interface PositionalSpec {
  readonly name: string;
  readonly values?: readonly string[];
  readonly repeatable?: boolean;
  readonly valueHint?: OptionSpec["valueHint"];
}

export const globalOptions: readonly OptionSpec[] = [
  { name: "--daemon-url", value: "required", global: true },
  { name: "--cwd", value: "required", valueHint: "directory", global: true },
  { name: "--json", value: "none", global: true },
  { name: "--verbose", value: "none", global: true },
  { name: "--no-color", value: "none", global: true },
  { name: "--help", alias: "-h", value: "none", global: true },
];

export const commandSpec: CommandSpec = {
  name: "ling-stack",
  summary: "Ling Stack CLI",
  options: globalOptions,
  subcommands: [
    command("init", "Initialize a workspace", [], [
      option("--with-provider-templates"),
      option("--no-provider-templates"),
    ]),
    command("doctor", "Diagnose workspace readiness", [], [
      option("--summary"),
      option("--all"),
      option("--ascii"),
    ]),
    command("daemon", "Manage local daemon", [
      command("status", "Show daemon status"),
      command("start", "Start daemon", [], [
        option("--host", "required"),
        option("--port", "required"),
        option("--timeout", "required"),
        option("--foreground"),
      ]),
      command("stop", "Stop daemon", [], [
        option("--timeout", "required"),
        option("--force"),
      ]),
      command("restart", "Restart daemon", [], [
        option("--timeout", "required"),
        option("--force"),
      ]),
      command("logs", "Read daemon logs", [], [
        option("--lines", "required"),
      ]),
    ]),
    command("provider", "Manage providers", [
      command("list", "List providers"),
      command("add", "Add provider", [], providerOptions()),
      command("show", "Show provider", [], [], { name: "id", valueHint: "provider" }),
      command("check", "Check provider", [], [], { name: "id", valueHint: "provider" }),
      command("check-all", "Check all providers"),
      command("update", "Update provider", [], [
        ...providerOptions(),
        option("--clear-base-url"),
        option("--clear-api-key-ref"),
        option("--clear-auth-header"),
        option("--clear-reasoning"),
        option("--clear-context-window"),
        option("--clear-max-tokens"),
      ], { name: "id", valueHint: "provider" }),
      command("remove", "Remove provider", [], [], { name: "id", valueHint: "provider" }),
    ]),
    command("channel", "Manage channels", [
      command("list", "List channels", [], [option("--limit", "required")]),
      command("create", "Create channel", [], channelOptions()),
      command("show", "Show channel", [], [], { name: "id", valueHint: "channel" }),
      command("update", "Update channel", [], [
        ...channelOptions(),
        option("--clear-path"),
        option("--clear-provider"),
        option("--clear-teammate"),
      ], { name: "id", valueHint: "channel" }),
      command("remove", "Remove channel", [], [], { name: "id", valueHint: "channel" }),
    ]),
    command("task", "Manage tasks", [
      command("list", "List tasks", [], [
        option("--channel", "required"),
        option("--status", "required"),
        option("--limit", "required"),
      ]),
      command("create", "Create task", [], taskOptions()),
      command("show", "Show task", [], [], { name: "id", valueHint: "task" }),
      command("update", "Update task", [], [
        ...taskOptions(),
        option("--clear-assignee"),
        option("--clear-current-run"),
      ], { name: "id", valueHint: "task" }),
      command("run", "Run task", [], runOptions(false), { name: "id", valueHint: "task" }),
      command("remove", "Remove task", [], [], { name: "id", valueHint: "task" }),
    ]),
    command("run", "Run a direct prompt", [], runOptions(true), { name: "prompt", repeatable: true }),
    command("runs", "Inspect runs", [
      command("list", "List runs", [], [
        option("--status", "required"),
        option("--limit", "required"),
      ]),
      command("show", "Show run", [], [], { name: "id", valueHint: "run" }),
      command("events", "Show run events", [], [
        option("--after-seq", "required"),
        option("--limit", "required"),
      ], { name: "id", valueHint: "run" }),
      command("cancel", "Cancel run", [], [], { name: "id", valueHint: "run" }),
    ]),
    command("automations", "Manage automations", [
      command("scheduler", "Manage local automation scheduler", [
        command("start", "Start local automation scheduler"),
        command("status", "Show local automation scheduler status"),
        command("stop", "Stop local automation scheduler"),
      ]),
    ]),
    command("external-work", "Manage external work", [
      command("github", "GitHub workflows", [
        command("import", "Import GitHub payload", [], externalWorkCommonOptions()),
        command("poll", "Poll GitHub", [], externalWorkCommonOptions()),
        command("background", "Manage background polling", [
          command("start", "Start background polling", [], externalWorkCommonOptions()),
          command("list", "List background pollers"),
          command("stop", "Stop background poller", [], [], { name: "schedulerId" }),
        ]),
        command("ci", "GitHub CI workflows", [
          command("triage", "Triage CI", [], [
            option("--external-work", "required"),
            option("--workflow-path", "required", "file"),
            option("--no-create-task"),
          ]),
          command("run", "Run CI fix", [], [
            option("--triage", "required"),
            option("--provider", "required", "provider"),
            option("--skip-preflight"),
            option("--execute-hooks"),
          ]),
        ]),
      ]),
      command("status", "Show external work status", [], externalWorkCommonOptions()),
      command("list", "List external work", [], [
        option("--channel", "required", "channel"),
        option("--status", "required"),
        option("--source-kind", "required"),
        option("--work-item-kind", "required"),
        option("--limit", "required"),
      ]),
      command("show", "Show external work", [], [], { name: "externalWorkId" }),
      command("actions", "Manage external actions", [
        command("propose-comment", "Propose comment", [], actionOptions()),
        command("propose-labels", "Propose labels", [], [
          option("--external-work", "required"),
          option("--label", "required"),
          option("--approval", "required"),
        ]),
        command("propose-review", "Propose review", [], actionOptions()),
        command("list", "List actions", [], [
          option("--external-work", "required"),
          option("--status", "required"),
        ]),
        command("show", "Show action", [], [], { name: "actionId" }),
        command("cancel", "Cancel action", [], [option("--reason", "required")], { name: "actionId" }),
        command("execute", "Execute approved action", [], [
          option("--workflow-path", "required", "file"),
        ], { name: "actionId" }),
      ]),
      command("reconcile", "Reconcile external work", [], externalWorkCommonOptions()),
    ]),
    command("approvals", "Manage approvals", [
      command("list", "List approvals", [], [
        option("--status", "required"),
        option("--run-id", "required", "run"),
        option("--media-job-id", "required"),
        option("--limit", "required"),
      ]),
      command("show", "Show approval", [], [], { name: "id" }),
      command("approve", "Approve request", [], [option("--reason", "required")], { name: "id" }),
      command("deny", "Deny request", [], [option("--reason", "required")], { name: "id" }),
    ]),
    command("policy", "Manage approval policy", [
      command("show", "Show policy"),
      command("set", "Set policy", [], [
        option("--tool", "required"),
        option("--write-path", "required", "directory"),
      ]),
      command("reset", "Reset policy"),
    ]),
    command("ui", "Open Web UI", [], [
      option("--host", "required"),
      option("--port", "required"),
      option("--url", "required"),
      option("--open"),
      option("--foreground"),
    ]),
    command("completion", "Generate shell completion", [], [], {
      name: "shell",
      values: ["bash", "zsh", "fish"],
    }),
  ],
};

function command(
  name: string,
  summary: string,
  subcommands: readonly CommandSpec[] = [],
  options: readonly OptionSpec[] = [],
  positional?: PositionalSpec,
): CommandSpec {
  return {
    name,
    summary,
    ...(subcommands.length > 0 ? { subcommands } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(positional ? { positional } : {}),
  };
}

function option(name: string, value: "none" | "required" | "optional" = "none", valueHint?: OptionSpec["valueHint"]): OptionSpec {
  return { name, value, ...(valueHint ? { valueHint } : {}) };
}

function providerOptions(): readonly OptionSpec[] {
  return [
    option("--name", "required"),
    option("--display-name", "required"),
    option("--kind", "required"),
    option("--provider-id", "required"),
    option("--model", "required"),
    option("--api", "required"),
    option("--base-url", "required"),
    option("--api-key-ref", "required"),
    option("--context-window", "required"),
    option("--max-tokens", "required"),
    option("--enabled", "required"),
    option("--headers-json", "required"),
    option("--compat-json", "required"),
    option("--capability", "required"),
    option("--input", "required"),
    option("--header", "required"),
    option("--auth-header"),
    option("--no-auth-header"),
    option("--reasoning"),
    option("--no-reasoning"),
    option("--disabled"),
  ];
}

function channelOptions(): readonly OptionSpec[] {
  return [
    option("--name", "required"),
    option("--path", "required", "directory"),
    option("--provider", "required", "provider"),
    option("--teammate", "required"),
    option("--status", "required"),
    option("--execution-mode", "required"),
    option("--write-lock-scope", "required"),
    option("--max-concurrent-runs", "required"),
    option("--tool", "required"),
    option("--read-only-parallel"),
    option("--no-read-only-parallel"),
    option("--queue-on-conflict"),
    option("--no-queue-on-conflict"),
  ];
}

function taskOptions(): readonly OptionSpec[] {
  return [
    option("--channel", "required", "channel"),
    option("--title", "required"),
    option("--prompt", "required"),
    option("--prompt-file", "required", "file"),
    option("--status", "required"),
    option("--assignee", "required"),
    option("--current-run", "required", "run"),
  ];
}

function runOptions(includePromptOptions: boolean): readonly OptionSpec[] {
  return [
    option("--provider", "required", "provider"),
    option("--title", "required"),
    option("--task", "required", "task"),
    option("--thinking", "required"),
    option("--system-prompt", "required"),
    option("--agent-dir", "required", "directory"),
    ...(includePromptOptions ? [
      option("--prompt", "required"),
      option("--prompt-file", "required", "file"),
      option("--output-last-message", "required", "file"),
    ] : []),
    option("--tool", "required"),
    option("--append-system-prompt", "required"),
    option("--skip-preflight"),
  ];
}

function externalWorkCommonOptions(): readonly OptionSpec[] {
  return [
    option("--channel", "required", "channel"),
    option("--event-type", "required"),
    option("--payload-file", "required", "file"),
    option("--workflow-path", "required", "file"),
    option("--workflow-markdown-file", "required", "file"),
    option("--limit", "required"),
    option("--no-run-immediately"),
    option("--execute-hooks"),
  ];
}

function actionOptions(): readonly OptionSpec[] {
  return [
    option("--external-work", "required"),
    option("--body-file", "required", "file"),
    option("--event", "required"),
    option("--approval", "required"),
  ];
}
