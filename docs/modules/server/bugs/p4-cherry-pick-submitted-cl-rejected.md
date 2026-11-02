# P4 已提交的 changelist 不能 cherry-pick

- 状态：已修复（`server/cherry-pick.test.ts` 通过）
- 症状：让 Agent 把已经 submit 的 changelist cherry-pick 到目标，工具整次拒绝（「这个对话没有改过它」或「不在项目目录里」），Agent 转去分析 stream 父子关系、准备自己 copy up
- 入口：`server/cherry-pick.ts` 的 `cherryPickP4`、`shared/cherry-pick.ts` 的 `cherryPickPart`、`server/orch-mcp.ts` 的 `cherry_pick` 说明
- 根因类型：只按「这个对话自己提交、当前工作区映射得到」设计输入，没覆盖用户在别的 stream 上自己提交的 changelist；提示词没禁 p4 原生集成命令
- 模块：`server`（`server/cherry-pick.ts`、`server/orch-mcp.ts`）、`shared`（`shared/cherry-pick.ts`）
- 关键词：cherry-pick、cherry_pick、P4、changelist、已提交、submitted、stream、子流、copy up、p4 where、not in client view

## 根因

- 旧版只用 `p4 opened -c` 找文件，已提交的 changelist 没有打开记录（20ae2be 改成先 `describe` 看状态）。
- 20ae2be 之后仍有两处挡住：用户自己提交的 changelist 不是「这个对话改过的文件」，整次拒绝；提交在另一条 stream 上（例如子流 `1.0_official_dev` 的提交要搬回父流）时，当前工作区映射不到这些文件，`p4 where` 查不到路径，判成「不在项目目录里」。
- 提示词只禁了 git 的 cherry-pick / merge，没禁 p4 integrate / copy，工具被拒后 Agent 自己去做流间集成。

## 修复

- P4 不再要求文件是这个对话改的（用户定的：只守「不自己 submit」这一条）：搬的只是这个 changelist 自己的改动（pending 是打开前到现在，已提交的是提交前后两版之差），目标里只建 pending。
- `p4 where` 找不到时按 stream 层级换算：读当前工作区的 Stream 和项目在流里的子目录，把别的流上的 depot 路径换成项目里的相对路径。
- 已提交 changelist 里的 integrate / branch / move 按内容变化归成编辑 / 新增 / 删除。
- 提示词和工具说明禁止 p4 integrate / merge / copy / populate 和改 stream 父子关系。
