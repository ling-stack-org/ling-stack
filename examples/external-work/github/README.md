# GitHub External Work Example

This example covers the read-only Phase 1/2 smoke path. It imports local GitHub PR or
issue fixtures into Ling Stack workflow records, and it can run one manual GitHub
read-only poll/reconcile cycle. It does not start a runner and does not mutate GitHub.

## Files

- `WORKFLOW.md`: minimal repository workflow contract.
- `pull-request-opened.json`: GitHub `pull_request.opened` fixture.
- `issue-opened.json`: GitHub `issue.opened` fixture.

## Smoke

From the repository root:

```bash
corepack pnpm build

export LING_STACK_DAEMON_URL="http://127.0.0.1:17991"
export GITHUB_TOKEN="$(gh auth token)" # Or set any GitHub token with read access.

tmpdir="$(mktemp -d)"
cp examples/external-work/github/WORKFLOW.md "$tmpdir/WORKFLOW.md"
echo "$tmpdir"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" init --no-provider-templates
GITHUB_TOKEN="$GITHUB_TOKEN" node packages/cli/dist/index.js --cwd "$tmpdir" daemon start --foreground --host 127.0.0.1 --port 17991
```

The explicit port keeps this smoke isolated from any daemon already listening on the
default `17891` port. The example `WORKFLOW.md` uses `source.secretRef:
env:GITHUB_TOKEN`; fixture import does not need the token, but live poll/reconcile does.

In another terminal, set `tmpdir` and `LING_STACK_DAEMON_URL` to the values from the
first terminal:

```bash
tmpdir="/path/printed/by/the/first/terminal"
export LING_STACK_DAEMON_URL="http://127.0.0.1:17991"

channel_json="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json channel create --name GitHub --path "$tmpdir")"
channel_id="$(node -e 'const input = JSON.parse(process.argv[1]); console.log(input.channel.id)' "$channel_json")"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work github import \
  --channel "$channel_id" \
  --event-type pull_request.opened \
  --payload-file examples/external-work/github/pull-request-opened.json \
  --workflow-path WORKFLOW.md
```

For machine-readable output and artifact ids:

```bash
node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work github import \
  --channel "$channel_id" \
  --event-type issue.opened \
  --payload-file examples/external-work/github/issue-opened.json \
  --workflow-path WORKFLOW.md
```

Use the returned artifact id with the existing artifact endpoint:

```bash
curl --get "$LING_STACK_DAEMON_URL/artifacts/<artifact_id>/content" \
  --data-urlencode "cwd=$tmpdir"
```

For Phase 2 manual polling:

```bash
node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work github poll \
  --channel "$channel_id" \
  --workflow-path WORKFLOW.md \
  --limit 1

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work github poll \
  --channel "$channel_id" \
  --workflow-path WORKFLOW.md \
  --limit 1

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work list \
  --channel "$channel_id" \
  --status ready

external_work_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work list \
  --channel "$channel_id" \
  --status ready \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).externalWork[0].externalWork.id));')"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work show "$external_work_id"

cat > "$tmpdir/proposed-comment.md" <<'EOF'
Local smoke proposal only. This creates a Ling approval-gated action record and does not post to GitHub.
EOF

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work actions propose-comment \
  --external-work "$external_work_id" \
  --body-file "$tmpdir/proposed-comment.md" \
  --approval standard

action_id="$(node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json external-work actions list \
  --external-work "$external_work_id" \
  --status waiting_for_approval \
  | node -e 'let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => console.log(JSON.parse(input).actions[0].action.id));')"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work actions show "$action_id"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work actions cancel "$action_id" \
  --reason "Smoke path cleanup"

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" external-work reconcile \
  --channel "$channel_id" \
  --workflow-path WORKFLOW.md

node packages/cli/dist/index.js --cwd "$tmpdir" --daemon-url "$LING_STACK_DAEMON_URL" --json runs list
```

The second poll should return `Duplicates: 1`, and `runs list` should stay empty
because external work polling never starts a runner.

The action proposal commands create local `external_work_actions`, approval, and artifact
records only. They do not call GitHub mutation APIs.

`--execute-hooks` is optional on poll. When enabled, only `afterCreate` and `beforeRun`
run inside `.ling-stack/external-workspaces/github/...` with local evidence artifacts.
