# Domestic Provider Templates

## Summary

Ling model workbench now exposes first-class templates for the mainstream domestic OpenAI-compatible chat providers that can be configured through the existing provider preset flow. This is a template/catalog improvement only: it does not add new daemon APIs, new persistence fields, or new vendor runtime adapters.

## Goals

- Keep the existing OpenAI-compatible custom relay path intact.
- Let users start from ready-made domestic provider templates instead of manually typing provider IDs, base URLs, and environment key refs.
- Avoid marking every domestic template as reasoning-capable. Thinking support remains model-specific and is inferred by upstream metadata first, then Ling catalog rules, then conservative fallback.
- Keep media runtime availability separate from model/provider discovery. A template being available does not mean image/video generation is live-runnable.

## Covered Templates

| Template | Provider ID | Default model | Base URL | API key ref |
| --- | --- | --- | --- | --- |
| Alibaba Bailian Qwen | `alibaba-bailian` | `qwen-plus` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `env:DASHSCOPE_API_KEY` |
| Moonshot Kimi | `moonshot` | `kimi-k2-0711-preview` | `https://api.moonshot.cn/v1` | `env:MOONSHOT_API_KEY` |
| Baidu Qianfan ERNIE | `baidu-qianfan` | `ernie-4.5-turbo-128k` | `https://qianfan.baidubce.com/v2` | `env:QIANFAN_API_KEY` |
| Tencent Hunyuan | `tencent-hunyuan` | `hunyuan-turbos-latest` | `https://api.hunyuan.cloud.tencent.com/v1` | `env:HUNYUAN_API_KEY` |
| SiliconFlow | `siliconflow` | `Qwen/Qwen3-235B-A22B` | `https://api.siliconflow.cn/v1` | `env:SILICONFLOW_API_KEY` |
| StepFun | `stepfun` | `step-2-mini` | `https://api.stepfun.com/v1` | `env:STEPFUN_API_KEY` |
| Baichuan AI | `baichuan` | `Baichuan4-Turbo` | `https://api.baichuan-ai.com/v1` | `env:BAICHUAN_API_KEY` |
| 01.AI Yi | `01ai` | `yi-lightning` | `https://api.lingyiwanwu.com/v1` | `env:YI_API_KEY` |

Existing domestic and media templates remain: Doubao Ark, DeepSeek, MiniMax, GLM Zhipu, Seedream Image, Jimeng Image, and Seedance Video.

## Non-goals

- No new `ProviderKind` values for these templates.
- No new media live adapters for the newly listed providers.
- No automatic migration or deletion of existing user provider presets.
- No claim that a default template model is the user's best or latest model choice; users can fetch and import the exact models exposed by their account.

## Module Boundaries

- Core owns bundled template definitions and their fixed defaults.
- Web owns template grouping and localized display text.
- Mock daemon mirrors the bundled template list for e2e coverage.
- Provider model capability inference remains in the existing catalog/enrichment path.

## Source Notes

The OpenAI-compatible endpoints were checked against public provider documentation or unauthenticated endpoint behavior on 2026-06-30. Reference pages:

- Alibaba Bailian: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- Moonshot Kimi: https://platform.moonshot.cn/docs/guide/start-using-kimi-api
- SiliconFlow: https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions
- StepFun: https://platform.stepfun.com/docs/zh/api-reference/chat/chat-completion-create
- 01.AI Yi: https://platform.lingyiwanwu.com/docs
- Baichuan AI: https://platform.baichuan-ai.com/docs/api
