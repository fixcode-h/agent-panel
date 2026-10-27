# CLI 输出样本

解析测试（`npm run test:unit`）用的样本，每行一个 JSON，格式和对应 CLI 实际输出的一致：

- `claude-stream.jsonl`：`claude -p --output-format stream-json --verbose --include-partial-messages`
- `codex-app.jsonl`：`codex app-server` 发给面板的 JSON-RPC 消息（响应和通知）
- `commandcode.jsonl`：`cmdc -p --output-format json`
- `pi-json.jsonl`、`pi-error.jsonl`：`pi -p --mode json`（RPC 模式的会话事件和它同一套，结束改用 `agent_settled`）；`message_update` 里每次都带的整条消息 `partial` 去掉了，
  `pi-error.jsonl` 是接口连不上、自动重试三次的输出

CLI 升级后输出格式变了，就重新录一段真实输出替换这里的样本（路径换成 `/work/shop`，去掉密钥和个人信息），
再跑一次测试，看解析结果有没有变。
