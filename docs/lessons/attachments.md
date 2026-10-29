---
paths: server/attachments.ts, server/uploads.ts, shared/composer.ts, server/exec/git.ts, web/src/components/chat/AttachmentView.tsx, web/src/components/chat/Attachments.tsx
---

# 附件

## 附件落盘：图片进对话目录根，其它只引用原路径

- 规则：`server/attachments.ts` 的 `placeAttachments()` 只把图片（用 `shared/composer.ts` 的 `attachChip` 判）拷进任务执行目录（对话目录）根；重名加序号且不覆盖已有文件，同一源文件再次放置沿用任务上记的那份。其它类型不拷、原样返回绝对路径；`ref` / `quote` 不拷；超过 `MAX_ATTACHMENT_BYTES` 的图片也不拷。放行目录统一用 `attachmentAddDirs()` 算。
- 面板拷进去的图片不算 Agent 的改动：文件名记在 `Task.placedAttachments`（源文件绝对路径 → 对话目录文件名），`server/exec/git.ts` 的四个 git 函数按名单排除；不按文件名猜。旧任务没有映射时 `placedFiles()` 按消息里的 `attachments/名字` 补上。`task.messages[].attachments` 存用户上传时的绝对路径（气泡、看大图、导出按它读），`placed` 只用在提示词里；`/uploads/raw` 认 `attachments/名字` 只兜旧数据。
- 起因：6f60814 把附件拷进任务目录后，`deliver()` 的 stale 分支把 `placed` 记进对话导致破图；现在只有图片拷。2026-10 用户嫌 P4 项目里堆 `attachments/`：改成直接放对话目录根，排除按任务上记的名单。
- 防线：`server/attachments.test.ts`、`server/exec/git-ignore.test.ts`、`server/task-text.test.ts`、`scripts/e2e/05-workflow-edge.mjs` 的附件段；`scripts/rules-check.mjs` 拦 `attachments: placed`。
