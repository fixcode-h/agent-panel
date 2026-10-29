---
paths: shared/clis.ts, shared/clis/**, shared/cli-spec.ts, shared/settings.ts, shared/accounts.ts, shared/model-catalog*, shared/model-limits.ts, server/models.ts, server/accounts.ts, server/api-*.ts, server/cli-*.ts, server/install.ts, docs/cli-config.md, docs/model-catalog.md, web/src/lib/cli-*.ts, web/src/components/settings/**
---

# CLI 定义、模型和思考强度

启动 CLI 进程、解析输出在 [cli-process.md](./cli-process.md)。

## CLI 才有的行为做成 CliSpec 字段，所有 CLI 按字段走

- 规则：某个 CLI 特有的东西（强度档位、强度是否跟着模型走、能否中途换强度、模型从哪读、账号怎么识别）写成定义里的字段（`shared/clis/*.json` 或 `shared/clis.ts`），代码只读字段，不按数值猜（usage 口径写 `inputExcludesCache`）；新字段同时登记进 `docs/cli-config.md`，并把已有的每个 CLI 过一遍。
- 起因：强度先只给 Command Code 写死档位（3ab9c74、bc33580 才改成跟着模型走），接 Pi 时又各补一遍 max 档和 reasoning（1456578、deacb24）。fc8a32f 猜 Pi 的缓存口径。
- 防线：`scripts/rules-check.mjs` 拦 `id === '<CLI 名>'` 这类分支；接新 CLI 走 `docs/cli-config.md` 的「接入检查清单」。

## 面板写回 CLI 自己的配置时，写全 CLI 判断能力要的字段

- 规则：写 models.json / providers.json 这类文件，按模型目录原样写强度、上下文、是否支持思考，不按面板的档位过滤；写完用 CLI 自己的列表命令核对能选几档。先读 CLI 文档里模型条目和设置的全部字段，别只补报错的那一个。
- 起因：Pi 的 models.json 没写 `reasoning: true`，下拉只剩一档（deacb24）；Command Code 写回 `reasoningEfforts` 被档位过滤掉几档（bc33580）；Pi 没写 `thinkingLevelMap`，xhigh 被当成不支持。
- 防线：`server/api-config.test.ts`。

## 按模型查能力统一走 apiModelInfo

- 规则：按模型查强度、上下文的地方都用 `apiModelInfo`（先换成 API 映射到的模型、带上 API 的协议），按模型记的表用 `apiModelKey` 去掉 provider 前缀再查。
- 起因：bda5817 映射后强度算错；执行前夹强度、设置页下拉没带协议，带前缀的模型查不到映射。
- 防线：`server/api-protocol.test.ts`。

## 账号模式要把 API 模型映射为账号模型

- 规则：CLI 从 API 模式切回账号模式时，去掉 API provider 前缀和协议后缀，只把账号支持的模型 ID 交给 CLI；两个模式的模型下拉也分别取各自来源。
- 起因：Command Code 账号模式保留 `tokenapi/...-responses` 会先报未登录、登录后又报 `unknown model`。
- 补充：模型列表按「CLI + 登录方式 + 选的 API」分开缓存（`server/models.ts`、`web/src/lib/cli-models.ts`），切换后不等保存就换列表；账号方式去掉 CLI 自己接的接口（BYOK 组、带 API 前缀的模型）。
- 防线：`server/settings-auth.test.ts`；`scripts/e2e.mjs`「账号和 API」里查两种方式的列表。

## 「没选模型」也要显式传模型，不能把空值交给 CLI

- 规则：解析出的模型为空时不能原样传给 CLI（不带 `--model` 会退回 CLI 内置默认，第三方网关不认）；API 模式下空模型取 API 的第一个，和界面标「默认」的同一个。界面显示的默认和执行时的默认必须是同一处算出来的。
- 起因：模型设计对话 `model: ''`，启动不带 `--model`，Claude Code 用 claude-opus-5-5 打到 deepseek 网关报错（见 `docs/modules/shared/bugs/api-empty-model-no-model-flag.md`）。
- 防线：`server/api-config.test.ts`。
