# Conversation Bottom Status Strip

Status: implementation contract
Date: 2026-10-28
Scope: Web channel, normal conversation, and teammate private chat composers

## Goal

One shared metric strip appears beneath the three composers. It is transparent, horizontally centered, and separated from the composer border by the existing approved gap. The selected model already appears elsewhere; the bottom strip does not repeat the model or identify the surface.

## Presentation

Three groups, in this order: an icon followed by AI rounds, tool steps, and output token speed; an icon followed by aggregate tokens and cache hit percentage; a circular context-use meter and percentage. Match the supplied reference screenshots for icons, order, copy, and compact formatting as closely as available theme tokens allow. Hover and click expose separate detail cards for token/cache breakdown and context usage. Keyboard users can focus and activate these details.

Numbers must come from real scoped runtime evidence. Never substitute screenshot examples or pretend that a model's context-window capacity is its occupied context. A missing or unsupported metric displays `—`; a zero is displayed only when the underlying measurement is known. Estimated context is explicitly identified as estimated; provider-measured context is explicitly identified as measured. If an individual run uses an execution adapter that does not emit usage evidence, its absence is visible rather than silently treated as zero.

## Aggregation and scope

- Normal conversation: the selected thread's visible, effective turns and their linked runs.
- Teammate direct: the selected direct thread's visible messages and their owner-checked linked runs.
- Channel: the current channel's visible conversation and linked runs; never mix runs from other channels.
- Count AI rounds from runtime turn starts when emitted; count tool steps from distinct runtime tool starts. These are not channel workflow-step counts or user-message counts.
- Aggregate measured token inputs, outputs, cache reads, and cache writes from provider usage events. Handle run continuations and separate compaction calls without duplicating an event. Cache hit numerator and denominator must follow the underlying provider SDK semantics; display a percentage only when they are comparable and measured.
- Show token throughput only when a measured output count and reliable interval belong to the same completed assistant response; the observable `turn_start → message_end` interval includes tools and is labeled end-to-end round throughput, not pure model-generation speed. Do not divide conversation lifetime by total tokens.
- Context usage uses the latest invocation's measured input and a known capacity where available. If only a projected-input estimate exists, expose it distinctly with its source and uncertainty; if neither exists, display `—`.

## Module seam

`ConversationComposerShell.bottomStatusNode` owns the already-approved placement. One reusable metric-presentation module owns display, formatting, meters, and accessible detail cards. A shared daemon read-model owns event pagination, scoping, aggregation, and coverage; the three surfaces consume scoped projections rather than independently reimplementing reducers or fetching unrelated runs.

Preserve existing model controls, guidance, approval gates, attachments, and feedback. Do not change the unrelated research document. Do not commit or push.
