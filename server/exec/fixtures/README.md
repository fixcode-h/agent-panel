# CLI 输出样本

解析测试（`npm run test:unit`）用的样本，每行一个 JSON，格式和对应 CLI 实际输出的一致：

- `claude-stream.jsonl`：`claude -p --output-format stream-json --verbose --include-partial-messages`
- `codex-app.jsonl`：`codex app-server` 发给面板的 JSON-RPC 消息（响应和通知）
- `commandcode.jsonl`：`cmdc -p --output-format json`
- `pi-json.jsonl`、`pi-error.jsonl`：`pi -p --mode json`（RPC 模式的会话事件和它同一套，结束改用 `agent_settled`）；`message_update` 里每次都带的整条消息 `partial` 去掉了，
  `pi-error.jsonl` 是接口连不上、自动重试三次的输出

CLI 升级后输出格式变了，就重新录一段真实输出替换这里的样本（路径换成 `/work/shop`，去掉密钥和个人信息），
再跑一次测试，看解析结果有没有变。

这些样本也能在 e2e 里回放：把路径交给假 CLI 的回放模式（`FAKE_REPLAY`，或写进 `<FAKE_CLI_LOG>.replay-src`，见
`scripts/fake-cli/replay.mjs`），面板就按录下的事件顺序和间隔跑一轮。用户报的卡住、转圈类 Bug，可以把那段对话导出，
用 `node scripts/replay-from-export.mjs <对话包.task.json> <录像.jsonl>` 转成录像，存进 `scripts/e2e/fixtures/replay/` 做回归用例。
