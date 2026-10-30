# 回放录像

用户报的卡住、转圈类 Bug 的回归录像放这里，每个 Bug 一个 `.jsonl`（文件名带上 Bug id）。

- 生成：`node scripts/replay-from-export.mjs <对话包.task.json> scripts/e2e/fixtures/replay/<bug-id>.jsonl [--child <子对话 id>]`
- 回放：e2e 用例把录像路径写进 `<FAKE_CLI_LOG>.replay-src`，再起一轮 Claude Code 对话（见 `scripts/fake-cli/replay.mjs`、`scripts/e2e/03-chat.mjs`）
- 存进仓库前看一遍：导出包已经去过密钥，个人信息和本机路径仍要手动换掉（路径统一换成 `/work/...`）
