# P4 项目里 Agent 删掉自己加的代码后留下空行

- 状态：已修复（`server/p4-review-diff.test.ts` 通过）
- 症状：Agent 先加了一段代码（临时日志、调试代码、后来不要的实现），之后再删掉，原位置多出空行；P4 项目里常漏到提交
- 入口：`shared/engine/prompt-parts.ts` 的 `commonPart`「通用要求」；`shared/engine/helpers.ts` 的 `reviewPart`；`server/exec/real-turn.ts` 的 `reviewDiff`
- 根因类型：提示词没要求；P4 评审没有差异，问题看不见
- 模块：`shared`（`shared/engine/prompt-parts.ts`、`shared/engine/helpers.ts`、`shared/builtin/agents.ts`）、`server`（`server/p4-review-diff.ts`）
- 关键词：空行、空白行、删代码、加了又删、P4、p4 diff、评审差异、CRLF

## 现象

用户报（Claude Code）：Agent 新增代码，后续需要去掉，Agent 去掉时会留下空行，P4 项目里尤其容易出现。

## 根因

1. 不是换行符：Claude Code（2.1.42）改文件工具读文件时把 CRLF 统一成 LF，`new_string` 为空、`old_string` 不带换行时会连行尾换行一起删，写回时按原来的换行符还原，CRLF 文件不会因此多出空行。
2. 空行来自删的范围：Agent 加代码时常在前后多加一个空行把它隔开；删的时候只把代码那几行当 `old_string`，工具只顺带删掉一个行尾换行，当初多加的空行留在原处。
3. 为什么 P4 更明显：Git 项目的评审拿到面板取好的差异，只剩一个 `+` 空行的改动很显眼；P4 项目以前只给评审一张文件列表，评审不会去看差异，空行就一路留到提交。评审角色还把「格式」列为不评，只多出空行的改动没人报。

## 修复

- 「通用要求」加一条：删掉自己加过的代码时把当时一起加的空行也删掉，删完那一处要和加之前一样。
- P4 项目的评审也带差异：面板对这个对话改过的文件跑 `p4 diff -du`（`server/p4-review-diff.ts`），新加 / 没打开的文件另列。
- 评审角色的低级意见里点名「只多出空行的 + 行」要报。
