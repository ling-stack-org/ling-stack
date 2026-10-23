// Builder's source-map exception handler prints only the outer stack. Observe
// fatal failures before that handler without handling them or changing exit status.
process.on("uncaughtExceptionMonitor", error => {
  const seen = new Set(), causes = [];
  for (let current = error; current instanceof Error && !seen.has(current) && causes.length < 8; current = current.cause) {
    seen.add(current);
    causes.push(String(current.stack ?? current.message).slice(0, 4096));
  }
  process.stderr.write(`desktop_package_failure_causes=${JSON.stringify(causes)}\n`);
});
