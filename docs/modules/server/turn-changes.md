# server · 每轮改动卡片与撤销

[server 模块](README.md)的子页面：对话每轮的改动记录和撤销。模块的状态块、`server/tasks.ts` 拆分表、入口、依赖和回归验证见 [README.md](README.md)，Bug 记录见 [bugs.md](bugs.md)。

2026-10-31 从 `README.md` 原样挪出（文字没改），各条的日期和结论以当时为准。

## 每轮改动卡片与撤销（2026-10-31）

对话每轮总结下面的「已更改 N 个文件」：`server/turn-changes.ts` 记，`TaskMessage.turnChanges` 存，`web/src/components/tasks/TurnChanges.tsx` 画。

- 只在 git 仓库里记。runner 在对话自己的一轮开始时用 `gitSnapshot` 给工作区拍快照（不碰暂存区和提交，从真正的暂存区拷一份起步，只重新读改过的文件），`endTurn` 时再拍一张，差就是这一轮的改动，挂在这一轮最后一条有正文的回复上。被停下、出错的一轮在进程收尾时照样记。
- 范围：用户的新消息重新拍起点（空档里用户自己改的、子对话合进来的都不算）；子任务、计划交回结果后接着做的一圈（`AgentCall.carry`、runner 里等子任务时收到的消息）沿用上一圈终点，子任务和工作流节点在空档里改的算进来。子对话合回这个目录的那一下（`children.ts` 的 `integrate`、`mergeWorktree`）用 `aroundMerge` 切掉，一轮可能因此有几段 `spans`。
- 撤销（`POST /tasks/:id/turn-revert`，`undoSpans`）：每个文件从现在的内容按从后往前撤每一段；现在就是改完的样子直接换回，之后又改过就用 `git merge-file` 三方合并只撤这段；改到同一处、二进制、新建后又改、删掉后又建回都算冲突，有冲突时一个文件都不写，把冲突交回页面。内容按 `cat-file --filters` 取，Windows 的 autocrlf 不会让每一行都对不上。对话正在回复、或有节点 / 子任务在跑时拒绝。快照树没有引用，过了 git 的清理期限（默认两周）就撤不了，会报「改动记录已经被 git 清理」。
- 跟踪状态只在内存里：面板重启时进行中的那一轮没有卡片。
