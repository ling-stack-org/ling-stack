---
source:
  kind: github
  repository: tianxiaochannel-oss88/ling-stack
  events:
    - pull_request.opened
    - pull_request.synchronize
    - issue.opened
  secretRef: keychain:LING_STACK_GITHUB_TIANXIAOCHANNEL_OSS88_LING_STACK_TOKEN
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
