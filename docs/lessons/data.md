---
paths: shared/schema.ts, shared/task.ts, shared/data.ts, server/store.ts, server/*store*.ts, server/settings.ts, server/tasks.ts, server/update*.ts, server/exec/worktree.ts, web/src/components/tasks/Worktrees.tsx, scripts/package.mjs, web/src/lib/demo-backend.ts, web/src/lib/api.ts, server/attachments.ts, server/uploads.ts, web/src/components/chat/AttachmentView.tsx, web/src/components/chat/Attachments.tsx, web/src/components/projects/ProjectSettingsDialog.tsx
---

# 数据结构、存储、升级兼容和出包

## 新字段要让旧数据保持旧行为

- 规则：给 schema 加字段时想清楚旧数据读进来是什么默认值，必要时按「新字段出现之前的数据当作已经……」处理，并加读旧数据的测试。迁移要幂等。
- 起因：840b871，加 `turnSeenAt` 后升级用户的旧会话全部亮成未读。
- 防线：`server/task-store.test.ts` 这类读旧数据的用例。

## 持久化设置项的默认值变更要迁移旧默认值

- 规则：改 `Settings` 里已有字段的默认值时，在读取设置的地方（`server/settings.ts` 的 `getSettings`）把「正好等于旧默认值」的存量值改成新默认值并写回，用户显式设过其他值的不动；不迁移的话老用户升级后拿不到新默认值。同时删干净旧字段在 schema、接口和界面里的读写，旧数据靠 zod 剥离未知字段兼容，并补一条读旧文件的迁移测试。
- 起因：2026-10-24 后台命令并发默认值 16 改 64，`backgroundLimit` 不做迁移时老设置里的 16 会一直被当成新默认值；同一次改动去掉的 `childConcurrency`、`childLimit` 也要能被旧文件读到而不报错。
- 防线：`server/settings-migrate.test.ts`。

## 加字段时配套改动一次提交全

- 规则：一个字段通常要同时改 `shared/schema.ts`、任务快照（`shared/task.ts`）、接口（`server/`、`web/src/lib/api.ts`）、演示后端（`web/src/lib/demo-backend.ts`）和英文词典。提交前 `git status` 确认新文件都 add 了。
- 起因：834da58、22d2481，漏提交模块导致 typecheck 和构建失败；434c940，插入的内容落在对象闭合括号之后。
- 防线：`npm run typecheck`、`npm run build`、`npx vite build --mode demo`。

## 状态字段是记录不是事实，判据按实际情况算

- 规则：`task.worktree.state` 只记面板自己走过的动作（合并、丢弃），分支被手动删掉或 `submit_build` 合完清掉后它可能还停在 `active`。判「合没合回原分支」在 `worktreeStatus()` 里按 `ahead`/`dirty` 算（分支已经不存在时按 `state` 兜底），`merged`、合并按钮和界面上的数字都从这一个判据出来，不要一处看 `state`、一处看数字。
- 起因：分支已经通过 `submit_build` 合进原分支、分支也删了，`state` 还是 `active`，`ahead`/`dirty` 都是 0 却算出 `merged: false`，界面显示「未合并到「…」：」后面空着，还挂着没用的合并按钮。
- 防线：`server/exec/worktree.test.ts` 的「分支已经删掉时」用例。

## 正式包里不能有演示内容

- 规则：模拟执行只在 `--mode demo` 里存在；正式代码不 import `demo-*`。
- 防线：`scripts/package.mjs` 会检查。

## 附件有两个路径：对话里存上传目录的绝对路径，拷进任务目录的那份只给 Agent

- 规则：`placeAttachments()` 拷进任务执行目录后给的是相对路径 `attachments/名字`，这份只用在交给 CLI 的提示词和 `deliver()` 的 `placed` 参数里。写进 `task.messages[].attachments` 的必须是用户上传时那份绝对路径（数据目录的 `uploads/…`）：气泡缩略图、看大图、导出、复制路径都按它读。`followUp()`、`deliver()`、`deliverWait()` 和 runner 里的 waiter 传参时两者不能混用——`deliverWait(task, msg, placed)` 里的 `msg` 只用来记对话。读取侧 `/uploads/raw` 认 `attachments/名字` 是按文件名回上传目录找（只认一级文件名），那是兜旧数据，不是新数据可以存相对路径的理由。
- 起因：6f60814 把附件改成拷进对话目录后，`deliver()` 的 `stale` 分支把 `placed` 当成用户原来的附件传给 `followUp()` 记进对话，消息里存成 `attachments/截图-071747.png`，而 raw 接口只认绝对路径 → 气泡和看大图的浮层都是破图。
- 防线：`scripts/e2e.mjs` 的保活用例断言记进对话的是 `dataDir/uploads` 下的绝对路径；`server/uploads-raw.test.ts` 覆盖相对路径兜底和越界拒绝；`scripts/rules-check.mjs` 拦 `attachments: placed`。

## 清掉任务上的字段写 undefined，不用 delete

- 规则：要清掉 Task 上的可选字段（`wrapRequest`、`rewind` 这类）时写 `x.field = undefined`，不要 `delete x.field`：`store.update` 是把传入的字段盖到旧记录上（`{ ...old, ...input }`），删掉的键盖不掉旧值，落盘后还是原样。由 `scripts/rules-check.mjs` 拦（确实不是 Task 的对象在行尾写 `delete-ok: 原因`）。
- 起因：2026-10-24 用户导出的对话里 7 个已完成的子对话都挂着 `wrapRequest: merging`；叫醒后 submit_merge 一直被拒「父对话正在合并你的分支」（真实 Pi 复现）。
- 防线：`scripts/real-cli/pi-handoff.mjs` 的「叫醒后再请求收尾」；规则检查第 6 条。

## 弹窗外的 AI 会话记住结果该存到哪个对象

- 规则：关掉弹窗还在跑的 AI 会话（项目设置的 `AiSession`）要记下途中建好的对象（`projectId`），应用时打开那个对象；没保存的新建草稿暂存在弹窗外壳。不能靠重开空白的新建弹窗来应用，保存时会多建一个同名项目。
- 起因：新建项目时 AI 初始化 → 关掉设置 → 点「查看推荐并应用」，多出同名项目、目录也丢了（0e1df58 修复）。
- 防线：`scripts/ui/07-projects.mjs` 的「先创建再应用」「关掉设置再应用」。
