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
   - 只给挂了编排工具的调用装，压缩、审查不装。预热也装（2026-11-04 改）：预热起的进程之后会接着处理用户的消息（开独立分支后在新目录重开也走预热），不装的话这些轮次只能靠一轮结束后的提醒；还没收到消息时 `before-end.ts` 判成放行。
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
| P3  | Codex 接入；Pi / Command Code 的工具前后和压缩后；面板事件和 Webhook 合并；旧工作流节点迁到 `submit_verdict`                 | 已实施                |
| P4  | 把只写在提示词里、或要等收尾才查的规则做成内置守卫；内置钩子的参数、按项目开关；工具结果进输入、版本门槛、按 CLI 关事件      | 已实施                |

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
  - 只读身份守卫：调研、评审、排查分析这三个内置角色，以及只统筹的父对话（就地微改动登记的文件放行）。按工具类别和命令前缀判断，不看回复文字。2026-11-05 起项目 `.tmp/` 和系统临时目录（不在项目里的部分）里的临时文件也放行：一律拦时模型会改用 stdin 喂脚本，规则没管住什么，只是多绕一步。
  - 临时文件位置守卫：默认关。
  - 改文件后推送教训：默认关；同一对话里每条教训只推一次。
- **设置页**：`web/src/components/settings/HooksSection.tsx`、`HookEditor.tsx`。AI 创建是辅助对话框的 `hook` 类型（`shared/assist-hook.ts`），预览里服务端校验并试跑都通过才让保存，保存后一律关着。
- **工具前 / 工具后 / 压缩后目前只有 Claude Code 装**：Pi、Command Code 的扩展里也有对应事件（`tool_call`、`beforeToolCall` 等），留到以后接；设置页照实写不支持。

### 第三期（2026-11-04）

- **Codex**（0.166 app-server 实测）：钩子用 `-c hooks.Stop=[…]` 这类参数传（来源记作 sessionFlags），不改用户的 `hooks.json`。
  - 格式和 Claude Code 一致：Stop 回 `decision: block` 同一轮续跑（会多出一条 `hookPrompt` 条目，面板不画）；PreToolUse 回 `permissionDecision: deny` 拒绝；SessionStart 的 `additionalContext` 交给模型。
  - 压缩之后 Codex 以 `source: compact` 再跑一次 SessionStart，补的说明有效；PostCompact 的 `additionalContext` 不会交给模型，所以「压缩后」接在 SessionStart（compact|resume）上。
  - **信任**：Codex 只跑用户信任过的钩子（按命令内容算的哈希记在 `~/.codex/config.toml` 的 `hooks.state`），`-c` 传不进信任记录，没信任的静静地不跑。面板开始前用 `hooks/list` 查一遍，只把来自参数、命令里引用了 `AGENT_PANEL_HOOK_SCRIPT` 的那几条用 `config/batchWrite` 记成信任，用户自己和项目里的钩子不碰。没用 `--dangerously-bypass-hook-trust`：它会连项目仓库里没审过的钩子一起放行。
  - 命令里的转发脚本路径走环境变量（`node "$AGENT_PANEL_HOOK_SCRIPT" …`），命令每轮相同、哈希不变，信任一次就够；记的键按事件和序号固定，不会越积越多。Windows 上的 `commandWindows` 用 `%变量%` 写法，没实测。
  - 模型有时用 shell 跑 `apply_patch`，钩子收到的工具名是 Bash：CLI 定义的 `editCommands` 把它算作改文件，路径从补丁头里取，补丁改到的每个文件都要过只读守卫。
  - 在 deepseek 中转上 PostToolUse 补说明会让下一次请求报「tool_calls 后面缺 tool 消息」（中转把 Responses 转成 Chat 时顺序对不上），官方接口不受影响；报错照常显示给用户。
- **Pi / Command Code 的工具前后和压缩后**：写在面板每轮装的扩展里，CLI 定义的 `events` 只声明能拒绝、能补说明。
  - Pi：桥接扩展接 `tool_call`（返回 `block`）、`tool_result`（补的说明接在结果后面）、`session_compact`（`sendMessage` 补一条不显示的消息）。
  - Command Code：mod 接 `beforeToolCall`（`block` + `additionalContext`）、`afterToolCall`；压缩只有 `compaction_done` 事件，mod 先问面板，下一回合开始时在 `onTurnStart` 里补一条不显示的消息。
  - 每轮装的是同一份代码，按环境变量 `AGENT_PANEL_HOOK_EVENTS` 只问这一轮有人用的事件。
- **面板事件**：`task.done`、`task.failed`、`task.waitingUser`、`task.wrapRequested`、`plan.stepDone`、`schedule.finished`，只通知、输出不看，四个 CLI 都一样（`server/hooks/notify.ts`）。对话事件从任务落盘前后的状态比出来（`task-store` 的 `onTaskChange`），和浏览器通知同一套判断，不读回复文字。
- **Webhook 并入**：设置里原来的「计划 Webhook」迁成 `schedule.finished` 上的一个 HTTP 钩子（只迁一次，开关照旧）。投递照旧最多重试 3 次、结果记在计划上；收到的 JSON 改成钩子的统一格式，原来的字段放在 `schedule` 下、`event` 改叫 `result`。
- **按文字认结论删掉了**：`parseVerdict` / `leadVerdict` 删除；老模板里「最后一行写『验收结论：通过』」改成调用 `submit_verdict`，用户存下的旧角色、旧节点启动时用 `rewriteVerdictText` 迁一遍（`server/verdict-migrate.ts`）。
- **真实接口测试**（deepseek-v4-flash 中转）：Claude Code、Codex、Pi 三个 CLI 都跑过用户钩子拒绝命令、结束前拦住同轮续跑、「对话完成」通知；Codex 只给面板自己的 3 条钩子写了信任。
  - 测出 Pi 扩展第一期起就没问过面板：`agent_before_settle` 里按 `context.canContinue === false` 提前返回，那一刻这个值永远是 false，已修。
  - 测出按命令前缀匹配认不出 `cd 项目 && npm test`，改成按 `&&`、`;`、`|` 拆开逐段比（`commandSegments`）。
  - Command Code 用自带 API 也要先 `cmd login` 账号，没法真机跑；`shared/hook-mod.test.ts` 把生成的 mod 加载起来接本地假面板，逐个调用四个事件。

### 第四期（2026-11-04）

起因：盘点后发现面板里不少规则只写在提示词里（推送授权、长命令放后台、凭据不进仓库），或者要等一轮结束、甚至收尾时才查（子对话没请收尾、Bug 先诊断），模型违反了要么没人拦、要么拦得太晚白干一场。判定标准：面板手里有现成的结构化事实、规则已经存在但管得不够、对所有项目适用、误拦面窄。

- **新的内置守卫**（`server/hooks/guards.ts`，都是工具前、默认开）：
  - 推送授权：按项目的推送设置和对话的授权（`task.remotePush`）拦 `git push`、`gh pr merge`。「问一次」策略下没授权以前完全没人拦；「不推送」和子对话分支原来靠 git 配置兜底，报错看不懂。
  - Bug 先诊断：诊断没确认就改文件、改到方案以外的文件时拒绝。以前只在 `submit_merge` 时查（`diagnosisGate`）。
  - 危险命令：递归删根目录、家目录、项目、数据目录；原分支上 `reset --hard`、整目录 `clean` / `checkout`；强推；删主干分支。子对话自己的独立分支里 reset 这类放行，`git clean` 点名具体路径的放行。
  - 长命令转后台：有 `run_background` 时，开发服务器、监听和完整测试（`FULL_SUITE_COMMAND`）放在前台跑就拒绝。
  - 测试步骤归属：独立分支里的子对话跑 `scope = parent` 的步骤时拒绝。
  - 凭据：改文件、往文件重定向的命令里出现高准确率的密钥模式时拒绝，`.env` 这类放行。
  - 独立分支越界：子对话改自己 worktree 以外的文件时拒绝；原仓库里的一律不行（项目放在临时目录里时也一样）。
- **「没做完不收尾」补上「子对话做完却没请收尾」**：计划只剩收尾那一步、或没列计划但改过文件时，在同一轮里拦住让它调 `submit_merge`（`mergeOwedOf`）。只看计划和改动清单，不跑 git；拦过后一轮结束的 `nudgeMerge` 不再重发。
- **两个默认关的**：原地打转提醒（同一条命令连续失败到设置的次数补一句）、改完没验证（改了文件之后一条命令都没跑就结束时拦一次）。
- **内置钩子可配参数、可按项目开关**（`shared/hook-builtins.ts`，`hooks.json` 的 `params` / `projects`）；内置钩子拦下、补说明的也记进「最近触发」，名字按界面语言显示。
- **工具结果进输入**：CLI 定义的 `toolFields.output` / `failed` 取执行结果和是否失败；Claude Code 的工具后同时装 `PostToolUseFailure`（带 `error`），补说明的 `hookEventName` 按原生事件填（`{event}`）。Codex 报不出失败。面板自己的工具认成 `panel` 类，用户钩子按去掉前缀的工具名匹配。
- **版本门槛**：事件可以写 `minVersion`（Codex 0.166.0、Pi 1.5.0、Claude Code 工具后 2.1.0），本机检测到的版本更老时不装那几个事件，退回一轮结束后的提醒；读不到版本照装。
- **按 CLI 关掉事件**（`hooks.json` 的 `cliOff`）：中转站上 Codex 的工具后补说明会报错这类情况，只在那个 CLI 上关掉。
- **真实接口测试**（Claude Code + deepseek-v4-flash）：推送授权拦下 `git push`（提示先 `ask_push`）；长命令守卫拦下 `npm run dev`，模型改用 `run_background`；危险命令拦下 `git clean -fd`，模型改用定点的 `rmdir`；原地打转在第二次失败后补了说明（PostToolUseFailure 这条路通了）；改完没验证拦了一次，模型说明只改了注释。

## 2026-11-04 更新：计划没跟上提醒（plan-pace）

用户反映子对话「一股脑做完再更新计划」。提示词早就要求做完一步立刻标完成，但面板只在一轮开头（`planNotice`）和结尾（`keep-going`）提醒，子对话常常一整轮就把活干完。新加内置钩子「计划没跟上提醒」（工具后、默认开，只给有执行计划的对话）：改文件、跑命令时，计划有没开始的步骤却没有进行中的步骤（动手 3 次后），或进行中的那一项上次更新后已经动手到设置的次数（默认 20，用户在设置里可改；超过 `PLAN_STALE_MS` 时到三分之一就提醒），补一句让它先用 `set_plan` 更新。读文件、搜代码、面板工具不算动手；同一项最多提醒几次也可以设（默认 1 次，提醒过后再动手到次数才提醒下一次），计划步骤分得粗时默认最多早提醒一次。判断在 `shared/plan-pace.ts`，只看工具类别和计划状态，不看回复文字。

## 补充（2026-11-04）：钩子的开销

- 工具前 / 工具后按这一轮实际关心的工具类别过滤（`hookTools` → 配置里的 `{toolMatcher}`）：内置守卫和提醒只看改文件、跑命令，读文件、搜索不再每次多跑一趟。用户钩子匹配任意工具时照旧全部触发。
- Claude Code 2.1.318 起用 `type: http` 的钩子直接 POST 到面板（`/api/mcp/ask/<令牌>/hook/<事件>`），不再每次起一个 node 跑转发脚本；读不到本机版本时照旧用转发脚本。回复文字由面板收到后立即丢掉（`answerHook` 的 `dropInput`），判断仍然不读。
- 不支持 HTTP 钩子的命令类钩子（Codex、老版本 Claude Code）：本机有 curl 时，调转发脚本的命令自动换成 curl 直接 POST 到面板（`shared/hooks.ts` 的 `toCurl`），Codex 0.166 实测每次 11–17 ms，node 转发脚本 81–134 ms。没有 curl 时照旧用转发脚本。Codex 的 `mcp_tool` 钩子不把钩子输入交给工具（`arguments` 为空），守卫没法判断，所以不用它。Pi、Command Code 的钩子本来就在 CLI 进程里直接请求面板，不用改。

## 2026-11-05 更新：end_turn 交代结束，提醒不画进对话、不限次数

用户反馈：Agent 已经写完总结，结束前钩子还是问了一次「（收尾自检）做完了吗」，拦住的那一行像工具调用，把前面的总结挤进了折叠。设计稿 `docs/openspec/changes/end-check-signal/design-v2.md`（含定稿一节）。

- **结束只认工具**：新的面板工具 `end_turn`（`outcome: done | blocked`，blocked 写 `need`），记在 `Task.turnEnds`。这条输入以来交代过 done 就放行；blocked 放行并留一条「卡住了」的警告，子对话上报父对话。计划没做完、子对话没请收尾时 done 会被拒。仍不读回复文字。
- **提醒不画进对话**：`panel: 'hook' | 'nudge'` 的消息、`end_turn` 这一行、end_turn(done) 之后的那一次输出都不显示（`visibleMessages`），在对话菜单「状态」的日志里按时间插进去（原先是单独的「面板提醒」卡片，用户 2026-11-05 要求并进日志），计数算上钩子拦截。这一条改了本 ADR 决策 1 的「对话里只留一行」。
- **不限次数**：去掉「面板提醒次数」（第 4 条的次数上限）。计划、收尾请求这几档靠空转保护收住：连着 3 次提醒之间一个工具都没调就停下交给用户（`SPIN_MAX`）。没列计划的自检保留第 6 条的门槛，问过以后没再动手的不会再问。

## 2026-11-05 更新：没列计划的自检去掉动手门槛

实测和用户导出的对话里，「我先跑一下测试」「我去派子对话核实」说完就停，只调了一两个工具，第 6 条的门槛（动手 + 读取 ÷ 3 < 3）按 `small` 放行，一轮结束后的 `nudgeNoPlan` 也不问。面板不读回复文字，分不清「答完了一个小问题」和「说了要做下一步却停了」，唯一可靠的信号是 `end_turn`。

- 结束前钩子没列计划那一档：没用 `end_turn` 交代就要结束的一律问一次（`check-no-tools` / `check-worked` / `check-resumed`）；只有问过以后只回了话、没再调工具时放行（`answered`）。代价是小问答在模型没调 `end_turn` 时多一次请求。
- 一轮结束后的 `nudgeNoPlan` 保留原门槛：四个 CLI 都装了结束前钩子，它只在钩子没问到的那一轮兜底，钩子问过的不再问。
- 不改成把门槛从 3 调到 1 这类做法：那只是把口子挤小。
