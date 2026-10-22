---
paths: shared/schema.ts, shared/task.ts, shared/data.ts, server/store.ts, server/*store*.ts, server/tasks.ts, server/update*.ts, server/exec/worktree.ts, web/src/components/tasks/Worktrees.tsx, scripts/package.mjs, web/src/lib/demo-backend.ts, web/src/lib/api.ts
---

# 数据结构、存储、升级兼容和出包

## 新字段要让旧数据保持旧行为

- 规则：给 schema 加字段时想清楚旧数据读进来是什么默认值，必要时按「新字段出现之前的数据当作已经……」处理，并加读旧数据的测试。迁移要幂等。
- 起因：840b871，加 `turnSeenAt` 后升级用户的旧会话全部亮成未读。
- 防线：`server/task-store.test.ts` 这类读旧数据的用例。

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
