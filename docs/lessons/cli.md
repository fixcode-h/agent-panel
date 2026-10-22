---
paths: shared/clis.ts, shared/clis/**, shared/cli-spec.ts, shared/settings.ts, shared/accounts.ts, shared/model-catalog*, shared/model-limits.ts, server/exec/**, server/models.ts, server/accounts.ts, server/cli-*.ts, server/install.ts, server/merge-build.ts, server/background.ts, scripts/fake-cli/**, docs/cli-config.md, docs/model-catalog.md, web/src/lib/cli-*.ts, web/src/components/settings/**
---

# CLI 定义、模型和思考强度

## CLI 才有的行为做成 CliSpec 字段，所有 CLI 按字段走

- 规则：某个 CLI 特有的东西（强度档位、强度是否跟着模型走、会话能否中途换强度、模型从哪读、账号怎么识别）写成定义里的字段（`shared/clis/*.json` 或 `shared/clis.ts`），代码只读字段，不按数值猜（usage 口径写 `inputExcludesCache`）；新字段同时登记进 `docs/cli-config.md`，并把已有的每个 CLI 都过一遍要不要填。
- 起因：思考强度先只给 Command Code 写死了档位（3ab9c74、bc33580 才改成跟着模型走），后来接 Pi 又各补了一遍 max 档和 reasoning（1456578、deacb24）。fc8a32f 猜 Pi 的缓存口径。
- 防线：`scripts/rules-check.mjs` 拦 `id === '<CLI 名>'` 这类分支；接新 CLI 走 `docs/cli-config.md` 的「接入检查清单」。

## 面板写回 CLI 自己的配置时，写全 CLI 判断能力要的字段

- 规则：写 models.json / providers.json 这类文件，按模型目录原样写强度、上下文、是否支持思考，不按面板的档位过滤；写完用 CLI 自己的列表命令或界面核对能选几档。
- 起因：Pi 的 models.json 没写 `reasoning: true`，下拉只剩一档（deacb24）；Command Code 写回 `reasoningEfforts` 时被档位过滤掉了几档（bc33580）；Pi 只写了 `reasoning` 没写 `thinkingLevelMap`，xhigh 被当成不支持，按模型配的默认强度也没写进 `modelThinkingLevels`（用户指出「一键更新不带思考强度」）。写之前先读 CLI 文档里模型条目和设置的全部字段，别只补报错的那一个。
- 防线：`server/api-config.test.ts`。

## 按模型查能力统一走 apiModelInfo

- 规则：按模型查强度、上下文的地方都用 `apiModelInfo`（先换成 API 映射到的模型、带上 API 的协议），按模型记的表用 `apiModelKey` 去掉 provider 前缀再查。
- 起因：bda5817 映射后强度算错；执行前夹强度、设置页下拉没带协议，带前缀的模型查不到映射。
- 防线：`server/api-protocol.test.ts`。

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

## 账号模式要把 API 模型映射为账号模型

- 规则：CLI 从 API 模式切回账号模式时，去掉 API provider 前缀和协议后缀，只把账号实际支持的模型 ID 交给 CLI；两个模式的模型下拉也要分别取各自来源。
- 起因：Command Code 账号模式保留 `tokenapi/...-responses` 会先报未登录，登录后又报 `unknown model`；用户明确要求账号模式自动映射。
- 补充：模型列表按「CLI + 登录方式 + 选的 API」分开缓存（`server/models.ts`、`web/src/lib/cli-models.ts`），切换后不等保存就换列表；账号方式去掉 CLI 自己接的接口（BYOK 组、带 API 前缀的模型），下拉用 `accountModelId`。起因：Command Code 切到账号后下拉还是 `tokenapi/...`（用户指出）。
- 防线：`server/settings-auth.test.ts`；`scripts/e2e.mjs`「账号和 API」里查两种方式的列表。

## 整行命令交给 shell 走 shellCommand，Windows 上不让 Node 转义

- 规则：用户或 Agent 写的一整行命令（后台命令、测试步骤）用 `server/merge-build.ts` 的 `shellCommand` / `runShell` 启动。Windows 上要整行加引号、`windowsVerbatimArguments` 原样交给 `cmd.exe /d /s /c`；按普通参数传给 cmd.exe 时 Node 会把 `"` 转成 `\"`，cmd 不认，程序收到的参数多了引号。
- 起因：15c1a1d 的后台命令在 Windows 上跑 `node -e "setTimeout(...)"`，代码变成字符串字面量，0 秒就报成功，Agent 以为面板判断错了。
- 防线：`server/merge-build.test.ts`（shellCommand 的 Windows 形式、定时器真的等到点）。

## 按工具名猜类型之前，先认出面板自己的工具

- 规则：`genericTool` 这类按名字正则猜 kind 的解析，先查 `shared/panel-tools.ts` 的面板工具表再猜；新加面板工具时同时登记进这张表。面板工具在对话里按「做了什么」显示，不能被当成 CLI 自己的读文件、子 Agent。
- 起因：Pi 的桥接扩展（b0a47d2）按裸名字注册面板工具，`wait_agents` 因为名字里有 agent 被当成 CLI 自己的子 Agent，对话里显示成没头没尾的「子任务」，用户以为又开了一个子 Agent。
- 防线：`server/exec/parsers.test.ts`（Pi 面板工具是裸名字）。
