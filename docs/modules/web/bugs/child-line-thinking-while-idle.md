# 子对话行显示「正在思考…」，实际已经空闲

- 状态：已修复（`web/src/components/tasks/child-line.test.ts` 新用例通过）
- 症状：父对话的子对话行写「计划 3/4 · 未完成 · 正在思考… · 等下一句」，子对话那时已经十几分钟没动
- 入口：`web/src/components/tasks/child-line.ts` 的 `activityText` / `childNote`
- 根因类型：兜底文案没看 `thinking` 字段
- 模块：`web`（`web/src/components/tasks/child-line.ts`）
- 关键词：子对话、正在思考、等下一句、空闲、状态矛盾、activity、childActivity

## 根因

一轮结束后服务端的 `childActivity` 只带计划进度（`{ plan }`，没有 `thinking`）。`activityText` 前面几项都不匹配时一律返回「正在思考…」，于是停在等下一句的子对话也写「正在思考…」。

## 修复

只有服务端给了 `thinking`（只在 `working` 时给）才写「正在思考…」，否则不写；行上剩「等下一句 · 计划那一步」。

## 防线

- `web/src/components/tasks/child-line.test.ts`：「一轮结束、停在等下一句的子对话不写『正在思考…』」。
