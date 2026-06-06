---
source:
  kind: github
  repository: owner/repo
  events:
    - pull_request.opened
    - pull_request.synchronize
    - issue.opened
  secretRef: env:GITHUB_TOKEN
scheduler:
  reconcileOnStartup: false
agent:
  teammateId: engineer
---

Review {{ item.kind }} {{ item.identifier }}.

Title: {{ item.title }}
State: {{ item.state }}

Summarize the requested work, identify required code, test, and docs changes, and propose a safe implementation plan.
Do not perform external mutations unless a separate approval-gated action is explicitly requested.
