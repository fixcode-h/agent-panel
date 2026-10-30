# Claude Code 接第三方网关时会话栏的上下文一直是 0

- 状态：已修复（`server/exec/parsers.test.ts` 通过）
- 症状：会话栏「上下文」一直显示 `0 / 1.00M`、已使用 0.0%，消息 0；这一轮的输入 token 却有几十万
- 入口：`server/exec/parsers.ts` 的 `claudeParser`（`message_start` / `message_delta`）
- 根因类型：用量只取回应开头报的输入，网关在结尾才报
- 模块：`server-exec`（`server/exec/parsers.ts`）
- 关键词：上下文、0、context、usage、message_start、message_delta、DeepSeek、网关、会话栏

## 现象

Claude Code + `deepseek-v4.1-flash`（兼容 Anthropic 的网关）：会话栏上下文一直是 0，Claude Code 报的细分里消息也是 0。

## 根因

面板的上下文取每次模型回应开头 `message_start` 里的 `usage.input_tokens`（含缓存）。这类网关开头报 0、结尾的 `message_delta` 才报真实输入；解析器把开头的 0 当成上下文，每次回应开头都改回 0，结尾报的又只取了输出。Claude Code 自己的细分（`get_context_usage`）也按 API 报的用量算，同样是 0。

## 修复

- `message_start` 报的输入是 0 时不当上下文。
- `message_delta` 带的输入比开头报的多时补上差额，并按它报上下文。

## 防线

- `server/exec/parsers.test.ts`：「Claude Code：出错的结果、Bash 的退出码；……」里的「开头报 0、结尾 message_delta 才报真实输入」。
