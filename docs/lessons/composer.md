---
paths: web/src/components/chat/**, web/src/components/tasks/ChatModelPicker.tsx, web/src/components/tasks/TaskComposer.tsx, web/src/components/tasks/TaskView.tsx
---

# 输入框：重画时机和 Agent 选择的位置

## 输入框不能被外面重渲染重画或重挂载

- 规则：`RichInput` 整棵重画（`paint` → `replaceChildren`）只在文字真变了时做：上传完成只换卡片里的 `img`（`updatePreviews`）；重画会擦掉组合中的字，组合期间跳过的等结束后补。卡片操作点击时重新取 `actions()`，别闭包捕获画卡片那刻的 `files`。
- 规则（重渲染）：输入框用 `draftKey` 自管草稿（`ChatComposer` 的 `useDraft`），打字只重渲染输入框；消息列表按 `memo` 比，`slot` 用签名 `slotKey` 比，签名要含 slot 的全部输入（如 `runningSig`，漏了会上下两段各列一遍子对话）；`Intl` 实例复用。
- 起因：用户反馈实时输出时打字卡、输入框失焦；实测 `Intl` 每次新建占 109ms/3s，`slot` 的 memo 从未命中。
- 防线：`scripts/ui-check.mjs`（推送期间输入框不重挂载、不丢焦点；行内图片卡片上传后还能删除）。

## 对话页的 Agent、模型、强度留在输入框左下角

- 规则：进了对话以后，输入框和新建对话那个保持一样：Agent · 模型 · 强度用 `ChatModelPicker` 放在输入框工具条左边（附件、提问开关后面）；用角色的对话在同一位置只读显示 `RoleModelBadge`。不挪到标题栏，也不收成输入框右侧的一个按钮。
- 起因：dc23450 照设计稿把 Chat 页的「Agent · 模型」移到标题栏右侧、输入框只留强度，项目对话收成右侧的模型按钮；用户 2026-10-29 要求对话页保持新建时的输入框。
- 防线：`scripts/ui/01-composer.mjs` 的 Chat 页用例（标题栏里不能有「对话用的 Agent」）。
