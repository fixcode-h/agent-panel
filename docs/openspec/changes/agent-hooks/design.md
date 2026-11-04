# 钩子：通用模块、设置里管理，先用来拦住「没做完就结束」（设计稿）

状态：待确认（用户 2026-11-04 提出，先出方案，不改代码） · 2026-11-04

## 0. 一页结论

1. **新增一个通用的「钩子」模块**。面板定义一套自己的事件（结束前、工具前、工具后、开局 / 压缩后、提交输入前，以及面板自己的对话事件）。每个 CLI 在 CLI 定义里声明自己原生支持哪些事件、怎么装进去、输出怎么写。钩子的处理逻辑只写一份，在面板里跑；CLI 那边只装一个转发脚本。
2. **第一个用处是「结束前」**：模型准备结束这一轮时，CLI 先问面板。计划没做完、也没在等任何结果时，面板答「拦住」并给出下一步，CLI 在**同一轮**里接着做。对话里不再出现【面板】提醒，状态也不会先变「等待」再变回来。这一条替代 Claude Code、Codex、Command Code 现在的「计划推进 / 收尾自检」提醒；没有原生结束钩子的 CLI（Pi）继续用现有提醒。
3. **硬规则：不根据回复文字猜状态**。面板的所有判断只看结构化状态：计划、等待中的提问、子对话、后台命令、收尾请求、工具调用记录。钩子输入里即使带了 `last_assistant_message`，内置处理也不读它。这条写进 `AGENTS.md`，并加一条 `rules-check` 检查。
4. **设置里新增「钩子」页**：
   - 内置钩子（面板自带）可以开关、看说明，不能删。
   - 用户钩子可以增删改、开关、排序、测试，并看最近的触发记录。
   - 用户钩子先支持两种动作：运行命令、发 HTTP 请求。
5. **适合一起做成钩子的现有功能**（§5）：计划回注（压缩上下文后把当前计划和要点补回去）、只读角色守卫（工具前拦写操作）、临时文件位置守卫、按文件推送相关教训、对话事件通知（把现有 Webhook 收进来）。审批、`docsFirst` 门禁、工作流节点的开始 / 验收 / 结束流程不改成钩子（§5.3）。
6. **分三期**：
   - P1：模块骨架 + Claude Code 的结束前钩子，替代提醒。
   - P2：设置页 + 用户钩子 + Claude Code 的工具前 / 工具后 / 压缩后。
   - P3：Codex、Command Code 接入（先实测装入方式），面板事件和 Webhook 合并。

---

## 1. 背景

- 两份导出（`docs/modules/server/bugs/coordinator-stops-after-announcing.md`）说明：Claude Code + `deepseek-v4.1-flash` 每写一句说明，约 14% 的情况会在没生成工具调用时就 end_turn。有计划的长任务几乎必然中途停一次。面板现在只能在这一轮结束后另发一条【面板】消息补救，用户觉得「有计划就一定有提醒」不合理。
- 已用模拟模型实测：Claude Code 的 `Stop` 钩子返回 `{"decision":"block","reason":"…"}` 时，同一轮里接着做，只出一个 result；第二次触发时 `stop_hook_active: true`。
- 用户 2026-11-04 的要求：
  - 明确禁止根据回复内容的关键字猜状态。
  - 别的 CLI 也有钩子（Codex 也有）。
  - 做成通用模块，设置里能增加和管理钩子。
  - 看看还有什么适合做成钩子，一起规划。

## 2. 各 CLI 的钩子能力（核对）

| CLI          | 原生钩子                                                                                                                                                                                                             | 能拦住「结束」吗                                                                                                                     | 怎么装进去                                                                                                                                                          | 状态                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Claude Code  | `PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop`、`UserPromptSubmit`、`SessionStart`（含 compact）、`PreCompact`、`Notification` 等；`command` 类型，stdin 进 JSON、stdout 出 JSON                                | 能：`decision: "block"` + `reason`；输入有 `stop_hook_active`、`last_assistant_message`、`background_tasks`                          | 启动参数 `--settings <JSON>`，不碰用户的设置文件                                                                                                                    | **实测可行**（本机 2.1.318 + 模拟模型）                                          |
| Codex        | `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`UserPromptSubmit`、`SubagentStop`、`Stop`、`SessionStart`、`SessionEnd`、`Interrupt` 等；默认启用（`[features] hooks = false` 可关） | 能：`decision: "block"` + `reason`，Codex 用 reason 生成一条继续的提示；`continue: false` 优先；输入有 `stop_hook_active`、`turn_id` | `hooks.json` 或 `config.toml` 的 `[hooks]`，位置在 `~/.codex/` 或项目 `.codex/`；非托管钩子要在 `/hooks` 里信任后才跑，有一次性的 `--dangerously-bypass-hook-trust` | 文档确认；**怎么不写用户文件装进去（`-c` 覆盖、单独的 CODEX_HOME、信任）待实测** |
| Command Code | `PreToolUse`、`PostToolUse`、`Stop`、`SessionStart`；配置在 `settings.json` 的 `hooks` 下；另有 TypeScript mod（`--mod`，面板已用它追加回复语言规则）                                                                | 能：`decision: "block"` + `reason`，每轮最多重试 3 次；输入有 `stop_hook_active`                                                     | `~/.commandcode/settings.json` 或项目 `.commandcode/settings.json`；mod API 能不能注册 Stop 待查                                                                    | 文档确认；**装入方式待实测**（优先走 `--mod`，不写用户和项目文件）               |
| Pi           | 扩展事件（`agent_end`、`turn_end`、`tool_call`、`tool_result`、`session_before_compact`、`context` 等）；面板已经用 `-e` 加载自己的桥接扩展                                                                          | 文档里没有「拦住结束」；`agent_end` 时用 `sendMessage(…, { deliverAs: 'followUp', triggerTurn: true })` 能不能接着做待实测           | `-e {dir}/agent-panel-*.ts`（现成）                                                                                                                                 | 工具前 / 工具后可以做；结束前**先保留现有提醒**，实测后再定                      |

结论：Claude Code、Codex、Command Code 三家「结束前拦住」的语义一致（`decision: "block"` + `reason` + `stop_hook_active`），可以做成同一个面板事件。Pi 没有这个原语，走兜底。

## 3. 模块设计

### 3.1 面板事件（与 CLI 无关的名字）

| 面板事件              | 含义                                                                 | 能做的决定                       | 对应的原生事件                                                                                             |
| --------------------- | -------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `turn.beforeEnd`      | 模型准备结束这一轮                                                   | 放行 / 拦住（带下一步说明）      | Claude `Stop`、Codex `Stop`、Command Code `Stop`                                                           |
| `tool.before`         | 工具执行前                                                           | 放行 / 拒绝（带原因）/ 补充说明  | 各家 `PreToolUse`、Pi `tool_call`                                                                          |
| `tool.after`          | 工具返回后                                                           | 补充说明（追加给模型看的上下文） | 各家 `PostToolUse`、Pi `tool_result`                                                                       |
| `context.restored`    | 开局，或压缩上下文之后                                               | 补充说明                         | Claude `SessionStart`（source=compact/resume）、Codex `PostCompact` / `SessionStart`、Pi `session_compact` |
| `prompt.beforeSubmit` | 输入交给模型前                                                       | 补充说明                         | 各家 `UserPromptSubmit`                                                                                    |
| `task.*`（面板事件）  | 对话完成、失败、等你回复、子对话请求收尾、计划某步完成、计划任务跑完 | 只通知，不改流程                 | 面板自己发，不经过 CLI                                                                                     |

- 前五个是「CLI 钩子」：发生在 CLI 进程里，能影响这一轮。最后一类是「面板事件」：发生在面板里，只用来通知。
- 某个 CLI 不支持某个事件时，设置页上标「这个 CLI 不支持」，不假装生效。只有 `turn.beforeEnd` 有面板兜底（现有提醒）。

### 3.2 CLI 定义里的字段（按字段走，不按名字分支）

在 `shared/clis/*.json` 加一个 `hooks` 字段，例如 Claude Code：

```json
"hooks": {
  "install": { "kind": "settingsArg", "args": ["--settings", "{hooksSettingsJson}"] },
  "events": {
    "turn.beforeEnd": { "native": "Stop", "block": { "decision": "block", "reason": "{reason}" }, "loopFlag": "stop_hook_active" },
    "tool.before": { "native": "PreToolUse", "deny": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "{reason}" } } },
    "tool.after": { "native": "PostToolUse", "context": { "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "{text}" } } },
    "context.restored": { "native": "SessionStart", "matcher": "compact|resume", "context": { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "{text}" } } }
  },
  "streamEvents": ["hook_started", "hook_response"]
}
```

- `install.kind` 先支持三种：`settingsArg`（Claude Code）、`configFile`（Codex 的 `hooks.json`，写在面板自己的目录，路径或环境变量由定义给出）、`extension`（Pi、Command Code mod：沿用现有 `-e` / `--mod` 的生成方式）。
- 各家输出格式写在定义里，面板统一生成。接新 CLI 只加字段，`docs/cli-config.md` 的接入检查清单补一项。
- `streamEvents`：流里的钩子事件。面板认出来以后在对话日志记一行，不在对话里显示成消息。

### 3.3 一条链路：CLI → 转发脚本 → 面板 → 处理链

```
CLI 原生钩子
  └─ node <数据目录>/hooks/agent-panel-hook.mjs <面板事件>   （面板生成，内容固定）
       └─ POST http://127.0.0.1:<端口>/api/hooks/<面板事件>
            头：面板令牌；体：对话 id、角色、CLI、原生输入原样
            └─ 面板：内置钩子 → 用户钩子（按顺序）→ 合并结果 → 按 CLI 定义翻成原生输出
```

- **转发脚本只转发，不判断**。对话 id 和令牌由面板启动 CLI 时放进环境变量（同现有 MCP 桥）。
- **失败一律放行**：面板没起来、超时（默认 5 秒）、返回格式错，钩子都输出「不表态」。不能因为钩子坏了把对话卡住。失败写进对话日志和全局日志。
- **合并规则**：
  - `turn.beforeEnd`：任何一个钩子要求拦住就拦，各自的说明按顺序拼起来。
  - `tool.before`：任何一个拒绝就拒绝。
  - 补充说明按顺序拼接，总长有上限，超出部分转存文件、只留指针（ADR 0041 第 5 条：截断必须留全文指针）。
- **防死循环**：
  - CLI 自带的 `stop_hook_active`、Command Code 每轮 3 次上限都保留。
  - 面板再叠一层现有的 `DriveBudget`：同一进度最多拦 `nudgeMax` 次，同一条输入总共最多 `DRIVE_TOTAL_MAX` 次。
  - 拦满后放行，并照现在的做法留一行警告给用户。

### 3.4 内置的「结束前」处理（替代计划推进 / 收尾自检）

只看结构化状态，判断复用 `server/tasks/drive.ts` 已有的函数，抽成 `turn.beforeEnd` 和事后提醒共用的一份：

1. 在等结果就放行：等提问回答、等子对话、后台命令在跑（也看 Claude Code 输入里的 `background_tasks`）、子对话已请求收尾、有排着的输入。
2. 有计划、没做完：拦住。说明里写第几步、步骤名，以及「直接调用工具去做，做完用 set_plan 标完成」。
3. 没有计划，但这条输入以来动过手（跑命令、改文件，或读了不少文件）：同一条输入只拦一次，说明用收尾自检那句。这同时修掉 Bug 记录里「门槛按单轮算」的漏洞。
4. 其余放行：纯问答、刚回答完一句话。

拦住发生在 CLI 内部，**对话里不新增消息**。面板在对话日志里写「结束前钩子：拦住 / 放行，原因，第几次」，界面上可以在这一轮的结尾放一个很小的标记（例如「面板让它接着做了 1 次」），不再出现【面板】气泡。

Chat 页一问一答（`isChatMode`）只做第 3 条的一次自检，或者不装：跟现有 Chat 页只推 1 次的规则一致，实施时再定。

### 3.5 用户钩子

存在数据目录 `hooks.json`（不进项目仓库）。每条：

| 字段         | 说明                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| 名称、说明   | 设置页显示                                                                                               |
| 事件         | §3.1 里的一个                                                                                            |
| 范围         | 全部 / 指定项目 / 指定角色 / 指定 CLI                                                                    |
| 匹配         | `tool.*` 可以填工具名（Bash、Edit……，各家工具名在 CLI 定义里给出对照）和路径通配                         |
| 动作         | 运行命令（stdin 进面板统一格式的 JSON，stdout 出统一格式的 JSON 或空）/ 发 HTTP 请求（POST 同样的 JSON） |
| 超时、失败时 | 默认 5 秒、放行；`tool.before` 可以选「失败时拒绝」                                                      |
| 启用         | 开关                                                                                                     |

- **统一格式**：面板给用户钩子的是面板自己的 JSON（事件、对话、项目、角色、CLI、工具名、参数），不是各家原生 JSON，所以一个用户钩子对所有 CLI 都能用。返回也是统一的 `{ "block": true, "reason": "…" }`、`{ "deny": true, "reason": "…" }`、`{ "context": "…" }`。
- **安全**：
  - 钩子能执行任意命令，所以只认用户在设置页亲手建的。项目仓库里的钩子文件不自动生效（以后要支持，也得像 Codex 一样先信任）。
  - 命令里不允许直接写密钥。要用凭据就引用环境变量，和「凭据不进仓库」一致。

## 4. 设置页「钩子」

放在设置 → 集成附近，新开一节（`web/src/components/settings/HooksSection.tsx`）：

- **内置钩子**：「没做完不收尾」「压缩后补回计划」「只读角色守卫」等。每条显示事件、对哪些 CLI 生效（不支持的灰掉并写明原因）、开关。不能删、不能改逻辑。
- **我的钩子**：列表加「新建」，每条可以编辑、复制、删除、开关、拖动排序。编辑弹窗按 §3.5 的字段填写。
- **测试**：选一个事件，用一份示例输入跑一次，显示钩子的输出和面板合并后的决定。不需要真开对话。
- **最近触发**：最近 50 次触发（事件、对话、结果、耗时、失败原因），点进去跳到对话日志。
- **对话页**：诊断里列出这个对话这一轮触发过的钩子，方便排查「为什么没停 / 为什么停了」。

界面文案用 `t()`，英文同一提交写进 `shared/locales/en/`；风格按 `docs/lessons/ui.md`。

## 5. 还有哪些适合做成钩子

### 5.1 适合，建议做

| 钩子             | 事件                                | 现在怎么做                                                                                                    | 改成钩子的好处                                                                                                  | 期  |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --- |
| 没做完不收尾     | `turn.beforeEnd`                    | 这一轮结束后另发【面板】提醒（计划推进、收尾自检）                                                            | 同一轮里接着做，没有提醒气泡，不会被 2 秒复查窗口里的插话、回收打断                                             | P1  |
| 压缩后补回计划   | `context.restored`                  | 没有：压缩后模型只剩摘要，常忘了计划做到哪、派单里的验收标准                                                  | 压缩后自动补一段「当前计划和进度、派单的目标和验收、在等什么」，只给模型看                                      | P2  |
| 只读角色守卫     | `tool.before`                       | 靠角色设定写「不改文件、不提交」（调研、评审、模块分析、`agents.ts` 第 642、1431 行），模型违反了只能事后发现 | 只读身份调用写文件、`git commit`/`push`、安装依赖这类工具时直接拒绝并说明原因。判断看工具名和参数，不看回复文字 | P2  |
| 临时文件位置守卫 | `tool.before`                       | `AGENTS.md` 硬规则「临时文件只放 `.tmp/` 或系统临时目录」，只能靠提示词                                       | 写盘符根目录、其他项目目录、数据目录时拒绝，说明该写到哪                                                        | P2  |
| 按文件推送教训   | `tool.before`（第一次改某个文件时） | 开工前让模型自己跑 `node scripts/lessons.mjs <文件>`，经常忘                                                  | 第一次编辑某个文件前，自动把和它相关的踩坑记录补给模型。项目没有教训文件就不触发                                | P2  |
| 对话事件通知     | `task.*`                            | 只有计划任务有 Webhook（`server/webhook.ts`）；设置里的 Webhook 通知是单独一套                                | 对话完成、失败、等你回复、请求收尾都能发通知，Webhook 变成钩子的一种动作，老配置自动迁移                        | P3  |

### 5.2 可以做，但先放用户钩子，不做成内置

- 改完文件后格式化、行数上限检查（`tool.after`）：和具体项目的工具链绑定（Prettier、`file-caps.json`），适合给用户钩子当示例，不做成内置。
- 提交前扫密钥（`tool.before` 匹配 `git commit`）：仓库里已有 `secret-check`，用户可以自己挂；内置的话会对所有项目生效，误伤面大。
- 统计工具耗时 / 失败率（`tool.after`）：面板已经从输出流里解析工具调用，没必要再走钩子。

### 5.3 不改成钩子

- **审批**：已经走 `--permission-prompt-tool stdio` 的控制消息，有界面、有记录，改成钩子没有好处。
- **`docsFirst` 门禁**：门禁拦的是面板自己的 MCP 工具（`create_conversation`），在面板里拦更直接。
- **工作流节点的开始 / 验收 / 结束**：那是「挂一个流程」，不是事件处理。名字也叫「钩子」容易混，界面和文档里统一叫「节点的开始 / 验收 / 结束流程」，不并进这个模块。
- **根据回复文字判断做没做完**：明确禁止（§0 第 3 条）。

## 6. 分期

- **P1**：
  - 模块骨架：面板事件、CLI 定义的 `hooks` 字段、转发脚本、`/api/hooks/*` 接口、合并和防循环。
  - Claude Code 的 `turn.beforeEnd` 内置钩子，替代这家的计划推进和收尾自检；其他 CLI 照旧用提醒，并补上「门槛按输入累计」。
  - 对话日志、诊断。
  - 写 ADR，修订 ADR 0041 第 1、3 节。
  - `AGENTS.md` 加「不根据回复文字猜状态」，`rules-check` 加一条检查。
- **P2**：
  - 设置页、用户钩子（命令 / HTTP）、测试、最近触发。
  - Claude Code 的 `tool.before`、`tool.after`、`context.restored`。
  - 内置钩子：压缩后补回计划、只读守卫、临时文件位置守卫、按文件推送教训。
- **P3**：
  - Codex 接入：先实测不写 `~/.codex` 的装入方式和信任问题。
  - Command Code 接入：先实测 `--mod` 能不能注册 Stop，或者用独立的配置目录。
  - Pi 的 `agent_end` + followUp 实测，可行就替代 Pi 的提醒。
  - 面板事件 `task.*`，Webhook 并入。

## 7. 测试

- 单测：
  - 结束前判断：各种状态 → 拦 / 放。
  - 合并规则、预算、失败放行、截断留指针。
  - CLI 定义字段校验（每个声明的事件都要有原生名和输出模板）。
- e2e：假 CLI 加一个「钩子模式」，模拟 CLI 在结束前调转发脚本并照面板的回答继续或结束。验证同一轮里接着做、对话里没有【面板】消息、拦满了会留警告。
- 冒烟脚本（可选，`scripts/hook-smoke.mjs`）：真 Claude Code + 本地模拟模型（Bug 记录里那次实测的做法），机器上有 Claude Code 时才跑，CI 里没有就跳过。
- 界面检查：设置页「钩子」一节加一个分片。

## 8. 风险和待确认

- **待用户确认**：
  1. Chat 页（一问一答）要不要装结束前钩子：建议只做一次自检，或不装。
  2. 拦住时界面上要不要显示一个小标记（建议显示，点开看原因）。
  3. P2 的四个内置钩子默认开还是关：建议「压缩后补回计划」「只读守卫」默认开，「临时文件守卫」「推送教训」默认关。
- **待实测**：Codex、Command Code 怎么不写用户文件把钩子装进去；Pi 的 followUp 能不能在 `agent_end` 后接着做。
- **风险**：
  - 钩子让每次结束多一次本机 HTTP 往返（毫秒级）。
  - 内置判断出错会让对话停不下来，靠预算上限和失败放行兜住。
  - 用户钩子执行任意命令，只认设置页里建的，命令里不写密钥。

## 参考

- Claude Code 钩子：本机 2.1.318 实测（`--settings`、`Stop` 的 `decision: "block"`、`stop_hook_active`），见 Bug 记录 `coordinator-stops-after-announcing.md`
- Codex 钩子：https://learn.chatgpt.com/docs/hooks （原 https://developers.openai.com/codex/hooks ）
- Command Code 钩子：https://commandcode.ai/docs/hooks/reference
- Pi 扩展事件：https://kissgyorgy.github.io/pi-mono/docs/extensions （镜像文档，接入前以 Pi 源码 `packages/coding-agent/src/core/extensions/types.ts` 为准）
