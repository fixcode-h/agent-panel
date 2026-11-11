# 回复里单个 ~ 写的范围被渲染成删除线

- 状态：已修复（`npx tsx --test web/src/lib/workflow-doc.test.ts` 通过）
- 症状：Agent 回复「X 102400~153600、Y 0~51200」，两个 ~ 之间的「153600、Y 0」被划掉
- 入口：`web/src/lib/workflow-doc.ts` 的 marked 配置（所有 Markdown 渲染都经 `renderDoc`）
- 根因类型：第三方库默认行为（marked 的 GFM 删除线默认认单个 ~）
- 关键词：删除线、波浪号、~、~~、strikethrough、del、范围、marked、GFM

## 根因

marked 18 开了 `gfm: true` 后，删除线的左右定界符正则是 `~~?`，单个 `~` 也成对算删除线（和 remark-gfm 的 `singleTilde` 默认开一样）。中文回复里常用 `~` 表示范围，一句话里出现两个就被当成一对。

## 修复

`workflow-doc.ts` 用 `marked.use({ tokenizer: { del } })` 包一层：以 `~~` 开头才交回默认规则（返回 `false`），单个 `~` 开头返回 `undefined`，不再当删除线，按普通文字输出。项目里只有这一个 marked 实例，对话回复、诊断报告、工作流文档、Markdown 文件预览都走它。

## 防线

`web/src/lib/workflow-doc.test.ts`「单个波浪号表示范围，不渲染成删除线；双波浪号才是删除线」。
