# 诊断停在论证第 1 轮，Agent 却弹提问窗口问用哪个方案

- 状态：已修复（`shared/bug/no-ask.test.ts` 通过）
- 症状：用户报的 Bug 子对话，诊断报告的阶段条一直停在「论证 · 第 1 轮」，Agent 没交报告，反而弹出提问窗口问用户用哪个修复方案
- 入口：`server/exec/invoke.ts` 的提问分流（`selfAnswer`）、`server/exec/runner.ts` 的 `askRedirect`、`shared/bug/no-ask.ts`
- 根因类型：流程只在提示词里规定、没有面板侧的拦截，Agent 绕开诊断报告走了提问工具
- 模块：`server-exec`（`server/exec/invoke.ts`）
- 关键词：诊断报告、论证、修复方案、提问、ask_user、AskUserQuestion、submit_diagnosis、改用方案

## 现象

Bug 子对话查到有几种修法时，没有用 `submit_diagnosis` 交修复方案，而是用提问工具问「用哪个方案」。子对话开着「提问」，问题交给父对话再弹给用户；用户答了也进不了报告，阶段条和版本都不动。

## 根因

完整流程（`shared/builtin/bug-method.ts` 第 6 步）规定选方案写进修复方案、用户在报告弹窗里确认或点「改用方案 X」，但没写不能用提问工具；面板对提问只看「提问」开关（开着交给用户 / 父对话，关着让它自己选），不知道这是要交报告的对话。所以模型拿不准时就近用了提问工具，诊断流程被绕开。

## 修复

- `invokeCli` 加 `askRedirect`：返回一句话时 CLI 的提问（面板的 `ask_user`、Claude Code 的 `AskUserQuestion` 等原生提问）不交给用户，用这句话回答；审批不受影响。
- 任务执行时，用户报的 Bug（`task.bug.kind` 为 `report`，就地查的 Bug 修完或不修了之后除外）的提问一律改道：回答里写明选修法写进修复方案、根因没证实先交论证、缺的信息写进论证的 collect，然后交报告结束这一轮。「提问」开关开着关着都改道：关着时原来的「按你的判断选」同样绕开了报告。
- 完整流程第 6 步加一条：要用户决定或补充的都写进报告交，不用提问工具问。

## 防线

- `shared/bug/no-ask.test.ts`：用户报的 Bug 改道、直接修的 Bug 和普通对话照常提问、就地查的 Bug 修完后恢复。
