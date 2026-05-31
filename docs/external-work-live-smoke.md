# External Work Live Smoke

This smoke validates the GitHub external-work path against a real repository while
preserving the Phase 1-3 safety boundary:

- GitHub poll/reconcile uses read-only `GET` endpoints.
- Import, list, show, propose, and cancel only write local Ling records and artifacts.
- Approval does not execute a GitHub mutation.
- `external-work actions execute` is the only command that can post a GitHub comment or
  add labels, and only after approval plus immediate stale-target revalidation.

Use a disposable repository, PR, or issue for the optional mutation step. The default
script below never approves or executes an action.

## Read-only live smoke

From the repository root:

```bash
corepack pnpm build

# Recommended for API limits. The token is passed only to the local daemon process.
export GITHUB_TOKEN="$(gh auth token)"

node examples/external-work/github/live-readonly-smoke.mjs \
  --repo owner/repo \
  --limit 1 \
  --port 17991
```

The script creates a temporary Ling workspace, writes a repository-specific
`WORKFLOW.md`, starts an isolated daemon on the requested port, creates a channel,
polls GitHub for one open PR or issue, creates local external-work workflow and
scheduler records, proposes a local comment action, cancels that proposal, reconciles
state, and verifies `runs list` stays empty.

Expected output includes:

```text
PASS: live read-only external work smoke completed.
Runs: 0 (external work smoke did not start the runner).
```

If the selected repository has no open PRs or issues, choose a test repository with one
open subject or raise `--limit`.

## Manual Web approval smoke

Use the temporary workspace printed by the read-only script, or create your own
workspace with the commands in `examples/external-work/github/README.md`.

1. Start the daemon with `GITHUB_TOKEN` in its environment.
2. Poll or import a PR/issue into a channel.
3. Propose a comment or label action.
4. Open the Web app against the same daemon and workspace.
5. In Inbox, confirm the approval card shows the GitHub target, proposed payload,
   approval status, action status, and linked artifacts.
6. Approve the action and verify the card changes to `approved`.
7. Do not click `Execute action` unless this is a disposable test target.

This validates the Phase 3.2 Web approval card without mutating GitHub.

## Optional CI triage and local fix run smoke

Use this section against a disposable PR with a failing GitHub Actions job. The commands
read CI metadata and logs, create local evidence, and optionally start a local Ling run.
They do not push commits or mutate GitHub.

```bash
tmpdir="/path/from/read-only-smoke"
export LING_STACK_DAEMON_URL="http://127.0.0.1:17991"

external_work_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work list \
  --status ready \
  --work-item-kind github_pull_request \
  --limit 1 \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).externalWork[0].externalWork.id));')"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work github ci triage \
  --external-work "$external_work_id" \
  --workflow-path WORKFLOW.md \
  --limit 5
```

Verify:

- The output shows one or more triage records when the PR has failing CI.
- The linked artifacts include normalized CI failure metadata and a bounded redacted log
  excerpt when GitHub exposes job logs.
- `runs list` is still empty after triage.
- Opening the Web Workspace for the same channel shows the CI triage record and linked
  artifact; the task Inspector filters that view to the selected local fix task.

To explicitly start the local fix run, choose a provider preset that has already passed
provider preflight:

```bash
triage_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work github ci triage \
  --external-work "$external_work_id" \
  --workflow-path WORKFLOW.md \
  --limit 1 \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).records[0].triage.id));')"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work github ci run \
  --triage "$triage_id" \
  --provider provider_...
```

Verify:

- The command streams a normal local run and prints `Run: run_...`.
- Repeating the same command returns the same run id instead of starting another runner.
- The triage record is updated to `run_requested` with the linked `runId` in the next
  repeated triage response.
- No GitHub comment, label, review, push, merge, release, or issue close occurs.

## Optional live mutation smoke

Only use this section against a repository and PR/issue you control. The action will
post a real GitHub issue comment or add real labels.

Prepare a local action:

```bash
tmpdir="/path/from/read-only-smoke"
export LING_STACK_DAEMON_URL="http://127.0.0.1:17991"

external_work_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work list \
  --status ready \
  --limit 1 \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).externalWork[0].externalWork.id));')"

cat > "$tmpdir/live-comment.md" <<'EOF'
Ling Stack live smoke comment. This target was approved and executed explicitly.
EOF

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work actions propose-comment \
  --external-work "$external_work_id" \
  --body-file "$tmpdir/live-comment.md" \
  --approval standard

action_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work actions list \
  --external-work "$external_work_id" \
  --status waiting_for_approval \
  --limit 1 \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).actions[0].action.id));')"

approval_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work actions show "$action_id" \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).action.approval.id));')"
```

Approve and execute as two separate steps:

```bash
node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" approvals approve "$approval_id" \
  --reason "Approved controlled live smoke"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work actions execute "$action_id" \
  --workflow-path WORKFLOW.md
```

Then verify:

- The GitHub comment or labels appeared on the selected test PR/issue.
- `external-work actions show "$action_id"` reports `succeeded`.
- Execution artifacts include the redacted request/response evidence.
- If the PR head SHA or issue state changed before execution, the action reports
  `stale_target` and no mutation is posted.

## Failure triage

- `workflow path escapes channel bound path`: keep `WORKFLOW.md` inside the channel
  bound path.
- `github token is required` or permission errors: restart the daemon with
  `GITHUB_TOKEN` in the daemon environment and use a token with repository access.
- `No ready external work was created`: select a repository with an open PR or issue.
- `stale_target`: re-poll the subject and create a fresh proposal for the current
  source state.
- `runs list` is not empty after read-only smoke: treat as a regression; poll/import and
  local proposal paths must not start the runner.
