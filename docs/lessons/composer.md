---
paths: web/src/components/chat/**, web/src/components/tasks/TaskComposer.tsx, web/src/components/tasks/ChatModelPicker.tsx, web/src/lib/fileDrag.ts, scripts/ui/01-composer.mjs
---

# 对话输入框

## 输入框不能被外面重渲染重画或重挂载

- 规则：`RichInput` 整棵重画只在文字真变了时做（上传完成只换 `img`，组合输入期间跳过、结束后补）；卡片操作点击时重新取 `actions()`，别闭包捕获旧 `files`。
- 规则：输入框用 `draftKey` 自管草稿，打字只重渲染输入框；消息列表按 `memo` 比，`slot` 的签名 `slotKey` 要含全部输入；`Intl` 实例复用。
- 起因：用户反馈实时输出时打字卡、输入框失焦；实测 `Intl` 每次新建占 109ms/3s，`slot` 的 memo 从未命中。
- 防线：`scripts/ui-check.mjs`（推送期间输入框不重挂载、不丢焦点；行内图片卡片上传后还能删除）。

## 对话页的 Agent、模型、强度留在输入框左下角

- 规则：对话页的输入框和新建对话时一样：Agent · 模型 · 强度用 `ChatModelPicker` 放在输入框工具条左边；用角色的对话在同位置只读显示 `RoleModelBadge`，不挪到标题栏。
- 起因：dc23450 照设计稿把 Chat 页的「Agent · 模型」移到标题栏右侧、输入框只留强度，项目对话收成右侧的模型按钮；用户 2026-10-29 要求对话页保持新建时的输入框。
- 防线：`scripts/ui/01-composer.mjs` 的 Chat 页用例（标题栏里不能有「对话用的 Agent」）。

## 文件拖进输入框用左键长按，右键留给菜单

- 规则：文件拖进输入框用左键长按（`fileDrag.ts` 的 `longPressed`，约 300ms），右键留给菜单；拖完压掉补发的 click。
- 起因：拖引用原为右键按住拖动，用户要求改成长按。
- 防线：`scripts/ui-check.mjs` 的「任务-长按拖入引用」（`scripts/ui/02-task.mjs`）。
