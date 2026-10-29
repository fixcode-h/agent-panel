# API 模式下对话没选模型：启动不带 --model，Claude Code 退回 claude-opus-5-5，第三方网关报模型不存在

- 状态：已修复（`server/api-config.test.ts` 通过）
- 症状：新建的模型设计对话一回复就是「There's an issue with the selected model (claude-opus-5-5)」，回复头上却写着 deepseek-v4.1-flash；启动命令里没有 `--model`
- 入口：`shared/settings.ts` 的 `agentRun`（API 分支）、`shared/accounts.ts` 的 `modelForProtocol`、`shared/clis.ts` 的 Claude Code `buildArgs`
- 根因类型：两处「默认模型」口径不一致：界面把 API 的第一个模型标成默认，执行时空模型原样传空
- 模块：`shared`（`shared/settings.ts`）
- 关键词：API 模式、第三方网关、默认模型、--model、claude-opus-5-5、deepseek、模型设计、model 为空

## 现象

用户在 Claude Code 的 API 模式（接 deepseek 网关）下用「新建模型设计」开对话，回复是 Claude Code 的报错 `There's an issue with the selected model (claude-opus-5-5)`，点「继续」还是一样；回复头显示的模型是 `deepseek-v4.1-flash`。用户贴回的启动命令里没有 `--model`。

## 根因（证据链）

1. 启动命令没有 `--model`（用户贴回的命令）← `shared/clis.ts` 的 `buildArgs` 用 `opt(o.model, '--model', …)`，模型为空就不传。
2. 模型为空 ← 「新建模型设计」弹窗建对话时 `model: ''`；`agentRun`（`shared/settings.ts`）取 `a.model || cs.defaultModel` 仍为空，API 分支里 `modelForProtocol`（`shared/accounts.ts:43`）遇到空模型原样返回。
3. 不带 `--model` 时 Claude Code 用它内置的默认 `claude-opus-5-5`，第三方网关不认 → 报错。
4. 回复头显示 deepseek ← 界面的模型列表在 API 模式下把第一个 API 模型标成默认（`server/models.ts` 的 `apiModelsFor`，`isDefault: i === 0`），模型为空时署名取它。

输入框新建的对话不会遇到：它总是把下拉里选中的模型显式传给服务端。

## 修复

- `agentRun` 的 API 分支：没有模型时取 API 的第一个模型（和界面上标「默认」的同一个），再按协议和前缀换算；所有「没选模型」的入口（模型设计、AI 分析开的对话等）都会显式带上 `--model`。
- 防线：`server/api-config.test.ts`「API 方式：执行时只认 API 里配的模型…」里加了空模型的断言（修之前实测返回空串）。
