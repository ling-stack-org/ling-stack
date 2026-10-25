// Builder's source-map exception handler prints only the outer stack. Observe
// fatal failures before that handler without handling them or changing exit status.
process.on("uncaughtExceptionMonitor", error => {
  const seen = new Set(), causes = [], commands = [];
  const visit = current => {
    if (!(current instanceof Error) || seen.has(current) || causes.length >= 8) return;
    seen.add(current);
    causes.push(String(current.stack ?? current.message).slice(0, 4096));
    if (typeof current.killed === "boolean") commands.push({
      causeIndex: causes.length - 1,
      code: typeof current.code === "number" ? current.code
        : typeof current.code === "string" ? current.code.slice(0, 256) : null,
      signal: typeof current.signal === "string" ? current.signal.slice(0, 32) : null,
      killed: current.killed,
      stdout: typeof current.stdout === "string" ? current.stdout.slice(0, 4096) : "",
      stderr: typeof current.stderr === "string" ? current.stderr.slice(0, 4096) : "",
    });
    visit(current.cause);
    if (current instanceof AggregateError) for (const nested of current.errors.slice(0, 8)) visit(nested);
  };
  visit(error);
  process.stderr.write(`desktop_package_failure_causes=${JSON.stringify(causes)}\n`);
  if (commands.length) process.stderr.write(`desktop_package_command_failures=${JSON.stringify(commands)}\n`);
});
