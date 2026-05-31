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

tmpdir="$(mktemp -d)"
cp examples/external-work/github/WORKFLOW.md "$tmpdir/WORKFLOW.md"
echo "$tmpdir"

node packages/cli/dist/index.js --cwd "$tmpdir" init --no-provider-templates
node packages/cli/dist/index.js daemon start --foreground
```

In another terminal, set `tmpdir` to the path printed above:

```bash
tmpdir="/path/printed/by/the/first/terminal"
channel_json="$(node packages/cli/dist/index.js --cwd "$tmpdir" --json channel create --name GitHub --path "$tmpdir")"
channel_id="$(node -e 'const input = JSON.parse(process.argv[1]); console.log(input.channel.id)' "$channel_json")"

node packages/cli/dist/index.js --cwd "$tmpdir" external-work github import \
  --channel "$channel_id" \
  --event-type pull_request.opened \
  --payload-file examples/external-work/github/pull-request-opened.json \
  --workflow-path WORKFLOW.md
```

For machine-readable output and artifact ids:

```bash
node packages/cli/dist/index.js --cwd "$tmpdir" --json external-work github import \
  --channel "$channel_id" \
  --event-type issue.opened \
  --payload-file examples/external-work/github/issue-opened.json \
  --workflow-path WORKFLOW.md
```

Use the returned artifact id with the existing artifact endpoint:

```bash
curl "http://127.0.0.1:17891/artifacts/<artifact_id>/content?cwd=$tmpdir"
```

For Phase 2 manual polling, configure `source.secretRef` in `WORKFLOW.md` if you want
authenticated GitHub reads, then run:

```bash
node packages/cli/dist/index.js --cwd "$tmpdir" external-work github poll \
  --channel "$channel_id" \
  --workflow-path WORKFLOW.md \
  --limit 50

node packages/cli/dist/index.js --cwd "$tmpdir" external-work reconcile \
  --channel "$channel_id" \
  --workflow-path WORKFLOW.md
```

`--execute-hooks` is optional on poll. When enabled, only `afterCreate` and `beforeRun`
run inside `.ling-stack/external-workspaces/github/...` with local evidence artifacts.
