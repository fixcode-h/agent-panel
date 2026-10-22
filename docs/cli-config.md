# 接入新的 CLI：配置文件格式

面板按一份 JSON 配置调用 CLI：命令和参数怎么拼、输出怎么解析、支持哪些能力、Skill 和项目说明文件在哪。
接入一个新的 CLI 只要写一份配置，不用改代码。

- **自己用**：把配置放进数据目录的 `config/clis/`（默认 `~/.agent-panel/config/clis/`，文件名随意，以 `.json` 结尾），
  到「设置 · CLI」底部点「重新读取」。写错的地方会显示在那里。
- **内置到面板**：放在仓库的 `shared/clis/` 下，在 `shared/clis.ts` 的 `BUILTIN_SPECS` 里引入，
  界面文案的英文写进配置的 `i18n.en`（或 `shared/locales/en/`），再给 `scripts/fake-cli` 和 `server/exec/fixtures/` 补上样本和测试。

前提：CLI 要有**结构化输出**。一次性执行的 CLI 用非交互模式（任务描述从 stdin 读，跑完就退出）；有常驻双向协议的 CLI 把 `protocol` 写成 `rpc`，
按下面的 `rpc` 配置握手、开始一轮、插话和判断结束。Claude Code、Codex 的协议差别较大，走内置的 `codex` / `claude` 适配器（同样经过统一的 RPC 会话引擎），
其余标准的 JSON-RPC 或按 `type` 区分的记录流只写配置就能接。Command Code、Gemini CLI、Pi 的配置可以直接参考
[`shared/clis/commandcode.json`](../shared/clis/commandcode.json)、[`shared/clis/gemini.json`](../shared/clis/gemini.json)、[`shared/clis/pi.json`](../shared/clis/pi.json)。

## 接入检查清单

接新 CLI（或给已有 CLI 加一种能力）时逐项过一遍，漏掉的项以前都返工过（见 [lessons/cli.md](./lessons/cli.md)）：

1. **思考强度**：CLI 支持哪几档写进 `efforts`；强度由模型决定的写 `effortsFromModel`；会话中途不能换的写 `effortBoundSession`；
   `tiers` 三档各配好默认的模型和强度。不要在代码里按 CLI 名字补档位。
2. **模型**：模型从哪读（`modelsFrom` 或内置列表），上下文和最大输出能不能从 CLI 拿到，拿不到的补进[模型目录](./model-catalog.md)。
3. **写回 CLI 自己的配置**（`auth.api.edits`）：CLI 靠模型条目判断能力时，配上 `modelEfforts` / `modelReasoning` / `modelDefaultEffort` / `modelLimits`，
   写完用 CLI 自己的列表或界面核对能选几档。
4. **参数和协议**：`args` 覆盖 model、effort、permission、resume、fork；常驻协议的握手、插话、中断、结束判断都有。
5. **能力** `features`：压缩、自动压缩、分叉、插话（`steer` 或 `notes`）、「/命令」，按 CLI 实际支持的写，不支持的面板会走兜底做法。
6. **测试**：`scripts/fake-cli` 能模拟它（含 RPC 多轮），`server/exec/fixtures/` 录一段真实输出并加解析测试。
7. **文案**：界面上的名字、说明的英文写进 `i18n.en`。新加的字段登记进本文档的表格，并回头看已有的 CLI 要不要填。

## 字段

| 字段                              | 说明                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                              | 唯一标识，小写字母、数字和 `-`，写进设置和 Agent 配置里，定了就别改                                                                                     |
| `name`                            | 界面上显示的名字                                                                                                                                        |
| `command`                         | 可执行文件名（设置里可以改成完整路径）                                                                                                                  |
| `versionArgs`                     | 检测是否安装、显示版本用的参数，默认 `["--version"]`                                                                                                    |
| `npmPackage` / `brew` / `docsUrl` | 设置里的安装、卸载、更新和文档链接                                                                                                                      |
| `npmRenameFrom`                   | 改名前用过的 npm 包名：安装新包前先卸掉旧的，否则两个包提供同一个命令时 npm 会报 `EEXIST`                                                               |
| `color`                           | 界面上的标识色                                                                                                                                          |
| `models`                          | 模型建议 `[{ "id", "label", "isDefault" }]`，用户也可以手填；上下文窗口、最大输出和思考强度按[模型目录](./model-catalog.md)识别                         |
| `efforts`                         | 思考强度 `[{ "id", "label" }]`，不支持就不写                                                                                                            |
| `effortsFromModel`                | 思考强度跟着模型走：模型目录/配置里这个模型支持哪些就能选哪些；为 `true` 时不用 `efforts` 过滤                                                          |
| `effortBoundSession`              | 会话不支持中途换思考强度：换了强度也开新会话，把之前的对话带过去                                                                                        |
| `tiers`                           | 高、中、低三档默认的 `{ "model", "effort" }`                                                                                                            |
| `permissions`                     | 权限选项 `[{ "id", "label", "hint" }]`，`id` 会作为 `{permission}` 填进参数                                                                             |
| `defaultPermission`               | 默认权限，不写时用第一个                                                                                                                                |
| `readOnlyPermission`              | 只分析、不改文件时用的权限（例如优化项目说明）                                                                                                          |
| `args`                            | 参数规则，见下面                                                                                                                                        |
| `output`                          | 输出解析，见下面                                                                                                                                        |
| `systemPromptFlag`                | 追加系统提示词的参数（如 `--append-system-prompt`）；不写时角色说明拼进任务描述                                                                         |
| `features`                        | 能力，见下面                                                                                                                                            |
| `docs`                            | 项目里每次启动会读的说明文件（相对项目目录），第一个是还没有文件时新建的                                                                                |
| `docsNote`                        | 项目设置里说明文件那一页的说明                                                                                                                          |
| `globalDoc`                       | 用户目录里的全局说明文件（所有项目都读），设置的「部署」页往这里写；为空表示不支持                                                                      |
| `skills`                          | Skill 目录 `{ "user": ["~/.x/skills"], "repo": [".x/skills"] }`，每个子目录一个 `SKILL.md`                                                              |
| `commands`                        | 自定义命令目录 `{ "user", "repo", "format": "md" \| "toml", "prefix" }`，输入框打「/」时列出来                                                          |
| `envExample`                      | 设置里环境变量的示例                                                                                                                                    |
| `env`                             | 每次运行都加的环境变量 `{ "KEY": "VALUE" }`，用户在设置里写的同名变量优先（例如让无界面运行信任工作目录）                                               |
| `mcp`                             | 怎么把面板的工具（MCP）交给 CLI，见下面；不写时用不了 UI 设计的 AI                                                                                      |
| `options`                         | 设置里给用户的开关 `[{ "id", "label", "hint", "default", "env" }]`：打开时加上 `env`，参数规则里用条件 `opt.<id>` 判断（Pi 的「离线运行」「codemode」） |
| `packages`                        | CLI 自己的扩展包，设置里能装、删、更新，见下面「扩展包」                                                                                                |
| `i18n`                            | 界面文案的翻译 `{ "en": { "中文": "English" } }`                                                                                                        |

目录里的 `~` 是用户目录，`${ENV:-默认值}` 先取环境变量。

## 参数规则 `args`

按顺序检查每一条，条件都满足时加上 `args`；设置里的「额外参数」放在最后。任务描述走 stdin，不在参数里。

```json
"args": [
  { "args": ["--output-format", "stream-json"] },
  { "if": "model", "args": ["-m", "{model}"] },
  { "if": "permission=yolo", "args": ["--yolo"] },
  { "if": ["permission", "permission!=yolo"], "args": ["--approval-mode", "{permission}"] },
  { "if": "resume", "args": ["--resume", "{resume}"] },
  { "if": ["resume", "fork"], "args": ["--fork-session"] },
  { "if": "addDirs", "args": ["--include-directories", "{addDirs|,}"] },
  { "each": "addDirs", "args": ["--add-dir", "{item}"] },
  { "args": ["--max-turns", "{maxTurns:200}"] }
]
```

- 条件：`model` 有值、`!resume` 没值、`permission=yolo` 等于、`permission!=yolo` 不等于、`opt.codemode` 设置里这个开关开着；写成数组时全部满足才加。
  同一个参数只认最后一次的 CLI（例如 Pi 的 `--tools`），开关要和权限组合成几条规则，并进同一个值里。
- 能用的值：`model`、`effort`、`permission`、`resume`（续接的会话 id）、`fork`（要分叉会话）、`forkBefore`（`features.fork` 为 `before` 时要丢掉的第一轮的 id）、`systemPrompt`、`maxTurns`、`addDirs`（工作目录外还要读的目录，例如附件）。
- 占位：`{model}`；`{addDirs|,}` 把数组用逗号连起来；`{maxTurns:200}` 没值时用 200；`each` 对数组每一项加一次，`{item}` 是那一项。

## 常驻 RPC `protocol` / `rpc`

一次性执行的 CLI 不写 `protocol`（默认 `stdin`）。有常驻双向协议的写 `"protocol": "rpc"`，参数用 `rpcArgs`（不带 `-p`、`--output-format` 这类一次性参数），
协议本身写在 `rpc` 里。所有 RPC 走同一个会话引擎：stdin/stdout 上的 JSON 行、请求 id 配对、超时、插话、中断和收尾都一样。

```json
"protocol": "rpc",
"rpcArgs": [{ "args": ["--mode", "rpc"] }],
"rpc": {
  "start": [
    { "record": { "type": "get_state" }, "save": "state" },
    { "record": { "type": "prompt", "message": "{input}" }, "save": "prompt" }
  ],
  "steer": { "record": { "type": "steer", "message": "{text}" } },
  "interrupt": { "record": { "type": "abort" } },
  "sessionId": "state.data.sessionId",
  "remember": [{ "when": { "type": "message_end", "message.role": "assistant" }, "as": "assistant" }],
  "done": [
    {
      "when": { "type": "agent_settled" },
      "ok": ["assistant.message.stopReason != error", "$.aborted != true"],
      "error": "assistant.message.errorMessage"
    }
  ]
}
```

| 字段                                           | 说明                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                                         | `spec`（默认，按下面的配置执行）、`codex`、`claude`。后两个用内置适配器处理审批和控制消息                                                                                                                                                              |
| `jsonrpc`                                      | 发请求时带 `jsonrpc: "2.0"`（标准 JSON-RPC，例如 Command Code）                                                                                                                                                                                        |
| `handshake`                                    | 进程起来后按顺序发的消息，例如 `initialize` 和 `initialized`                                                                                                                                                                                           |
| `start` / `resume` / `fork`                    | 开始一轮；续接、分叉时换成对应的动作                                                                                                                                                                                                                   |
| `steer` / `interrupt` / `exit`                 | 插话、中断、这一轮结束前发的消息                                                                                                                                                                                                                       |
| `compact`                                      | 压缩上下文（`features.compact` 为 `native`）：续接会话后按顺序发，最后一个回复成功就算压缩完了，不发 `start`                                                                                                                                           |
| `after`                                        | 这一轮结束、交结果之前再发的请求，例如 Pi 的 `get_session_stats` 查准确的上下文占用；一般配 `optional`、`parse`                                                                                                                                        |
| `asks`                                         | CLI 发来的、要用户回答的请求（Pi 扩展的确认框、选择框），见下面「要用户回答的请求」                                                                                                                                                                    |
| `sessionId` / `turnId`                         | 从哪个 `save` 的回复的哪个字段取会话、轮次 id，例如 `init.result.session.id`；路径里的 `{路径}` 先换成存下的值，例如 Pi 的 `post.data.messages.{pre.data.messages.length}.entryId`（这一轮开始前有几条用户消息，结束后列表里那个位置就是这一轮自己的） |
| `unwrap`                                       | 事件外面包了一层时解开的路径，例如 `$.event`；Parser 自己能处理包装时不要写                                                                                                                                                                            |
| `remember`                                     | 记住某类记录，供 `done` 的条件使用                                                                                                                                                                                                                     |
| `done`                                         | 收到什么样的记录算这一轮结束；`ok` / `error` 是条件或路径，`$.` 开头取当前记录，其余取 `remember` 的记录                                                                                                                                               |
| `closeDelayMs`                                 | 结束后等多久再关 stdin；期间有新输出会取消（Claude Code 插话后用）                                                                                                                                                                                     |
| `defaultMaxTurns`                              | 没设置回合上限时传给 `{maxTurns}` 的默认值，0 表示不传                                                                                                                                                                                                 |
| `turnLimit`                                    | CLI 没有回合上限参数时由面板数：`{ "when": { "type": "turn_start" } }`，一次模型请求一条，超过设置里的回合上限就按 `interrupt` 停下，这一轮算失败并显示原因                                                                                            |
| `deferSteer`                                   | 插话要等 CLI 的下一个模型请求才取走：消息立刻进对话，等它开始下一次请求再把输出另起一条                                                                                                                                                                |
| `nativeAsk`                                    | 协议自己处理提问和审批，不挂面板的 MCP 提问工具                                                                                                                                                                                                        |
| `limitsQuery` / `skillsQuery` / `pluginSkills` | 能主动查额度、列 Skill、Skill 里包含已装插件                                                                                                                                                                                                           |
| `skillsDir`                                    | 列表走协议时，从哪个目录读用户 Skill；面板自带的 Skill 不按 CLI 安装，统一放在 `~/.agents/skills`                                                                                                                                                      |
| `queryArgs`                                    | 只查额度 / Skill、不跑任务时的启动参数，例如 Codex 的 `["app-server"]`                                                                                                                                                                                 |

一条消息的写法：

- JSON-RPC：`{ "method": "turn/start", "params": { "input": "{input}" } }`
- 记录流：`{ "record": { "type": "prompt", "message": "{input}" } }`
- `notify: true` 只发不等回复；`save` 把回复存起来给后面的字段和条件用；`if` 可以按 `resume`、`fork`、`model` 等条件跳过
- `optional: true` 失败了（回复报错、超时）也不影响这一轮；`parse: true` 把回复也交给输出映射（`output.events` 里按 `type`、`command` 认）
- 回复里的错误两种写法都认：JSON-RPC 的 `error.message`，记录流的 `success: false` 加一句 `error`（Pi）

占位符：`{input}`、`{text}`（插话内容）、`{model}`、`{effort}`、`{resume}`、`{maxTurns}`、`{cwd}`。整条就是占位、运行时又没有值时，这个字段不传。
命令行参数规则（`args` / `rpcArgs`）另外还能用 `{title}`：对话的标题，例如 Pi 的 `--name`，在 CLI 自己的会话列表里认得出是哪个对话。

### 要用户回答的请求 `asks`

带 `id` 和 `method` 的记录是 CLI 发来的请求。按 `when` 认出来的交给页面的提问卡片，用户的选择按模板回给 CLI；
没对上的请求当普通记录交给输出映射（例如 Pi 扩展的 `notify` 显示成一行提示，`setStatus` 这类不显示）。

```json
"asks": [
  {
    "when": { "type": "extension_ui_request", "method": "confirm" },
    "kind": "tool",
    "title": "$.title",
    "detail": "$.message",
    "allow": { "type": "extension_ui_response", "id": "{id}", "confirmed": true },
    "deny": { "type": "extension_ui_response", "id": "{id}", "confirmed": false }
  },
  {
    "when": { "type": "extension_ui_request", "method": "select" },
    "title": "$.title",
    "options": "$.options",
    "allow": { "type": "extension_ui_response", "id": "{id}", "value": "{answer}" },
    "deny": { "type": "extension_ui_response", "id": "{id}", "cancelled": true }
  }
]
```

`kind` 是卡片的样子（`command`、`file`、`tool` 是允许 / 拒绝，`question` 是选项或填写，默认 `question`）；
`title`、`detail`、`options` 写 `$.路径` 取请求里的字段；模板里 `{id}` 是请求的 id，`{answer}` 是用户选的或填的内容。
对话的「提问」开关关着时，问题类的请求直接按 `deny` 回，让 CLI 自己决定。

## 输出解析 `output`

内置解析器写名字（`"commandcode"`）；其他的写事件映射：按顺序找第一条 `when` 全部相等的规则，按 `emit` 产生面板的事件。

```json
"output": {
  "format": "ndjson",
  "events": [
    { "when": { "type": "init" }, "emit": [{ "type": "session", "id": "$.session_id" }, { "type": "usage", "model": "$.model" }] },
    { "when": { "type": "message", "role": "user" }, "emit": [] },
    { "when": { "type": "message", "delta": true }, "emit": [{ "type": "text_delta", "text": "$.content" }] },
    { "when": { "type": "tool_use" }, "emit": [{ "type": "tool", "name": "$.tool_name", "id": "$.tool_id", "input": "$.parameters" }] },
    { "when": { "type": "tool_result" }, "emit": [{ "type": "tool_result", "id": "$.tool_id", "output": "$.output", "failed": "$.status != success" }] },
    { "when": { "type": "result" }, "emit": [{ "type": "result", "ok": "$.status == success", "error": "$.error.message" }] }
  ]
}
```

`when` 的键也可以是 `a.b` 这样的路径（例如 Pi 的 `"assistantMessageEvent.type": "text_delta"`）。
`emit` 里的值：`$.a.b` 取事件里的字段（数组用 `-1` 取最后一项，如 `$.messages.-1.stopReason`），`$.a == x`、`$.a != x` 比较，其余是字面值。
同一轮里出现多个 `result` 时以最后一个为准。常驻 RPC 的结束条件写在 `rpc.done`，不靠 `result`：例如 Pi 以 `agent_settled` 结束，
`agent_end` 只是一个底层 agent 跑完了（后面可能还有自动重试、压缩、插话），配置里不映射它。面板认识的事件：

| 事件                  | 字段                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session`             | `id`：会话 id，继续对话时作为 `{resume}`                                                                                                                                                                                                               |
| `text_delta` / `text` | `text`：回复的一段（流式）/ 一整段                                                                                                                                                                                                                     |
| `thinking`            | `text`、`delta`                                                                                                                                                                                                                                        |
| `tool`                | `name`、`id`、`input`：按工具名认出读文件、改文件、跑命令、搜索、网页等，`input` 里的 `command`、`file_path`、`content`、`old_string`/`new_string` 会显示出来                                                                                          |
| `tool_result`         | `id`、`output`、`error`、`failed`                                                                                                                                                                                                                      |
| `usage`               | `context`、`window`、`model`、`addInput`、`addOutput`、`addCacheRead`、`addCacheWrite`、`addCost`                                                                                                                                                      |
| `error`               | `message`：只记下来，这一轮失败时一起显示                                                                                                                                                                                                              |
| `notice`              | 不影响结果、但用户应该看到的情况，显示成回复里的一行：`text`、`failed`；或者给 `kind` 由面板按界面语言拼文字：`retry`（`attempt`、`maxAttempts`、`delayMs`、`error`）、`retry_failed`（`attempt`、`error`）、`compact_failed`（`error`，为空时不显示） |
| `compacted`           | 压缩了上下文：`before`、`context` 是压缩前后的 token 数，两个都没有时不算压缩过（例如压缩失败）                                                                                                                                                        |
| `request_start`       | 开始一次模型请求：CLI 没有插话协议时，登记给 `read_user_notes` 的补充在它真正被读到时把输出另起一条（Command Code 用 `model_request_start`，Pi 用 `turn_start`）                                                                                       |
| `files_changed`       | 改了文件，面板去 git 里重新读改动                                                                                                                                                                                                                      |
| `result`              | `ok`、`error`：这一轮结束                                                                                                                                                                                                                              |

## 面板的工具 `mcp`

UI 设计的 AI 通过面板提供的工具（MCP，Streamable HTTP）改设计，没有提问通道的 CLI 也通过它向用户提问（`ask_user`）、
取用户在执行中补充的要求（`read_user_notes`，见 `features.notes`）。
对话的保活由面板自己做，不靠模型调用工具：一轮回复结束、对话页还开着时面板先不关进程，用户再发消息时
在同一个进程里开下一轮（常驻协议用 `turn/start`，面板不用结束再 `--resume`）。
切走对话页后有宽限（设置里的「离开对话后保留多久」，默认 60 分钟；环境变量 `AGENT_PANEL_PRESENCE_GRACE_MS` 优先，测试用），
过了宽限进程正常退出。`wait_user_message` 工具仍然提供，模型主动调用时这一轮不结束、等用户下一句；
但正常轮次不需要它，模型没调用也能保活。`tools/list` 里多了这个工具，不算插话协议。
打开一个已有会话的对话页不会启动 CLI：只有真正发消息时才按当前选择启动这一轮。
代价是第一条消息要等 CLI 启动和会话加载，换来的是「只是看一眼」不会在后台起一堆进程。
`args` 是加在命令行上的参数，`files` 是写进这一轮工作目录的配置文件（路径 → JSON 内容，用完还原）；内容是字符串时原样写成文本文件。
里面的 `{name}` 换成工具名（如 `design`），`{url}` 换成工具地址，`{dir}` 换成面板这一轮自己的临时目录（数据目录的 `cache/cli-run/` 下，绝对路径，用完删掉）。
路径以 `{dir}/` 开头的文件写进这个临时目录，不进用户的项目。文件写不成时（目录只读、被占用）参数也不加，这一轮没有面板的工具，
对话里会显示一行提示，但照常执行。

提问要一直等到用户回答，可能很久（用户不在电脑前）。这条请求面板用 SSE 流式响应，等待期间定期发心跳，
HTTP 客户端不会因为长时间没有数据而断开；CLI 自己的 MCP 请求超时还要在配置里放宽，否则等不到用户回答：

```json
"env": { "MCP_TOOL_TIMEOUT": "86400000" },
"mcp": {
  "files": {
    ".gemini/settings.json": { "mcpServers": { "{name}": { "httpUrl": "{url}", "timeout": 86400000 } } }
  }
}
```

Command Code 读环境变量 `MCP_TOOL_TIMEOUT`（毫秒），Gemini CLI 读 `mcpServers.<名字>.timeout`；Pi 的桥接脚本用 Node 自己的
http 客户端，没有这一步。

也可以写一个扩展做桥接：`shared/clis/pi.json` 把面板的工具交给 Pi 用的是一个扩展脚本 `{dir}/agent-panel-{name}.ts`，
启动时从 `{url}` 读工具列表，注册成 Pi 自己的工具（直接声明给模型），调用时转发过去，用 `-e` 按绝对路径加载。

Pi 1.3 自己也支持 MCP（`~/.pi/agent/mcp.json`，项目里的 `.pi/mcp.json` 要先信任项目），用户自己的 MCP 服务器通过 `mcpStore`
出现在「MCP 工具」页、写进 Pi 自己的 `mcp.json`。面板的工具仍然走扩展：Pi 的 MCP 工具默认是 `codemode` 暴露（不直接声明给模型），
而项目里的配置受「项目信任」管控，print / json / rpc 模式不会弹信任提示；`-e` 显式加载的扩展不受这两点影响。

## 能力 `features`

| 字段          | 说明                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact`     | 压缩上下文：`native` 走协议（常驻 RPC 的 `rpc.compact`，Pi 的 `compact` 命令，原地压缩、会话不变）；`slash` 发 `/compact`；`summary`（默认）让它写摘要，下一轮开新会话带上                                                                                                    |
| `modelSwitch` | 会话中途能换模型：对话里换了模型仍然续接原来的会话（Pi 的模型是每次启动的参数，会话里可以混用）；默认换模型就开新会话带上对话记录                                                                                                                                             |
| `fork`        | 分叉、撤回对话：`before` 能从任意一轮分叉（每轮记下自己的 id，见 `rpc.turnId`；续接原会话后按 `rpc.fork` 里带 `if: forkBefore` 的动作分叉到那一轮之前，Pi 是 `fork` 命令的 `entryId`）；`latest` 只能从最后分叉（配合 `fork` 条件的参数）；`none`（默认）带上对话记录开新会话 |
| `autoCompact` | 自动压缩：`env` 用环境变量 `autoCompactEnv` 告诉 CLI 百分比；`panel`（默认）面板在一轮结束后压缩                                                                                                                                                                              |
| `slash`       | 会话里认识「/命令」「/Skill」，原样发过去；默认面板把命令文件、Skill 展开成普通要求                                                                                                                                                                                           |
| `steer`       | 执行中能插话。常驻 RPC 在 `rpc.steer` 里写要发的消息；一次性输出的 CLI 用不了，改用下面的 `notes`                                                                                                                                                                             |
| `notes`       | 没有插话协议，但能用面板的 MCP 工具 `read_user_notes` 取执行中的补充（需要 `mcp`）：用户在它执行中发的要求直接记进对话、登记给它，模型取走时交给它；这一轮结束还没取走的，面板立刻开新一轮接着处理；对话页开着时还会挂 `wait_user_message`，回复完停在同一个进程里等下一句    |
| `limitEnv`    | 设置里三档模型手动改的上下文窗口、最大输出用哪个环境变量传给 CLI，如 `{"context": "X_MAX_CONTEXT", "maxOutput": "X_MAX_OUTPUT"}`；不写表示 CLI 不接受，界面上会说明                                                                                                           |
| `limitFile`   | 或者写进 CLI 的配置文件（账号方式下用；API 方式由 `auth.api.modelLimits` 写），只在这一轮里加上、结束后还原：`file`、`at`（`{provider}`、`{model}` 是模型 ID「provider/model」的两段，Pi 是 `providers.{provider}.modelOverrides.{model}`）、`context`、`maxOutput` 是键名    |

审批：非交互模式下 CLI 不能请用户确认，用权限选项控制它能做什么（参考 Gemini CLI 的 `--approval-mode`）。
Pi 本身没有审批，权限用 `--tools +grep,+find,+ls`（在默认工具上补搜索）加 `--exclude-tools` 去掉命令或写文件的工具；
不用 `--tools` 白名单，白名单会把面板桥接的工具（提问、编排）一起挡掉。用户装了带确认框的 Pi 扩展（例如 permission-gate）时，
确认框通过 `rpc.asks` 交给页面。

## 扩展包 `packages`

CLI 有自己的包管理（例如 `pi install`）时，设置的 CLI 页会多一组「扩展包」：

| 字段                   | 说明                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `file` / `key`         | 已装的包记在哪个 JSON 配置文件的哪个数组里，每项是来源字符串，或带 `source` 字段的对象；直接读，不跑命令 |
| `install` / `remove`   | 装、删的参数，`{source}` 是包的来源                                                                      |
| `update` / `updateAll` | 更新一个、全部更新的参数，不写就不显示按钮                                                               |
| `placeholder`          | 来源输入框的示例                                                                                         |

配置里相对路径的来源是相对配置文件写的，面板交给命令前换成绝对路径（Pi 从别的目录跑 `pi remove ../x` 会找不到）。命令的输出原样显示，失败时用户能看到原因。

## 凭据检查 `auth.check`

`{ "args": ["auth", "check", "--json", "--provider", "{provider}"] }`：设置的账号区按三档模型和默认模型里用到的提供方（模型 ID「provider/model」的前一段）
各跑一次，读输出 JSON 里的 `status`（等于 `ready` 的值算可以用）、`reason`、`authType`，字段名可以用同名的键改。

## 把 API 交给 CLI `auth.api`

设置里给 CLI 选了一个 API 后，面板在**保存设置时**就会按 `auth.api` 的规则写进 CLI 自己的配置（执行前还会再写一次，保证配置没被别的工具改掉）。
模型下拉只列这个 API 里配的模型，并按当前协议过滤后缀：`-anthropic`、`-responses`、`-chat`/`-completions`、`-gemini` 只显示对应协议的，不带后缀的通用模型所有协议都显示；换协议时同一个模型会自动换到对应后缀。

| 字段                       | 说明                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocols`                | 能接受哪些协议的 API                                                                                                                                                       |
| `defaultProvider`          | API 没有指定 provider 时，写进 CLI 配置的 provider 名，默认 `agentpanel`                                                                                                   |
| `modelSource`              | `api`（默认）用全局 API 的模型；`cli` 也从 CLI 读取这些模型的上下文和强度，但列表仍只保留 API 里配的模型                                                                   |
| `modelPrefix`              | 模型 ID 的 provider 前缀模板，例如 `{provider}/`；写进 provider 配置时会把重复的前缀去掉，执行旧的无前缀模型 ID 时会补上                                                   |
| `env` / `args`             | 只在 CLI 只能通过环境变量/参数接收 API 时用；能写配置文件的优先写 `edits`，执行时不再重复传 API 和密钥                                                                     |
| `edits`                    | 切到 API 时改的配置文件，保存设置时写；`format` 可以是 `json`（默认）、`toml`、`env`；`merge: true` 时对象递归合并，保留已有配置                                           |
| `accountEdits`             | 切回账号时还原的配置文件                                                                                                                                                   |
| `wire`                     | 协议在 CLI 配置里的写法，用 `{wire}` 引用                                                                                                                                  |
| `pruneProviders`           | API 方式下清掉同一地址和密钥的旧 provider，只留正在用的；不同接口的 provider 不动，不写不处理                                                                              |
| `pruneModels`              | API 方式下 provider 的 models 只保留 API 里配的模型，旧模型删掉；不写不处理                                                                                                |
| `modelEfforts`             | CLI 只认模型条目自己声明的强度时（Command Code 的 `reasoningEfforts`），按模型目录写回这个键；目录里没有的模型不动                                                         |
| `modelReasoning`           | CLI 只认模型条目自己声明的「能不能调思考强度」时（Pi 的 `reasoning` 是布尔），目录里有强度的模型写 `true`，下拉才不止一档                                                  |
| `modelReasoning.levelsKey` | 每档强度的取值表写进哪个键（Pi 的 `thinkingLevelMap`）：CLI 的每一档（关闭除外）模型支持写同名值、不支持写 `null`；Pi 不写这张表时不认 xhigh / max                         |
| `modelDefaultEffort`       | CLI 启动时按模型取默认强度的表（Pi `settings.json` 的 `modelThinkingLevels`）：`file`、`at`、`key`（如 `{provider}/{model}`）；写 API 设置里配的默认强度，没配用目录默认值 |
| `modelLimits`              | CLI 只认模型条目自己声明的上下文窗口时，按模型目录写回这个键；`maxOutputKey` 是最大输出写进哪个键，不写表示不接受                                                          |

已经能写配置文件的 CLI（Codex、Command Code、Pi、Claude Code、Gemini CLI）把 API 地址和密钥都写进各自的配置，执行时的 `env` / `args` 只留模型、思考强度和沙箱等运行参数。
`{provider}` 来自 API 的 `provider`：识别到的 API 用 CLI 配置里的键（例如 `providers.tokenapi` 的 `tokenapi`），新建的从 API 名称生成。
`{models}` / `{modelList}` 写进 provider 配置时会去掉模型 ID 上已有的 `{provider}/`，避免变成 `tokenapi/tokenapi/...`。

## 识别 CLI 自己配的 API `auth.apiSources`

设置 → CLI 里的「API 配置」页和各个 CLI 页会读各个 CLI 自己的环境变量和配置文件，把里面配好的接口地址、密钥和模型列出来，用户确认后存进全局的 API 列表，
别的 CLI 也能选用。读哪里写在 `auth.apiSources` 里，每一项是一个来源：

| 字段                   | 说明                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `file`                 | 配置文件；不写表示看环境变量（系统的加上设置里这个 CLI 的）                                   |
| `format`               | `json`（默认）、`toml` 或 `env`（`.env` 文件）                                                |
| `at` / `each`          | 配置所在的键（`a.b`）；`each` 为 `true` 时下面每个子键各是一个 API（例如 `providers.<名字>`） |
| `protocol` / `wire`    | 默认的协议，和「协议写法 → 协议」的对照；不写 `wire` 时用 `auth.api.wire` 反查                |
| `wireKey`              | 协议写法的键                                                                                  |
| `baseUrl`              | 接口地址的键，都没值时用 `defaultBaseUrl`                                                     |
| `apiKey` / `bearerKey` | 密钥的键；`bearerKey` 的用 `Authorization: Bearer` 发                                         |
| `keyEnv`               | 值是环境变量名的键（例如 Codex 的 `env_key`）                                                 |
| `models` / `name`      | 模型（字符串、数组、`[{ "id" }]` 或以模型名为键的对象都认）和名字的键                         |

键都按顺序取第一个有值的；值写成 `$NAME`、`${NAME}`，或正好是一个设置了的环境变量名时取那个环境变量。面板自己写进去的 `agentpanel` 不算。
