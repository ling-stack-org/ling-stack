---
source:
  kind: github
  repository: openclaw/openclaw
  events:
    - pull_request.opened
    - pull_request.synchronize
    - issue.opened
agent:
  teammateId: engineer
actions:
  defaultExternalMutationApproval: strict
---

You are importing read-only GitHub work into Ling Stack.

External item: {{ item.kind }} {{ item.identifier }}
Title: {{ item.title }}
State: {{ item.state }}
Labels: {{ item.labels }}
URL: {{ item.url }}

Summarize the requested work, list the local evidence you would gather first, and do
not post comments, add labels, push commits, request reviews, merge, or close external
work unless Ling creates and approves a separate external action.
