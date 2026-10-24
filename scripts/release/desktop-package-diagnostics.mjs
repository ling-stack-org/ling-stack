// Builder's source-map exception handler prints only the outer stack. Observe
// fatal failures before that handler without handling them or changing exit status.
process.on("uncaughtExceptionMonitor", error => {
  const seen = new Set(), causes = [];
  const visit = current => {
    if (!(current instanceof Error) || seen.has(current) || causes.length >= 8) return;
    seen.add(current);
    causes.push(String(current.stack ?? current.message).slice(0, 4096));
    visit(current.cause);
    if (current instanceof AggregateError) for (const nested of current.errors.slice(0, 8)) visit(nested);
  };
  visit(error);
  process.stderr.write(`desktop_package_failure_causes=${JSON.stringify(causes)}\n`);
});
