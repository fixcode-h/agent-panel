# P4 项目的 cherry-pick 调 git merge-file，.uasset 报错

- 状态：已修复（`server/exec/merge3.test.ts`、`server/cherry-pick.test.ts` 通过）
- 症状：P4 项目里让 Agent cherry-pick，工具返回「xxx.uasset：git merge-file 出错，跳过」「没有 cherry-pick，目标没动」；用户看到的是 P4 项目也在用 git
- 入口：`server/cherry-pick.ts` 的 `cherryPickP4`、`server/exec/merge3.ts`；提示词 `shared/engine/vcs-text.ts`、`shared/builtin/agents.ts` 的「共用工作区」
- 根因类型：P4 路径借用 Git 的工具做三方合并，没按项目的版本管理选工具，也没区分二进制文件
- 模块：`server`（`server/cherry-pick.ts`、`server/exec/merge3.ts`、`server/tasks/turn-caps-vcs.ts`）、`shared`（`shared/engine/vcs-text.ts`）
- 关键词：cherry-pick、P4、git merge-file、uasset、二进制、三方合并、diff3、git add、就地微改动

## 根因

- `cherryPickP4` 的三方合并直接跑 `git merge-file`：P4 项目里本来不该有 git，二进制文件（.uasset）git 会直接拒绝（退出码 255），整次被判成「出错跳过」。
- 提示词里几处版本管理命令写死 git：共用目录子对话「只 git add 自己的文件」、父对话「只读命令 git log / git diff」、通用约束「共用工作区」的基线；父对话「就地微改动」只认 Git，P4 项目里也给了工具、调用后才被拒。

## 修复

- 三方合并改成面板自己做（`server/exec/merge3.ts`，按行 diff3，冲突标记和 git 一样），P4 cherry-pick 不再调用 git。
- 二进制文件：目标没动过时直接换成这次的版本，目标里也改过时不写冲突标记、跳过并写清楚；合完和目标一样的不再打开。
- 提示词按 `policy.vcs`（`server/exec/real-turn.ts` 探的项目版本管理）给命令；就地微改动只在 Git 项目里给。
