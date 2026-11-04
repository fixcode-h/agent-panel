# ADR 0049：钩子模块——模型说完打算就要结束时，在同一轮里拦住接着做

状态：已接受（2026-11-04 用户确认设计稿 `docs/openspec/changes/agent-hooks/design.md`，P1 已实施） · 2026-11-04

- 影响范围：`shared/hooks.ts`（新增）、`shared/cli-spec.ts` 和 `shared/clis/*.json` 的 `hooks` 字段、`server/ask-mcp.ts`（`/ask/:token/hook`）、`server/exec/invoke.ts`、`server/exec/runner.ts`、`server/tasks/before-end.ts`（新增）、`server/tasks/drive.ts`、`shared/helper-summary.ts`、`shared/prompt-lang.ts`（Command Code 的 mod）
- 修改：[ADR 0041](./0041-conversation-self-drive.md) 第 1、3 节，一轮结束后的「计划推进 / 收尾自检」降为兜底

## 背景

用户 2026-11-04 先后导出两个对话（Bug 记录 `docs/modules/server/bugs/coordinator-stops-after-announcing.md`）。Claude Code + `deepseek-v4.1-flash` 每写一句说明，约 14% 的情况会在没生成工具调用时就 end_turn，有计划的长任务几乎必然中途停一次。

Claude Code 把 end_turn 当成「做完了」，面板只能在这一轮结束后等 2 秒，再发一条【面板】消息开新的一轮。用户觉得「有计划就一定有提醒」不合理，并要求：

- 不许按回复文字猜状态；
- 做成通用的钩子模块；
- 设置里能管理钩子、能让 AI 创建钩子。

## 决策

1. **结束前钩子（`turn.beforeEnd`）**：
   - CLI 在模型准备结束这一轮时问面板。计划没做完、也没在等任何结果时面板答「拦住」，并给出下一步；CLI 在同一轮里接着做。
   - 对话里只留一行「面板让它接着做」（消息 `panel: 'hook'`，点开看交给它的说明），不再另起一轮。
2. **按 CLI 定义的字段走，用面板每轮已经装进 CLI 的东西**（`hooks.beforeEnd.via`），不改用户的配置文件：
   - Claude Code：`via: command`，`--settings` 传一份 `Stop` 钩子配置，钩子命令是面板写进这一轮临时目录的转发脚本。
   - Pi：`via: extension`，在 `-e` 加载的桥接扩展里处理 `agent_before_settle`，返回 `continue: true`（Pi 1.5 起）。Pi 没有钩子配置文件，不装第三方续跑扩展。
   - Command Code：`via: extension`，在 `--mod` 加载的 mod 里加 `onStop`，返回 `{ continue: true, reason }`。
   - Codex：暂不装，照旧靠一轮结束后的提醒；`app-server` 下怎么注入、要不要过信任还要实测。
3. **链路复用面板工具通道的令牌**：转发地址是 `/api/mcp/ask/<令牌>/hook`，令牌认出是哪个对话、哪一轮。
   - 面板没响应、超时、出错一律放行，钩子坏了不能把对话卡住。
   - 只给挂了编排工具的调用装，压缩、审查、预热都不装。
4. **判断和兜底提醒是同一套、同一个账本**：
   - 对话：`server/tasks/before-end.ts`，规则和 `nudgePlan` / `nudgeWrapUp` / `nudgeNoPlan` 一致，次数记在同一个 `DriveBudget`、用同样的 key。钩子拦满放行后，兜底看到已经推满，照常留警告、上报父对话。
   - 子任务：`shared/helper-summary.ts` 的 `submitGate`，没交 `submit_result` / `submit_verdict` 就拦一次。
   - Chat 页一问一答不拦（用户定）。
5. **不读回复文字（硬规则）**：钩子输入里的 `last_assistant_message` 在转发脚本里就丢掉，面板只拿「是不是已经续过一次」。`scripts/rules-check.mjs` 第 19b 条拦住面板代码里读这些字段。
6. **没列计划时按「这条输入以来」累计**：跑命令、改文件，加上读文件 / 搜索每 3 次折算 1 次，到 3 次就自检一次。自检过以后从那次之后数，确认做完没再动手的不再问。这修掉了单轮门槛的漏洞：被推起来以后只做一两步又停，原来接不住。

## 没选的方案

- **再加强提示词**：「回合怎么推进」已经写明不要只说打算就结束，两份导出里模型照样违反。
- **解析回复文字判断「是不是只说了打算」**：用户明确禁止，误判面大。
- **事后提醒改成不显示**：仍然是另起一轮，状态会闪「等待」，插话、回收会打断复查，次数还是要另算。
- **给 Pi 自动装社区续跑扩展**（ralph-loop、pi-goal 等）：它们各自用自己的规则判断做没做完，有的按文字或定时重发，和面板的计划冲突。

## 分期

| 期  | 内容                                                                                                                         | 状态                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| P1  | 结束前钩子：Claude Code / Pi / Command Code 接入、对话和子任务的判断、界面的「面板让它接着做」、没计划时的累计门槛、规则检查 | 已实施                |
| P2  | 设置页「钩子」（内置开关、用户钩子、AI 创建、试跑、触发记录）；工具前 / 工具后 / 上下文恢复事件和四个内置钩子                | 已实施（Claude Code） |
| P3  | Codex 接入；面板事件和 Webhook 合并；旧工作流节点迁到 `submit_verdict`                                                       | 待实施                |

## 实施记录

- 模拟 CLI（`scripts/fake-cli/fake-cli.mjs`）输入带 `HOOK_MODE` 时照真的 Claude Code 跑 `--settings` 里的 Stop 钩子。端到端测试覆盖：
  - 「只说一句就要结束」「动了手没列计划」：同一轮里自检一次，不另发提醒、只起一次 CLI（`03-chat`）；
  - 「子对话计划做一半」：拦满 3 次才放行并上报父对话（`09-subagent-runtime`）。
- 子对话「计划只剩收尾那步、没请 `submit_merge`」照旧由一轮结束后的 `nudgeMerge` 提醒一次：判断要查独立分支的 git 状态，放进钩子会让每次结束都多一次 git 调用。

### 第二期（2026-11-04）

- **规范**：`shared/hook-defs.ts`（`HookDef`、统一的输入输出、`checkOutput`、`hookApplies`）；保存前 `server/hooks/validate.ts` 查字段搭配、写死的密钥、`node --check` 语法，AI 创建的提案还要用示例输入试跑一次。
- **存储**：数据目录 `config/hooks.json` 和 `config/hooks/<id>.mjs`，跟着「数据」页的 config 一类备份导出；项目仓库里的钩子文件不会自动生效。
- **分派**：`server/hooks/dispatch.ts` 按这次调用的身份和开关决定装哪些事件，没人用的工具前 / 工具后不装（每次工具调用多一次脚本）。Claude Code 的工具前拒绝在本机 2.1.318 实测：工具结果变成一条「PreToolUse:Bash hook error: <原因>」的报错，模型据此改做法。
- **内置钩子**：
  - 没做完不收尾：第一期的结束前判断，现在可以在设置里关掉。
  - 压缩后补回计划：SessionStart 的 compact 才补。
  - 只读身份守卫：调研、评审、排查分析这三个内置角色，以及只统筹的父对话（就地微改动登记的文件放行）。按工具类别和命令前缀判断，不看回复文字。
  - 临时文件位置守卫：默认关。
  - 改文件后推送教训：默认关；同一对话里每条教训只推一次。
- **设置页**：`web/src/components/settings/HooksSection.tsx`、`HookEditor.tsx`。AI 创建是辅助对话框的 `hook` 类型（`shared/assist-hook.ts`），预览里服务端校验并试跑都通过才让保存，保存后一律关着。
- **工具前 / 工具后 / 压缩后目前只有 Claude Code 装**：Pi、Command Code 的扩展里也有对应事件（`tool_call`、`beforeToolCall` 等），留到以后接；设置页照实写不支持。
