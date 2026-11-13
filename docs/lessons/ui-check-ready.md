---
paths: scripts/ui/**, web/src/components/tasks/TaskComposer.tsx, web/src/lib/data.tsx
---

# 界面检查：等页面真的准备好再操作

界面检查的其他规则在 [ui-check.md](./ui-check.md)。

## 新建对话按回车之前等发送按钮可用

- 规则：在新建对话的输入框（`#task-prompt`）里按回车发出，统一用 harness 的 `sendNew(p, 名字)`：它先等发送按钮可用再按。CLI 列表是页面打开后另外异步读的（`web/src/lib/data.tsx` 先读 CLI 配置、再读 CLI 列表），读到之前没有可用的 CLI，发送按钮是灰的，这时按回车输入框什么都不做。输入框出现、`settle` 等完动画、`fill` 完文字都不代表能发了。
- 规则：不用固定的 `waitForTimeout(300)` 当「准备好了」：快机器上够，CI 的慢机器上不够。要等界面上真实的信号（按钮可用、CLI 选择出现）。测「上传 / 拷贝中也能发」这类用例不能等按钮（会一直等到拷贝完），改成一开始先等 CLI 选择出现，按回车那行写 `send-ready-ok: 原因`。
- 规则：某个分片在同一个 CI 任务里首跑、串行重跑都失败，换一台机器重跑又通过，先怀疑「机器慢就会输的竞速」，用 CDP 的 `Emulation.setCPUThrottlingRate` 把页面降速 8~12 倍在本地复现，别当成随机抖动反复重跑。
- 起因：`01-composer`「路径可点：发出后没有打开对话页」在 d4d7f18、5f10657 的 PR 检查和 main 出包时失败，本地一直通过；降速 12 倍时 3 次里 2 次复现，回车前发送按钮还是灰的，再按一次就能发。本次提交修掉。
- 防线：`scripts/rules-check.mjs` 第 14b 条（分片里直接 `#task-prompt').press('Enter')` 会被拦下）。
