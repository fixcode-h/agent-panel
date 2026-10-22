---
paths: shared/clis.ts, shared/clis/**, shared/cli-spec.ts, shared/settings.ts, shared/accounts.ts, shared/model-catalog*, shared/model-limits.ts, server/exec/**, server/models.ts, server/accounts.ts, server/cli-*.ts, server/install.ts, scripts/fake-cli/**, docs/cli-config.md, docs/model-catalog.md, web/src/lib/cli-*.ts, web/src/components/settings/**
---

# CLI 定义、模型和思考强度

## CLI 才有的行为做成 CliSpec 字段，所有 CLI 按字段走

- 规则：某个 CLI 特有的东西（强度档位、强度是否跟着模型走、会话能否中途换强度、模型从哪读、账号怎么识别）写成定义里的字段（`shared/clis/*.json` 或 `shared/clis.ts`），代码只读字段；新字段同时登记进 `docs/cli-config.md`，并把已有的每个 CLI 都过一遍要不要填。
- 起因：思考强度先只给 Command Code 写死了档位（3ab9c74、bc33580 才改成跟着模型走），后来接 Pi 又各补了一遍 max 档和 reasoning（1456578、deacb24）。
- 防线：`scripts/rules-check.mjs` 拦 `id === '<CLI 名>'` 这类分支；接新 CLI 走 `docs/cli-config.md` 的「接入检查清单」。

## 面板写回 CLI 自己的配置时，写全 CLI 判断能力要的字段

- 规则：写 models.json / providers.json 这类文件，按模型目录原样写强度、上下文、是否支持思考，不按面板的档位过滤；写完用 CLI 自己的列表命令或界面核对能选几档。
- 起因：Pi 的 models.json 没写 `reasoning: true`，下拉只剩一档（deacb24）；Command Code 写回 `reasoningEfforts` 时被档位过滤掉了几档（bc33580）。
- 防线：`server/api-config.test.ts`。

## 按模型查能力前先解析 API 映射

- 规则：凡是按模型查强度、上下文、协议的地方，先换成 API 配置里映射到的模型，再查目录。
- 起因：bda5817，设了映射后强度选项、运行时校验和写回都按原模型算错。
- 防线：人工。

## CLI 升级先看变更，再重录样本

- 规则：适配新版本前先读它的 changelog，重点看权限、信任、扩展加载方式；输出格式变了就重录 `server/exec/fixtures/` 并跑 `npm run test:unit`。
- 起因：Pi 1.3 引入「项目信任」，RPC 模式下 `.pi/extensions` 静默不加载，面板注入的工具全部失效（1456578）。
- 防线：`npm run test:unit`（只覆盖输出解析）。

## Agent 的错误一律显示，不悄悄重试

- 规则：断流、退出码异常先把完整错误显示在节点上，再按规则续接（最多 2 次）；不吞错误、不静默重试。用户明确要求过。
- 防线：人工。

## 用户的补充只交给对话自己的调用

- 规则：执行中的补充（插话、`read_user_notes`、等下一句）在对话里只交给对话自己那次调用（step 为空），不交给它派出的子任务；新加一种「同一个任务里还在跑的调用」时，检查 `steerTask` 会不会把用户消息送过去。对话停下等子任务时也要能收消息（`helperGate`）。
- 起因：49d7d7e 加子任务后，等子任务时用户发的消息被插话给了子任务、记在子任务名下，对话里看不到。
- 防线：`server/orchestrator.test.ts`（等子任务时发消息）。
