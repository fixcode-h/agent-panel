# server-exec · Bug 索引

| ID                        | 症状                                                                                     | 关键词                                                                  | 入口                                  | 根因类型                   | 状态   | 文档                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- | -------------------------- | ------ | ----------------------------------------- |
| sub-session-other-project | 子任务续接会话报「Session found in different project … Aborted.」，Pi 没完成这一轮就退出 | Session found in different project、Aborted、独立分支、worktree、resume | `server/exec/runner.ts` 的 `runAgent` | 会话目录判定漏掉非对话路径 | 已修复 | [详情](bugs/sub-session-other-project.md) |
