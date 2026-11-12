# 钩子：通用模块、设置里管理、AI 创建，先用来拦住「没做完就结束」（设计稿 v2）

状态：已确认（用户 2026-11-04：Chat 页不装结束前钩子；拦住时显示小标记；内置钩子默认开关和 AI 生成的默认关闭按建议），P1、P2（Claude Code）已实施，见 [ADR 0049](../../../adr/0049-hooks-continue-in-turn.md) · 2026-11-04

> v2 改动：
>
> - 补「AI 创建钩子」（§7）和钩子规范（§6）。
> - Pi 改用面板自己的扩展里的 `agent_before_settle` 处理，Command Code 改用面板自己的 mod 里的 `onStop` 处理，两家都不再保留提醒（§3）。
> - 盘点代码里所有「一轮结束后再补救」的地方和残留的按文字判断（§2）。
> - 结束前的判断覆盖所有身份（§5）。
> - 列出 v1 遗漏的点（§10）。

## 0. 一页结论

1. **一个通用的「钩子」模块，处理逻辑只写一份，在面板里跑**。
   - 面板定义自己的事件：结束前、工具前、工具后、上下文恢复、提交输入前，以及面板自己的对话事件。
   - 每个 CLI 在 CLI 定义里声明原生支持哪些事件、怎么装进去、输出怎么写、最低版本。
   - CLI 那边只装一个转发层，复用每轮已有的面板工具通道（`openAskBridge` 的令牌地址）认出是哪个对话，不另开鉴权。
2. **四家都能在同一轮里拦住「没做完就结束」**，全都用面板每轮已经在装的东西，不往用户的配置文件里写：
   - **Claude Code**：`--settings` 传 `Stop` 钩子，已实测。
   - **Pi**：面板每轮用 `-e` 加载的桥接扩展里加 `agent_before_settle` 处理，返回 `continue: true`。已对照 Pi 1.5.0 源码确认。
   - **Command Code**：面板每轮用 `--mod` 加载的 mod 里加 `onStop`，返回 `{ continue: true, reason }`，文档确认。
   - **Codex**：`Stop` 钩子返回 `decision: "block"`，文档确认。面板用 `app-server` 跑 Codex，怎么不写 `~/.codex` 把钩子装进去、要不要过 Codex 的信任，还要实测。实测通过前 Codex 继续用现有提醒。
3. **硬规则：不根据回复文字猜状态**。
   - 判断只看结构化状态：计划、提问、子对话、后台命令、收尾请求、`submit_result` / `submit_verdict` / `submit_merge` 交没交、工具调用记录。
   - 钩子输入里即使带了 `last_assistant_message` / `lastAssistantText`，转发层直接丢掉，不交给面板的处理链。
   - 这条写进 `AGENTS.md` 硬规则，`scripts/rules-check.mjs` 加一条检查（§10.1）。
   - 现存的唯一例外是旧工作流节点读「结论：通过」（`shared/verdict.ts`），列入清理。
4. **结束前的判断覆盖所有身份**：顶层对话（计划 / 收尾自检 / 子对话请求收尾）、子对话（计划 / 没交 `submit_merge`）、子任务（没交 `submit_result`）、评审类子任务和节点（没交 `submit_verdict`）。现在分散在 5 处的事后补救统一成一份判断（§5）。
5. **设置里新增「钩子」页**：
   - 内置钩子可以开关、看说明。
   - 我的钩子可以增删改、开关、排序、测试，并看最近触发记录。
   - 带一个「AI 创建」按钮：说一句要做什么，AI 按钩子规范生成；面板校验、试跑都通过才能保存，保存后默认关闭，由用户打开（§7）。
6. **还适合做成钩子的**（§9）：
   - 压缩后补回计划和派单要点。
   - 只读身份守卫。
   - 临时文件位置守卫。
   - 第一次改文件前推送相关教训。
   - 对话事件通知，并入现有 Webhook。
7. **分期**（§11）：
   - P1：模块骨架 + Claude Code / Pi / Command Code 的结束前。
   - P2：设置页、用户钩子、AI 创建、工具前 / 工具后 / 上下文恢复。
   - P3：Codex（先实测）、面板事件和 Webhook 合并、清掉 `verdict.ts` 的按文字判断。

---

## 1. 背景与要求

- **为什么要做**：两份导出（`docs/modules/server/bugs/coordinator-stops-after-announcing.md`）说明，`deepseek-v4.1-flash` 每写一句说明，约 14% 的情况会在没生成工具调用时就 end_turn。有计划的长任务几乎必然中途停一次。面板只能在这一轮结束后另发【面板】消息补救，用户觉得「有计划就一定有提醒」不合理。
- **用户要求**（2026-11-04）：
  1. 明确禁止根据回复内容的关键字猜状态。
  2. Codex 也有钩子，其他 CLI 也要看。
  3. 做成通用模块，设置里能增加和管理钩子。
  4. 设置页加一个 AI 按钮，让 AI 创建新钩子，新钩子要符合规范。
  5. Pi 有没有 `agent_end` 的扩展插件，或者支不支持用户自定义钩子；支持就自动装上。
  6. 看看还有什么适合做成钩子；结合代码找遗漏、补不全面的分析。

## 2. 现状盘点（读代码）

### 2.1 现在的「一轮结束后再补救」

| 位置                                                                                                     | 身份           | 触发                                              | 补救方式                                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `server/tasks/drive.ts` 的 `nudgePlan`                                                                   | 顶层、子对话   | 计划没做完、没在等                                | 等 `PLAN_NUDGE_MS`（2 秒）复查，再发【面板】消息开新一轮；同一进度最多 `nudgeMax` 次 |
| 同文件 `nudgeNoPlan`（收尾自检）                                                                         | 顶层、子对话   | 没计划、这一轮动手 ≥ 3 次，或新输入后零工具       | 同上，每条输入 1–2 次；门槛按单轮算，有漏洞（Bug 记录）                              |
| 同文件 `nudgeWrapUp`                                                                                     | 顶层（父对话） | 名下子对话请求了收尾，父对话没调 `finish_child`   | 同上                                                                                 |
| `server/tasks/merge.ts`（`nudgeMerge` / `stuckAfterNudge`）、`server/tasks/children.ts` 的 `reportChild` | 子对话         | 计划只剩收尾那步却没 `submit_merge`；推满了还不动 | 推子对话；推满后报父对话                                                             |
| `shared/helper-summary.ts` 的 `runWithSummary`                                                           | 子任务         | 这一轮结束了还没 `submit_result`                  | 在同一个会话里补问一次（`RESULT_ASK`），再不交就按「没交结果」交回                   |

这五处的判断依据都是结构化的，不读文字（`helper-summary.ts` 注释写明 2026-11-02 已改掉按「## 总结」判断）。问题只在**时机**：全部发生在 CLI 已经报这一轮结束之后。

### 2.2 残留的按文字判断

- **需要清理**：`shared/verdict.ts` 的 `parseVerdict` / `leadVerdict`，从输出里找「结论：通过 / 不通过」「Verdict: pass / fail」。只给旧版工作流节点（当时 legacy 快照里要求「最后一行写验收结论」的节点）和条件连线用；新节点已经用 `submit_verdict`。列入 P3，把旧节点迁到 `submit_verdict` 后删掉。
- **不算违规**（读的是面板自己写的固定前缀，不是模型回复）：`shared/peer-message.ts` 的 `【编译申请】`、`shared/task.ts` 的 `PLAN_NUDGE_HEAD`、`shared/collab-timeline.ts` 的 `PANEL_HEAD`。
- **不算违规**（读模型按约定输出的结构化代码块，块类型是固定标识，不是自然语言关键字）：`dispatch.ts`、`diagnosis.ts`、`lesson-review.ts` 等读 ` ```<固定语言名> ` 代码块。规则检查要把这类和「按关键字猜状态」区分开（§10.1）。

### 2.3 每轮已经装进 CLI 的东西（钩子可以直接复用）

- **面板工具通道**：`server/exec/invoke.ts` 调 `openAskBridge`，每轮生成 `/api/mcp/ask/<令牌>`。令牌在这一轮有效，`close` 之后作废（保活进程跨轮时是否沿用同一个令牌，实施时核对，见 §10.2）。钩子转发层用同一个令牌，面板就知道是哪个对话、哪个身份。路由和 MCP 一样不需要面板登录（`server/auth.ts` 已对 `/api/mcp/ask/` 放行），只认令牌。
- **Pi**：`shared/clis/pi.json` 的 `mcp.files` 每轮生成 `{dir}/agent-panel-{name}.ts` 并用 `-e` 加载（桥接面板工具）。`-e` 可以传多个（Pi 源码 `dist/cli/args.js` 按数组收）。
- **Command Code**：`--mod` 加载面板生成的 mod（`server/exec/prompt-lang-mod.ts`，现在只追加回复语言规则）。
- **Claude Code**：参数里已经带 `--append-system-prompt-file`、`--permission-prompt-tool stdio` 等。`--settings <JSON>` 可以再加一项，不碰用户的 `~/.claude/settings.json`。
- **Codex**：`app-server` 协议，`thread/start` / `thread/resume` 的参数里带 `overrides`（`server/exec/rpc/codex.ts`）。钩子能不能通过这里或 `-c` 传进去，要实测。

## 3. 各 CLI 的钩子能力（核对）

| CLI          | 结束前能不能拦 | 怎么做                                                                                                                                                                                                                                                                            | 工具前 / 工具后 / 上下文恢复                                                                                                  | 依据                                                                                                                                                                                    |
| ------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | 能             | `Stop` 钩子输出 `{"decision":"block","reason":"…"}`；输入有 `stop_hook_active`、`background_tasks`                                                                                                                                                                                | `PreToolUse`（`permissionDecision: deny`）、`PostToolUse`（`additionalContext`）、`SessionStart`（matcher `compact\|resume`） | 本机 2.1.318 + 模拟模型实测：同一轮里接着做，只出一个 result                                                                                                                            |
| Pi           | 能             | 扩展里 `pi.on('agent_before_settle', e => ({ entries: [...e.entries, { type: 'custom_message', customType: 'agent-panel-continue', content, display: false }], continue: true }))`；`outcome` 不是 `completed`（中止、出错）时不拦；`context.canContinue` 为 false 时 Pi 不会续跑 | `tool_call`（可拦）、`tool_result`、`session_compact`                                                                         | Pi 1.5.0 源码：`dist/core/agent-session.js` 的 `_runBeforeSettleBoundary`、`dist/core/extensions/types.d.ts` 的 `AgentBeforeSettleEvent`；Pi 没有内置次数上限，要面板计数               |
| Command Code | 能             | mod 里 `cmd.hooks({ onStop: ({ stopReason, turnNumber }) => ({ continue: true, reason }) })`，reason 作为一条自动的 `stop_hook` 用户回合；连续续跑上限 8 次；中止、`max_turns` 时不触发                                                                                           | `beforeToolCall`（`block`、`additionalContext`）、`afterToolCall`、`onSessionStart`                                           | 官方文档 commandcode.ai/docs/mods；另有 `settings.json` 的 shell 钩子，不用（要写用户 / 项目文件）                                                                                      |
| Codex        | 能（文档）     | `Stop` 输出 `decision: "block"` + `reason`，Codex 用 reason 生成继续的提示；输入有 `stop_hook_active`、`turn_id`                                                                                                                                                                  | `PreToolUse`、`PostToolUse`、`PostCompact`、`SessionStart`                                                                    | 官方文档 learn.chatgpt.com/docs/hooks；**待实测**：`app-server` 下怎么注入（`-c`、thread 的 overrides、单独的配置目录）、非托管钩子要 `/hooks` 信任或 `--dangerously-bypass-hook-trust` |

**回答用户的第 5 问（Pi）**：

- Pi 没有钩子配置文件，所有钩子都是扩展事件。官方推荐用 `agent_before_settle` + `continue: true` 做续跑，比 `agent_end` 合适：`agent_end` 的返回值没有作用，只能靠排队消息再开一次运行。
- **不用装第三方插件**。面板每轮已经通过 `-e` 自动加载自己的扩展，把处理加进去就行，跑完照旧删掉，不进用户的 `~/.pi/agent/extensions/`。
- 社区里有续跑类扩展：`pi-ralph-wiggum`、`pi-ralph-loop`、`pi-goal`、`pi-loop`、`pi-until-loop` 等。它们各自用自己的规则判断做没做完，有的就是按回复文字或定时重发，和面板的计划判断会冲突。所以**不自动安装，也不推荐**；检测到用户装了这类扩展时，在 CLI 设置里提示「可能和面板的续跑重复」。
- 注入的续跑消息在 `--mode rpc` 的输出里仍会出现（`role: "custom"`）。面板按 `customType: 'agent-panel-continue'` 认出来：不显示成用户消息，只在对话日志里记一行。
- **版本**：`agent_before_settle` 是较新的事件，CLI 定义要写最低版本（§4.2 的 `minVersion`）。版本不够的退回现有提醒。

## 4. 模块设计

### 4.1 面板事件

| 面板事件              | 含义                                                                 | 能做的决定                      |
| --------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `turn.beforeEnd`      | 模型准备结束这一轮                                                   | 放行 / 拦住（附下一步说明）     |
| `tool.before`         | 工具执行前                                                           | 放行 / 拒绝（附原因）/ 补充说明 |
| `tool.after`          | 工具返回后                                                           | 补充说明                        |
| `context.restored`    | 开局、续接、压缩上下文之后                                           | 补充说明                        |
| `prompt.beforeSubmit` | 输入交给模型前                                                       | 补充说明                        |
| `task.*`（面板事件）  | 对话完成、失败、等你回复、子对话请求收尾、计划某步完成、计划任务跑完 | 只通知                          |

- 前五个是 CLI 钩子，能影响这一轮。`task.*` 由面板自己发，只通知。
- 某个 CLI（或它的版本）不支持某个事件时，设置页标「不支持」，不假装生效。只有 `turn.beforeEnd` 有兜底，就是现在的事后提醒。

### 4.2 CLI 定义里的 `hooks` 字段（按字段走，不按名字分支）

```json
"hooks": {
  "minVersion": "2.1.0",
  "install": { "kind": "settingsArg", "args": ["--settings", "{hooksSettingsJson}"] },
  "events": {
    "turn.beforeEnd": { "native": "Stop", "loopFlag": "stop_hook_active", "block": { "decision": "block", "reason": "{reason}" } },
    "tool.before": { "native": "PreToolUse", "deny": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "{reason}" } } },
    "tool.after": { "native": "PostToolUse", "context": { "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": "{text}" } } },
    "context.restored": { "native": "SessionStart", "matcher": "compact|resume", "context": { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "{text}" } } }
  },
  "dropInput": ["last_assistant_message"],
  "toolNames": { "shell": ["Bash"], "edit": ["Edit", "Write", "MultiEdit", "NotebookEdit"], "read": ["Read", "Grep", "Glob"] },
  "streamEvents": { "hook_started": "log", "hook_response": "log" }
}
```

- `install.kind` 三种：
  - `settingsArg`：Claude Code，启动参数传 JSON。
  - `extension`：Pi 的 `-e`、Command Code 的 `--mod`。面板生成的源码里带上钩子处理，转发到面板。
  - `configOverride`：Codex，实测后定。
- `minVersion`：面板已有 `versionArgs` 能读 CLI 版本。低于最低版本就不装，退回提醒，设置页写明原因。
- `dropInput`：转发前丢掉的输入字段，回复文字不进面板（§0 第 3 条）。
- `toolNames`：各家工具名对照到面板的工具类别，用户钩子按类别匹配就能跨 CLI 通用。
- `streamEvents`：输出流里的钩子事件，只记日志，不显示成消息。Pi 的续跑消息按 `customType` 认，写在同一处。
- 接新 CLI 只加字段；`docs/cli-config.md` 的接入检查清单补一项「钩子」，`scripts/rules-check.mjs` 已有的「不按 CLI 名字分支」检查照样适用。

### 4.3 链路

```
CLI 原生钩子 / 面板扩展里的处理函数
  └─ 转发：POST /api/mcp/ask/<令牌>/hook   （Claude Code 用面板生成的 agent-panel-hook.mjs；Pi、Command Code 在扩展里直接发）
       体：{ event, native: <原生输入，已丢掉 dropInput 字段> }
       └─ 面板：按令牌找到这一轮（对话、身份、CLI）
            → 内置钩子 → 用户钩子（按顺序，按范围和匹配过滤）
            → 合并 → 按 CLI 定义翻成原生输出
```

- **失败一律放行**：
  - 令牌作废（这一轮结束、面板重启）、超时、返回格式错，都输出「不表态」。
  - 转发超时默认 5 秒；Claude Code 的钩子 `timeout` 设 15 秒，留余量。
  - 失败写对话日志和全局日志，不让钩子坏了把对话卡住。
- **合并规则**：
  - `turn.beforeEnd`：任一要拦就拦，说明按顺序拼接。
  - `tool.before`：任一拒绝就拒绝。
  - 补充说明按顺序拼接，总长有上限，超出部分转存文件、只留全文指针（ADR 0041 第 5 条）。
- **防死循环**：CLI 自带的保护全保留（Claude / Codex 的 `stop_hook_active`、Command Code 连续 8 次上限）。面板再叠 `DriveBudget`：同一进度最多 `nudgeMax` 次，同一条输入最多 `DRIVE_TOTAL_MAX` 次。Pi 没有内置上限，只靠面板这一层。拦满放行，照现在的做法留警告。
- **不装钩子的轮次**：压缩轮、原生审查轮、Chat 页只挂提问工具的轮次。判断看握手里声明的 `capabilities.experimental.orchestration`，和 Pi 桥接扩展核对工具清单的做法一致。

## 5. 内置的「结束前」判断（统一五处事后补救）

只看结构化状态；`server/tasks/drive.ts`、`merge.ts`、`helper-summary.ts` 现有的判断抽成一份，钩子和兜底提醒共用：

| 身份                           | 放行（在等 / 已交）                                                                                                    | 拦住                                                             | 说明文字（发给 Agent，不翻译）                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 所有身份                       | 在等提问回答、等子对话、后台命令在跑（Claude 另看输入里的 `background_tasks`）、有排着的输入（`hasHeld`）、中止 / 出错 | —                                                                | —                                                                            |
| 顶层 / 子对话，有计划          | 计划做完                                                                                                               | 计划没做完                                                       | 「计划第 N 步『…』还没做：直接调用工具去做，做完用 set_plan 标完成」         |
| 顶层 / 子对话，没计划          | 纯问答；本条输入还没动过手                                                                                             | 本条输入以来跑过命令、改过文件或读过不少文件，且这条输入还没拦过 | 收尾自检那句（按输入累计，修掉单轮门槛漏洞）                                 |
| 顶层（父对话）                 | —                                                                                                                      | 名下子对话请求收尾，还没 `finish_child`                          | 「子对话 X 请求收尾：调用 finish_child（id …）或 send_to_conversation 交回」 |
| 子对话                         | 已 `submit_merge`                                                                                                      | 计划只剩收尾那步，没 `submit_merge`                              | 「调用 submit_merge 请父对话收尾」                                           |
| 子任务                         | 已 `submit_result`                                                                                                     | 没交                                                             | `RESULT_ASK` 原句                                                            |
| 评审类子任务 / 节点            | 已 `submit_verdict`                                                                                                    | 没交                                                             | 「调用 submit_verdict 交结论」                                               |
| 旧工作流节点（按文字给结论的） | 一律放行                                                                                                               | —                                                                | 不拦：拦它就得读文字，迁到 `submit_verdict` 之后再纳入                       |

- 拦住发生在 CLI 内部，对话里不新增消息。
- 对话日志写「结束前钩子：拦住 / 放行、原因、第几次」。界面在这一轮结尾放一个小标记，例如「面板让它接着做了 1 次」，点开看原因，替代【面板】气泡。
- 设置里的 `nudgeMax`（提醒次数）说明文字要改成「拦住 / 提醒最多几次」。

## 6. 钩子规范（用户钩子和 AI 生成的钩子都按它）

### 6.1 定义（zod，放 `shared/` 下新文件 hooks.ts）

```ts
const HookDef = z.object({
  id: z.string(), // 面板生成
  name: z.string().min(1).max(60),
  description: z.string().max(300).default(''),
  event: z.enum([
    'turn.beforeEnd',
    'tool.before',
    'tool.after',
    'context.restored',
    'prompt.beforeSubmit',
    'task.done',
    'task.failed',
    'task.waitingUser',
    'task.wrapRequested',
    'plan.stepDone',
  ]),
  scope: z.object({
    projects: z.array(z.string()).default([]),
    agents: z.array(z.string()).default([]),
    clis: z.array(z.string()).default([]),
  }), // 空 = 全部
  match: z
    .object({
      toolKind: z.enum(['shell', 'edit', 'read', 'panel', 'any']).default('any'),
      pathGlob: z.string().default(''),
      commandPrefix: z.string().default(''),
    })
    .optional(), // 只对 tool.*
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('command'), script: z.string().max(20000), runtime: z.enum(['node']).default('node') }), // 脚本存数据目录 hooks/scripts/<id>.mjs
    z.object({
      type: z.literal('http'),
      url: z.string().url(),
      headers: z.array(z.object({ key: z.string(), env: z.string() })).default([]),
    }), // 头的值只能引用环境变量
  ]),
  timeoutSec: z.number().int().min(1).max(60).default(5),
  onError: z.enum(['allow', 'deny']).default('allow'), // deny 只对 tool.before 有效
  enabled: z.boolean().default(false),
  createdBy: z.enum(['user', 'ai']).default('user'),
})
```

### 6.2 输入、输出（面板统一格式，与 CLI 无关）

- **输入**：`{ event, task: { id, title, mode, role }, project: { id, path }, cli, tool?: { kind, name, input }, result?: { ok, output 截断 + 全文路径 }, plan?: { done, total, current } }`。
  - 不含回复文字。
  - 不含凭据：环境变量里的密钥不放进 JSON。
- **输出**：
  - 空或 `{}`：不表态。
  - `{ "block": true, "reason": "…" }`：只对 `turn.beforeEnd`。
  - `{ "deny": true, "reason": "…" }`：只对 `tool.before`。
  - `{ "context": "…" }`：只对 `tool.after`、`context.restored`、`prompt.beforeSubmit`。
  - 超出事件允许范围的字段算格式错，按 `onError` 处理并在触发记录里写明。
- 用户钩子也要遵守硬规则：规范里不提供回复文字，所以用户钩子也没法按文字判断。

### 6.3 校验（保存前必须全部通过）

1. zod 校验通过；事件和 `match` 搭配合法（`match` 只给 `tool.*`）。
2. 脚本静态检查：
   - 不能有疑似真实密钥（复用 `scripts/secret-check.mjs` 的规则）。
   - 不能写死绝对路径的用户数据目录。
   - 用 `node --check` 做语法检查。
3. 试跑：用这个事件的示例输入在沙箱目录跑一次（超时照设置），输出符合 §6.2。
4. 范围里的 CLI 都支持这个事件（§4.2）；不支持的列出来，用户确认后才能保存。

## 7. AI 创建钩子

- **入口**：设置 →「钩子」页的「AI 创建」按钮，以及每条钩子上的「让 AI 改写」。复用现有的 AI 辅助对话框（`web/src/components/assist/AssistDialog.tsx`，角色、工作流、Skill、测试步骤都在用），新增一种辅助类型 `hook`。
- **提示词**：`shared/assist.ts` 已近行数上限（1351 / 1400），钩子的提示词、规范说明和提案格式放 `shared/` 下的新文件（例如 assist-hook.ts），`assist.ts` 只加一行分派。提示词带上：
  - §6 的完整规范和每个事件的示例输入；
  - 各 CLI 对事件的支持矩阵；
  - 2–3 个范例（只读守卫、改完格式化、提交前扫密钥）；
  - 硬规则：不能按回复文字判断；命令里不写密钥，要凭据就引用环境变量；判断失败时不表态。
- **提案**：AI 交一个结构化提案（钩子定义 + 脚本源码）。对话框显示：
  - 字段预览、脚本高亮；
  - 「这个钩子会在什么时候触发、会拦什么」的说明，由面板按定义生成，不让 AI 自己写；
  - 校验结果（§6.3 逐项）。
- **保存**：校验和试跑全部通过才出「保存」按钮。保存后 `enabled: false`、`createdBy: 'ai'`，由用户在列表里自己打开。改写已有钩子时显示改前改后的差异。
- **演示模式**：`web/src/lib/demo-assist.ts` 补 `hook` 类型的模拟提案；正式包不带演示内容（`scripts/package.mjs` 会查）。

## 8. 设置页「钩子」

新文件 HooksSection.tsx（放 `web/src/components/settings/` 下，挂在设置导航「集成」附近）：

- **内置钩子**：
  - 「没做完不收尾」「压缩后补回计划」「只读身份守卫」「临时文件位置守卫」「改文件前推送教训」。
  - 每条显示事件、对哪些 CLI 生效（不支持或版本不够的灰掉并写原因）、开关。
  - 不能删、不能改逻辑。
- **我的钩子**：
  - 列表：名称、事件、范围、动作类型、开关、最近一次结果。
  - 操作：新建、AI 创建、编辑、复制、删除、拖动排序。
- **测试**：选事件、可改示例输入，跑一次，显示原始输出和面板合并后的决定，不需要开对话。
- **最近触发**：最近 50 次（事件、对话、钩子、结果、耗时、失败原因），点进去跳到对话日志。
- **对话诊断**：列出这一轮触发过的钩子，排查「为什么没停 / 为什么停了」。
- 文案用 `t()`，英文同一提交写进 `shared/locales/en/`；风格按 `docs/lessons/ui.md`；界面检查加一个分片。

## 9. 还有哪些适合做成钩子

### 9.1 建议做成内置

| 钩子             | 事件                                | 现在怎么做                                                                                               | 好处                                                                                                      | 默认 | 期  |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- | --- |
| 没做完不收尾     | `turn.beforeEnd`                    | §2.1 的五处事后补救                                                                                      | 同一轮里接着做，没有提醒气泡，不会被 2 秒复查窗口里的插话、回收打断                                       | 开   | P1  |
| 压缩后补回计划   | `context.restored`                  | 没有：压缩后只剩摘要，常忘了计划进度、派单的验收标准                                                     | 自动补一段「当前计划和进度、派单目标和验收、在等什么、全文在哪」                                          | 开   | P2  |
| 只读身份守卫     | `tool.before`                       | 只靠角色设定写「不改文件、不提交」（`shared/builtin/agents.ts` 第 642、1431 行附近），违反了只能事后发现 | 只读身份调用写文件、`git commit` / `push`、装依赖时直接拒绝并说明。按工具类别和命令前缀判断，不看回复文字 | 开   | P2  |
| 临时文件位置守卫 | `tool.before`                       | `AGENTS.md` 硬规则，只靠提示词                                                                           | 写盘符根目录、其他项目、数据目录时拒绝，说明该写到哪                                                      | 关   | P2  |
| 改文件前推送教训 | `tool.before`（每个文件第一次编辑） | 让模型自己跑 `node scripts/lessons.mjs <文件>`，经常忘                                                   | 自动把相关踩坑记录补给模型；项目没有教训文件就不触发                                                      | 关   | P2  |
| 对话事件通知     | `task.*`                            | 只有计划任务有 Webhook（`server/webhook.ts`），设置里的 Webhook 通知另一套                               | 完成、失败、等你回复、请求收尾都能通知；Webhook 变成钩子的一种动作，老配置自动迁移                        | —    | P3  |

### 9.2 给用户钩子当范例，不做成内置

- 改完文件后格式化、行数上限检查（`tool.after`）：和项目工具链绑定。
- 提交前扫密钥（`tool.before`，命令前缀 `git commit`）：仓库已有 `secret-check`，用户按项目挂。
- 危险命令拦截（`rm -rf /`、`git push --force` 到主干）：各人习惯不同，放范例。

### 9.3 不改成钩子

- **审批**：已走 `--permission-prompt-tool stdio` 的控制消息，有界面有记录。
- **`docsFirst` 门禁**：拦的是面板自己的 MCP 工具，在面板里拦更直接。
- **工作流节点的开始 / 验收 / 结束**：那是「挂一个流程」，不是事件处理。名字统一叫「节点的开始 / 验收 / 结束流程」，免得和钩子混淆。
- **按回复文字判断任何状态**：明确禁止。

## 10. v1 遗漏、这次补上的点

### 10.1 规则和文档

- **硬规则**：`AGENTS.md` 加「不根据模型回复的文字判断状态：做没做完、通没通过、卡没卡住，都只看工具调用和面板状态」。
- **规则检查**：`scripts/rules-check.mjs` 加一条，在 `server/tasks/`、server 下新的 hooks 目录、`shared/drive*.ts`、`shared/task.ts` 等判断状态的文件里，禁止对消息的 `text` 用正则或 `includes` 匹配中文 / 英文关键字。
  - 放行：面板自己的固定前缀常量、` ```<固定语言名> ` 结构化代码块。
  - 豁免：`shared/verdict.ts` 加 `rules-ok` 标注并写明「P3 删除」。
- **ADR**：
  - 新写一份「钩子模块与同轮续跑」；修订 ADR 0041 第 1、3 节，把事后提醒降为兜底。
  - `docs/cli-config.md` 接入清单加「钩子」一项。
  - `docs/modules/server/README.md` 和新的钩子模块文档按模块文档格式写，跑 `npm run docs:modules`。

### 10.2 运行细节

- **保活进程**：一个保活进程跨多轮，钩子在启动时装好就不会再换，所以令牌要跟进程走。`openAskBridge` 的注释写的是「这一轮结束时 close」，实施时要核对保活进程的令牌是不是跨轮沿用；不是的话，钩子按进程另发一个令牌，每轮把它指到当前这一轮。进程被回收后令牌作废，钩子自然放行。
- **用户自己的钩子共存**：Claude Code 会合并 `~/.claude/settings.json` 和项目设置里的钩子，用户自己的 Stop 钩子也会跑，任一拦住就续跑。设置页提示「检测到你在 Claude Code 里配置了 Stop 钩子，可能和面板重复」。Pi、Command Code 同理，提示用户装的续跑类扩展 / mod。
- **Windows**：Claude Code 钩子命令写成 `node "<路径>"`，路径用正斜杠、加引号，避开空格和反斜杠转义。在 WSL 和 Windows 正式包上各验一次。
- **版本**：按 `minVersion` 判断，低版本退回提醒；CLI 升级后下一轮自动装上。
- **插话 / 排队输入**：有排着的输入时一律放行，让 CLI 正常结束这一轮、交下一条输入，不和插话抢。
- **中止**：用户点停止时 CLI 不触发结束前钩子（Claude 中断、Pi `outcome !== completed`、Command Code 的 `interrupted`）。面板这边再判一次 `haltedBy`，停了就放行。
- **面板重启**：令牌作废，钩子放行；重启后没做完的对话照旧由「重启后继续」名单接手。
- **生命周期诊断**：`shared/lifecycle.ts` 的 `wrapup-unhandled` 这类异常要把「钩子拦过几次」算进去，不然会把正在被钩子推着走的对话误报成停住。
- **按模型统计**：记下每个模型被拦的次数和拦住后真去做了的比例，显示在模型设置里，方便判断哪个模型「只说不做」严重（ADR 0041 已提过这个需求）。

### 10.3 数据、演示、测试设施

- **数据**：用户钩子存数据目录 `hooks.json`，脚本存 `hooks/scripts/`。纳入「数据」页的备份和导出；导出时脚本原样带上，环境变量引用不展开。
- **演示模式**：`web/src/lib/demo-*.ts` 补钩子的模拟接口。
- **假 CLI**：`scripts/fake-cli/fake-cli.mjs` 加「钩子模式」，模拟 CLI 在结束前调转发、按回答续跑或结束，三种装入方式各一个场景。
- **行数上限**：`server/tasks/drive.ts`、`server/exec/runner.ts`、`shared/assist.ts`、`AssistDialog.tsx` 都接近上限，新逻辑放新文件（`server/` 下新的 hooks 目录，`shared/` 下新的 hooks.ts、assist-hook.ts），原文件只加调用。

## 11. 分期

- **P1：同轮续跑**
  - 模块骨架：`shared/` 下新文件 hooks.ts（事件、定义、合并）、`server/` 下新目录 hooks（转发路由挂在 `/api/mcp/ask/<令牌>/hook`、处理链、日志）、CLI 定义的 `hooks` 字段和校验。
  - 结束前判断抽成一份（§5），三家接入：Claude Code（`--settings`）、Pi（桥接扩展加 `agent_before_settle`）、Command Code（mod 加 `onStop`）。Codex 照旧提醒，同时修掉门槛漏洞。
  - 界面的小标记、对话日志、诊断、`nudgeMax` 文案。
  - ADR、`AGENTS.md` 硬规则、rules-check 新规则。
- **P2：管理和更多事件**
  - 设置页、用户钩子（命令 / HTTP）、规范校验、试跑、最近触发。
  - AI 创建（`hook` 辅助类型）。
  - 三家的 `tool.before`、`tool.after`、`context.restored`，以及 §9.1 的四个内置钩子。
- **P3：补齐**
  - Codex 实测装入方式和信任，通过后接入。
  - 面板事件 `task.*`，Webhook 并入。
  - 旧工作流节点迁到 `submit_verdict`，删掉 `verdict.ts` 的按文字判断。

## 12. 测试

- **单测**：
  - §5 的判断表逐行（每个身份 × 放行 / 拦住）。
  - 合并规则、预算、失败放行、截断留指针。
  - CLI 定义的 `hooks` 字段校验：声明的每个事件都要有原生名和输出模板。
  - §6 规范的 zod 和静态检查。
  - rules-check 新规则的正反例。
- **e2e**：
  - 假 CLI 的钩子模式：同一轮续跑、对话里没有【面板】消息、拦满留警告、令牌作废放行、有插话时放行。
  - 设置页新建 / AI 创建（演示模式的模拟提案）/ 试跑 / 开关。
- **冒烟（可选）**：真 CLI + 本地模拟模型（Bug 记录里那次实测的做法），机器上装了对应 CLI 才跑。新脚本放 `scripts/` 下（例如 hook-smoke.mjs），CI 里没有 CLI 就跳过。
- **界面检查**：设置页「钩子」加一个分片。

## 13. 待确认和风险

- **待用户确认**：
  1. Chat 页（一问一答）要不要装结束前钩子：建议只做「没计划」那一档的一次自检，或者不装。
  2. 拦住时界面上的小标记：建议显示，点开看原因。
  3. 内置钩子默认开关：建议按 §9.1 的「默认」列。
  4. AI 生成的钩子保存后默认关闭：建议这样，由用户自己打开。
- **待实测**：
  - Codex 在 `app-server` 下怎么注入钩子、要不要信任。
  - Command Code mod 的 `onStop` 在面板用的版本上可用（文档确认，未实机）。
  - Pi `agent_before_settle` 的最低版本号。
- **风险**：
  - 每次结束多一次本机 HTTP 往返（毫秒级）。
  - 内置判断出错会让对话停不下来，靠预算上限、中止放行、失败放行兜住。
  - 用户钩子执行任意代码，只认设置页里建的；脚本做密钥检查；AI 生成的默认关闭。

## 参考

- Claude Code 钩子：本机 2.1.318 实测，见 `docs/modules/server/bugs/coordinator-stops-after-announcing.md`
- Pi 1.5.0 源码：`dist/core/agent-session.js` 的 `_runBeforeSettleBoundary`、`dist/core/extensions/types.d.ts` 的 `AgentBeforeSettleEvent`、Pi 包里的 docs/extensions.md（`agent_before_settle` 示例）
- Command Code mods：https://commandcode.ai/docs/mods ；hooks：https://commandcode.ai/docs/hooks/reference
- Codex hooks：https://learn.chatgpt.com/docs/hooks
- Pi 社区续跑扩展（只看了描述）：https://github.com/tmustier/pi-extensions 、https://github.com/lnilluv/pi-ralph-loop 、https://github.com/schovest/pi-package-mono
