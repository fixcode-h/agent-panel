# Claude Code 映射到 1M 上下文的模型，会话栏仍按 200K 算

- 状态：已修复（`server/model-limits.test.ts` 通过）
- 症状：API 里模型自动识别 / 映射成 1M 上下文的模型（如 claude-sonnet-4-6），会话栏「上下文」仍显示 `/ 200.0k`，Claude Code 按 200K 提前压缩
- 入口：`server/exec/runner.ts` 交给 CLI 的模型名（`longContextModel`）、`shared/clis/claude.json` 的 `features.longContext`
- 根因类型：CLI 只认模型名后缀定窗口，面板传的环境变量对它认得出的模型不生效
- 模块：`server-exec`（`server/exec/runner.ts`）
- 关键词：上下文、1M、200K、[1m]、CLAUDE_CODE_MAX_CONTEXT_TOKENS、映射、会话栏、压缩

## 现象

Claude Code 走 API，模型名是 Claude 自家的（claude-sonnet-4-6），API 设置里自动识别到 1M 窗口；会话栏的窗口一直是 200K，用到 70% 左右就压缩。

## 根因

面板把这一轮的上下文窗口用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 传给 Claude Code。2.1.317 的实现里这个变量只对它认不出的模型名（网关的自定义模型 id）生效；认得出的自家模型按模型名定窗口，要 1M 得在模型名后面加 `[1m]`（它自己的提示也这么说），不加就按 200K，并在结果的 `modelUsage.contextWindow` 里报 200K，面板以 CLI 报的为准。

## 修复

- CLI 定义加 `features.longContext`（Claude Code：`[1m]`、1M 起）：API 方式下这一轮的窗口（手动设的，或按映射 / 模型目录自动算的）到 1M 时，交给 CLI 的模型名加上后缀。账号方式不加：账号的模型窗口 CLI 自己知道，有的套餐用不了 1M。
- CLI 报回来的模型名去掉后缀再记，显示和按模型查映射、目录不受影响。

## 防线

- `server/model-limits.test.ts`：「Claude Code 的长上下文靠模型名后缀开」。
