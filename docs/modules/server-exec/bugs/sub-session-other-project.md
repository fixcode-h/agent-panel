# 子任务续接会话时没看会话属于哪个目录，Pi 停下来问分叉后按 Aborted 退出

- 状态：已修复（代码和单测随同一批改动落地，`npm run typecheck`、`npm run lint`、`npm run test:unit` 均通过；`npm run test:e2e:wsl` 未跑）
- 症状：子任务续接会话报「Session found in different project … Aborted.」，Pi 没完成这一轮就退出
- 入口：`server/exec/runner.ts` 的 `runAgent`
- 根因类型：会话目录判定漏掉非对话路径
- 模块：`server-exec`（`server/exec/runner.ts`），配套 `shared/task.ts`、`shared/schema.ts`、`shared/task-export.ts`、`server/tasks.ts`
- 关键词：Session found in different project、Fork this session into current directory、Aborted、没有完成这一轮就退出了、独立分支、worktree、`--session`、`--resume`、spawn_agents 的 resume

## 现象

对话里的子任务（`spawn_agents` 带 `resume` 接着上一轮做，或子任务原本已有会话）报：

```
CLI 执行失败 · Pi 执行失败：
Pi 没有完成这一轮就退出了
stderr 最后几行：
Session found in different project: E:\Project\agent-panel
Fork this session into current directory? [y/N] Aborted.
```

面板里没有交互终端，答不了这个提问，Pi 读到空输入就打印 `Aborted.` 并以退出码 0 结束，面板按「没有完成这一轮就退出了」报失败。

## 复现条件

1. 对话在项目目录（`E:\Project\agent-panel`）里跑过几轮，其中派过子任务，子任务各自留下了 Pi 会话（会话文件落在 `~/.pi/agent/sessions/--E--Project-agent-panel--/`，`cwd` 记的是项目目录）。
2. 对话中途开了独立分支（`begin_edit`），`task.worktree.state = 'active'`，此后每一轮都在 worktree 目录（`C:\Users\17787\.agent-panel\worktrees\<id>`）里执行。
3. 再派一个子任务，带 `resume` 接着之前那个子任务的会话，或让那个子任务自己再跑一轮。
4. Pi 收到 `--session <旧会话 id>`，在当前 cwd（worktree）里按 id 找不到该会话 → 转去全局找 → 找到别的项目的会话 → 打印 `Session found in different project` 并 `promptConfirm` → 非交互模式下读不到回答 → `Aborted.` + `exit(0)`。

命令行可单独复现：

```bash
cd "C:/Users/17787/.agent-panel/worktrees/<某任务 id>"
echo "hi" | pi -p --mode json --session <在主项目目录里开的会话 id>
# Session found in different project: E:\Project\agent-panel
# Fork this session into current directory? [y/N] Aborted.
```

## 影响范围

- 所有「会话在 A 目录开、本轮在 B 目录执行」的组合，只要该 CLI 在续接不到本地会话时会去全局找。Pi 是明确会问分叉的；其它 CLI 表现为「会话找不到」进而失败或丢上下文。
- 对话本身（`chat`）这条路径原本就有 `sessionDir` 判断，**受影响的是子任务**：`moved` 的计算写着 `chat && ...`，子任务永远为 `false`，于是照样带着旧目录的会话 id 去启动 CLI。

## 根因

1. **记录粒度不够**：`task.sessionDir` 只有一个，且只在 `chat` 为真时写入（`runner.ts` 的 `case 'session'`）。子任务用 `task.sessions[step.session || step.id]` 各自一份会话，却没有任何地方记「这份会话是在哪个目录里开的」。
2. **判定被 `chat` 短路**：`const moved = chat && !!task.sessionDir && task.sessionDir !== cwd`。非对话（节点、子任务）一律得 `false`，`switched` 也为 `false`，`resume` 原样保留。
3. **CLI 侧行为**：Pi 的命中判定在本项目 → 全局搜索 → `type === 'global'` 时 `console.log('Session found in different project: ...')` + `promptConfirm('Fork this session into current directory?')`；`promptConfirm` 用 `readline` 读 stdin，面板的 stdin 不是 TTY 也没有输入，`resolve` 到空串 → 不是 `y`/`yes` → 打印 `Aborted.` 并 `process.exit(0)`。退出码是 0，所以面板报的是「没有完成这一轮就退出了」而不是退出码非 0。

## 修法（下次遇到同类问题的规则）

- **会话的目录跟着会话记，不跟着对话记**：`shared/schema.ts` 新增 `sessionDirs: Record<sessionKey, cwd>`，`runner.ts` 收到 `session` 事件时对所有会话（含子任务、节点）都写一条。原来的 `sessionDir`（对话共用）继续保留，作为旧数据的兜底。
- **判定抽成纯函数**：`shared/task.ts` 新增 `sameDir(a, b)`（Windows 路径大小写、分隔符、末尾斜杠不敏感）和 `sessionMoved(task, sessionKey, cwd, chat)`。`sessionMoved` 先查这个会话自己的记录，再退回对话的 `sessionDir`（仅在 `chat` 时），避免「对话搬过就把每个节点的会话都丢掉」。
- **子任务与对话分开处置**：`runner.ts` 里
  - 对话：`switched = sessionChanged(...) || moved`，丢会话并把之前的对话压缩后带进新会话（原逻辑，未变）。
  - 非对话节点/子任务：`moved` 为真就直接 `resume = undefined` 用完整提示新开一个——子任务没有「对话记录」可带，也没有 `fresh` 以外的补救。
- **删除会话时同步清目录记录**：三处 `delete task.sessions[sessionKey]`（会话找不到、历史不兼容、压缩摘要）和 `server/tasks.ts` 换角色清会话处，都补上 `delete task.sessionDirs[...]`，避免残留旧目录让下一轮误判。
- **旧任务的自愈兜底**：修复前写下的任务没有 `sessionDirs`，跑到那份会话上仍会撞同一句报错。`runner.ts` 新增 `SESSION_OTHER_PROJECT` 正则（匹配 `Session found in different project` / `Fork this session into current directory`），在失败分支里丢掉会话并用 `call.fresh ?? call.prompt` 重跑一次，同时 `log.warn` 记下 `cwd` 和 stderr 片段。
- **导出不带本机信息**：`shared/task-export.ts` 把 `sessionDirs` 加进 `omit`，导入时重置成 `{}`；`shared/task.ts` 的 `newTask` 和 `taskSummary` 补上该字段。

## 防复发护栏

- `shared/task-session-dir.test.ts`：`sameDir` 的大小写/分隔符/末尾斜杠/空串；`sessionMoved` 的「换了目录判搬过」「同目录不判搬过」「没记录不误判（交给自愈）」「对话退回 `sessionDir` 兜底」「节点不用对话的 `sessionDir` 兜底」「新字段优先于旧字段」。
- 现有 `scripts/e2e/04-subagents.mjs` 已有对话侧的断言「换了目录不续接旧会话」（`!wtCall.args.includes('--resume')`）；子任务侧的同类断言尚未补。

## 回归验证

```bash
npm run typecheck && npm run lint && npm run test:unit
```

单测本轮结果：`tests 1210 / pass 1210 / fail 0`（含本 Bug 新增的 5 条）。

## 排查路径（下次定位同类问题的顺序）

1. 先在出错任务的记录里看 `sessions` / `sessionDirs` / `worktree` / `sessionDir`：确认这一轮的 `cwd`（`worktree.path`）与那份会话开在哪里是否一致。
2. 直接拿会话 id 在那个目录里手跑一次 CLI（本页「复现条件」里的命令），能复现就说明是「会话按目录存」这一类问题，不用再猜参数拼装。
3. 看 `resume` 是怎么算出来的：`runner.ts` 的 `let resume = task.sessions[sessionKey]` 之后，有哪些分支会把它清掉；注意 `chat &&` 这种短路条件是否把非对话路径漏掉了。
4. CLI 的会话查找顺序看它自己的源码（Pi：`resolveSessionPath` 先本地 `findById`，再 `list(cwd)`，最后 `listAll` → `type: 'global'` 触发确认）。

## 落地改动

| 位置                              | 改了什么                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/schema.ts`                | `TaskData` 新增 `sessionDirs: Record<string, string>`（默认 `{}`）                                                                           |
| `shared/task.ts`                  | 新增 `sameDir`、`sessionMoved`；`newTask` 和 `taskSummary` 补 `sessionDirs`                                                                  |
| `server/exec/runner.ts`           | 用 `sessionMoved` 判定；子任务搬过也丢 `resume`；`session` 事件对每个会话记目录；三处删会话同步清目录；新增 `SESSION_OTHER_PROJECT` 失败自愈 |
| `server/tasks.ts`                 | 换角色清会话时同步清 `sessionDirs`                                                                                                           |
| `shared/task-export.ts`           | 导出时 `omit sessionDirs`，导入时重置为 `{}`                                                                                                 |
| `shared/task-session-dir.test.ts` | 新增 5 条用例覆盖 `sameDir` / `sessionMoved`                                                                                                 |

## 待确认

- 子任务侧的端到端用例还没补：`scripts/e2e/04-subagents.mjs` 目前只覆盖「对话换目录不续接会话」，没有覆盖「子任务换目录后不续接」。要补需要在 fake-cli 里记下 `--session` 的取值和 `cwd`，再断言两者匹配。
