#!/usr/bin/env node

const command = process.argv[2] ?? "help";

if (command === "help" || command === "--help" || command === "-h") {
  console.log(`Ling Stack CLI

Usage:
  ling-stack init
  ling-stack provider add
  ling-stack provider check
  ling-stack channel create
  ling-stack teammate create
  ling-stack task create
  ling-stack run
  ling-stack approvals list
  ling-stack approvals approve
  ling-stack ui
`);
  process.exit(0);
}

console.error(`Command not implemented yet: ${command}`);
process.exit(1);
