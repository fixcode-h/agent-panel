---
paths: shared/schema.ts, shared/task.ts, shared/data.ts, shared/settings.ts, server/store.ts, server/*store*.ts, server/settings*.ts, server/tasks/**, server/update*.ts, scripts/package.mjs, web/src/lib/demo-backend.ts, web/src/lib/api.ts
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

## 正式包里不能有演示内容

- 规则：模拟执行只在 `--mode demo` 里存在；正式代码不 import `demo-*`。
- 防线：`scripts/package.mjs` 会检查。

## 清掉任务上的字段写 undefined，不用 delete

- 规则：要清掉 Task 上的可选字段（`wrapRequest`、`rewind` 这类）时写 `x.field = undefined`，不要 `delete x.field`：`store.update` 是把传入的字段盖到旧记录上（`{ ...old, ...input }`），删掉的键盖不掉旧值，落盘后还是原样。由 `scripts/rules-check.mjs` 拦（确实不是 Task 的对象在行尾写 `delete-ok: 原因`）。
- 起因：2026-10-24 用户导出的对话里 7 个已完成的子对话都挂着 `wrapRequest: merging`；叫醒后 submit_merge 一直被拒「父对话正在合并你的分支」（真实 Pi 复现）。
- 防线：`scripts/real-cli/pi-handoff.mjs` 的「叫醒后再请求收尾」；规则检查第 6 条。
