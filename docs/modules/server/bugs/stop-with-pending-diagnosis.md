# 诊断报告等确认时，点输入框的停止按钮结束不了对话

- 状态：已修复（`shared/bug/diagnosis.test.ts`、`scripts/e2e/09-subagent-runtime.mjs` 通过）
- 症状：Bug 子对话交了诊断报告、停在「等你确认」时，输入框一直是停止按钮，点了没有变化，对话一直算在运行
- 入口：`server/tasks/actions-routes.ts` 的 `/:id/stop`、`parkDiagnoses`；`shared/task.ts` 的 `convState`
- 根因类型：停止只收在跑的执行，碰不到这一轮已经说完、只剩待确认事项的对话
- 模块：`server`（`server/tasks/`）、`shared`、`web`
- 关键词：诊断报告、等你确认、停止按钮、结束不了、submit_diagnosis、convState、ADR 0045

## 现象

用户报：「报告待确认的子任务无法结束」「点输入框按钮无法结束」。

## 根因

1. 交完诊断报告，子对话这一轮正常说完，状态是 `done`，CLI 不在执行。
2. `convState` 把等确认的报告（`diagnosis`）算成 `running`，输入框按 `taskActive` 显示停止按钮。
3. 停止走 `userStop`：`stopTree` 只停内存里在跑的执行，`dropRequests` 只清确认请求和提问。等确认的报告不动、状态也不改，返回的还是 `done` 加上等确认的报告，所以按钮一直是停止。

## 修复

- `/stop` 在停稳之后调用 `parkDiagnoses`：这棵树里报告还在等确认、又没在执行的对话，用 `settleStopped(tk, 'user')` 落成已停止。报告留着，之后照样能确认，确认后发的消息会把它接着拉起来。子对话也记成 `user`：没有用户确认，它接着跑也只能再等，父对话继续时不用把它白拉起来。
- `convState`：已停止的对话不再因为等确认的报告算在运行。
- 对话最下面的「诊断报告」行：对话停下后不再转圈，入口照样在。

## 防线

- `shared/bug/diagnosis.test.ts`：停下的对话即使报告还在等确认，状态也是 `stopped`。
- `scripts/e2e/09-subagent-runtime.mjs`：「诊断报告等确认时点停止」——交完报告后点停止，状态变成 `stopped / user`，报告还是等确认。fake CLI 新增 `SUBMIT_DIAGNOSIS:<JSON>` 标记，用来交报告。
