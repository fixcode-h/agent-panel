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

## 字段

| 字段                              | 说明                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`                              | 唯一标识，小写字母、数字和 `-`，写进设置和 Agent 配置里，定了就别改                                                             |
| `name`                            | 界面上显示的名字                                                                                                                |
| `command`                         | 可执行文件名（设置里可以改成完整路径）                                                                                          |
| `versionArgs`                     | 检测是否安装、显示版本用的参数，默认 `["--version"]`                                                                            |
| `npmPackage` / `brew` / `docsUrl` | 设置里的安装、卸载、更新和文档链接                                                                                              |
| `color`                           | 界面上的标识色                                                                                                                  |
| `models`                          | 模型建议 `[{ "id", "label", "isDefault" }]`，用户也可以手填；上下文窗口、最大输出和思考强度按[模型目录](./model-catalog.md)识别 |
| `efforts`                         | 思考强度 `[{ "id", "label" }]`，不支持就不写                                                                                    |
| `tiers`                           | 高、中、低三档默认的 `{ "model", "effort" }`                                                                                    |
| `permissions`                     | 权限选项 `[{ "id", "label", "hint" }]`，`id` 会作为 `{permission}` 填进参数                                                     |
| `defaultPermission`               | 默认权限，不写时用第一个                                                                                                        |
| `readOnlyPermission`              | 只分析、不改文件时用的权限（例如优化项目说明）                                                                                  |
| `args`                            | 参数规则，见下面                                                                                                                |
| `output`                          | 输出解析，见下面                                                                                                                |
| `systemPromptFlag`                | 追加系统提示词的参数（如 `--append-system-prompt`）；不写时角色说明拼进任务描述                                                 |
| `features`                        | 能力，见下面                                                                                                                    |
| `docs`                            | 项目里每次启动会读的说明文件（相对项目目录），第一个是还没有文件时新建的                                                        |
| `docsNote`                        | 项目设置里说明文件那一页的说明                                                                                                  |
| `globalDoc`                       | 用户目录里的全局说明文件（所有项目都读），设置的「部署」页往这里写；为空表示不支持                                              |
| `skills`                          | Skill 目录 `{ "user": ["~/.x/skills"], "repo": [".x/skills"] }`，每个子目录一个 `SKILL.md`                                      |
| `commands`                        | 自定义命令目录 `{ "user", "repo", "format": "md" \| "toml", "prefix" }`，输入框打「/」时列出来                                  |
| `envExample`                      | 设置里环境变量的示例                                                                                                            |
| `env`                             | 每次运行都加的环境变量 `{ "KEY": "VALUE" }`，用户在设置里写的同名变量优先（例如让无界面运行信任工作目录）                       |
| `mcp`                             | 怎么把面板的工具（MCP）交给 CLI，见下面；不写时用不了 UI 设计的 AI                                                              |
| `i18n`                            | 界面文案的翻译 `{ "en": { "中文": "English" } }`                                                                                |

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

- 条件：`model` 有值、`!resume` 没值、`permission=yolo` 等于、`permission!=yolo` 不等于；写成数组时全部满足才加。
- 能用的值：`model`、`effort`、`permission`、`resume`（续接的会话 id）、`fork`（要分叉会话）、`systemPrompt`、`maxTurns`、`addDirs`（工作目录外还要读的目录，例如附件）。
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

| 字段                                           | 说明                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `kind`                                         | `spec`（默认，按下面的配置执行）、`codex`、`claude`。后两个用内置适配器处理审批和控制消息                |
| `jsonrpc`                                      | 发请求时带 `jsonrpc: "2.0"`（标准 JSON-RPC，例如 Command Code）                                          |
| `handshake`                                    | 进程起来后按顺序发的消息，例如 `initialize` 和 `initialized`                                             |
| `start` / `resume` / `fork`                    | 开始一轮；续接、分叉时换成对应的动作                                                                     |
| `steer` / `interrupt` / `exit`                 | 插话、中断、这一轮结束前发的消息                                                                         |
| `sessionId` / `turnId`                         | 从哪个 `save` 的回复的哪个字段取会话、轮次 id，例如 `init.result.session.id`                             |
| `unwrap`                                       | 事件外面包了一层时解开的路径，例如 `$.event`；Parser 自己能处理包装时不要写                              |
| `remember`                                     | 记住某类记录，供 `done` 的条件使用                                                                       |
| `done`                                         | 收到什么样的记录算这一轮结束；`ok` / `error` 是条件或路径，`$.` 开头取当前记录，其余取 `remember` 的记录 |
| `closeDelayMs`                                 | 结束后等多久再关 stdin；期间有新输出会取消（Claude Code 插话后用）                                       |
| `defaultMaxTurns`                              | 没设置回合上限时传给 `{maxTurns}` 的默认值，0 表示不传                                                   |
| `deferSteer`                                   | 插话要等 CLI 的下一个模型请求才取走，页面上先显示「待取走」                                              |
| `nativeAsk`                                    | 协议自己处理提问和审批，不挂面板的 MCP 提问工具                                                          |
| `limitsQuery` / `skillsQuery` / `pluginSkills` | 能主动查额度、列 Skill、Skill 里包含已装插件                                                             |
| `skillsDir`                                    | 列表走协议时，内置 Skill 装到哪个目录                                                                    |
| `queryArgs`                                    | 只查额度 / Skill、不跑任务时的启动参数，例如 Codex 的 `["app-server"]`                                   |

一条消息的写法：

- JSON-RPC：`{ "method": "turn/start", "params": { "input": "{input}" } }`
- 记录流：`{ "record": { "type": "prompt", "message": "{input}" } }`
- `notify: true` 只发不等回复；`save` 把回复存起来给后面的字段和条件用；`if` 可以按 `resume`、`fork`、`model` 等条件跳过

占位符：`{input}`、`{text}`（插话内容）、`{model}`、`{effort}`、`{resume}`、`{maxTurns}`、`{cwd}`。整条就是占位、运行时又没有值时，这个字段不传。

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
同一轮里出现多个 `result` 时以最后一个为准（例如 Pi 自动重试时每次都有 `agent_end`）。面板认识的事件：

| 事件                  | 字段                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`             | `id`：会话 id，继续对话时作为 `{resume}`                                                                                                                      |
| `text_delta` / `text` | `text`：回复的一段（流式）/ 一整段                                                                                                                            |
| `thinking`            | `text`、`delta`                                                                                                                                               |
| `tool`                | `name`、`id`、`input`：按工具名认出读文件、改文件、跑命令、搜索、网页等，`input` 里的 `command`、`file_path`、`content`、`old_string`/`new_string` 会显示出来 |
| `tool_result`         | `id`、`output`、`error`、`failed`                                                                                                                             |
| `usage`               | `context`、`window`、`model`、`addInput`、`addOutput`、`addCacheRead`、`addCacheWrite`、`addCost`                                                             |
| `error`               | `message`                                                                                                                                                     |
| `request_start`       | 开始一次模型请求：插话排进队列时，用它把「待取走」的补充移到正文（Command Code 用 `model_request_start`，Pi 用 `turn_start`）                                 |
| `files_changed`       | 改了文件，面板去 git 里重新读改动                                                                                                                             |
| `result`              | `ok`、`error`：这一轮结束                                                                                                                                     |

## 面板的工具 `mcp`

UI 设计的 AI 通过面板提供的工具（MCP，Streamable HTTP）改设计，没有提问通道的 CLI 也通过它向用户提问（`ask_user`）、
取用户在执行中补充的要求（`read_user_notes`，见 `features.notes`）、在对话页开着时停在 `wait_user_message` 上等下一句。
最后一类只在 `features.notes` 的对话任务里挂上：模型回复完调用它，进程不退出；用户再发消息时面板把内容作为工具结果交回同一个进程，
不用结束再 `--resume`。切走对话页后有 1 分钟宽限（`AGENT_PANEL_PRESENCE_GRACE_MS` 可改），过了宽限工具返回「用户已经离开了这个对话」，
模型结束这一轮、进程正常退出。`tools/list` 里多了这个工具，不算插话协议。
打开一个已有会话的对话页时，面板会先在后台用 `--resume` 启动一次（合成一句「只调用 wait_user_message」的提示，
预热期间的输出不记进对话），把 CLI 启动和会话加载放到发消息之前。
`args` 是加在命令行上的参数，`files` 是写进这一轮工作目录的配置文件（路径 → JSON 内容，用完还原）；内容是字符串时原样写成文本文件。
里面的 `{name}` 换成工具名（如 `design`），`{url}` 换成工具地址。

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

CLI 不支持 MCP 时可以写一个桥接：Pi 没有 MCP，`shared/clis/pi.json` 写了一个项目扩展 `.pi/extensions/agent-panel-{name}.ts`，
启动时从 `{url}` 读工具列表，注册成 Pi 自己的工具，调用时转发过去。

## 能力 `features`

| 字段          | 说明                                                                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact`     | 压缩上下文：`slash` 发 `/compact`；`summary`（默认）让它写摘要，下一轮开新会话带上                                                                                                                                                                 |
| `fork`        | 分叉、撤回对话：`latest` 只能从最后分叉（配合 `fork` 条件的参数）；`none`（默认）带上对话记录开新会话                                                                                                                                              |
| `autoCompact` | 自动压缩：`env` 用环境变量 `autoCompactEnv` 告诉 CLI 百分比；`panel`（默认）面板在一轮结束后压缩                                                                                                                                                   |
| `slash`       | 会话里认识「/命令」「/Skill」，原样发过去；默认面板把命令文件、Skill 展开成普通要求                                                                                                                                                                |
| `steer`       | 执行中能插话。常驻 RPC 在 `rpc.steer` 里写要发的消息；一次性输出的 CLI 用不了，改用下面的 `notes`                                                                                                                                                  |
| `notes`       | 没有插话协议，但能用面板的 MCP 工具 `read_user_notes` 取执行中的补充（需要 `mcp`）：用户在它执行中发的要求先排进队列，模型取走时从队列里去掉，没取走的这一轮结束后照常处理；对话页开着时还会挂 `wait_user_message`，回复完停在同一个进程里等下一句 |
| `limitEnv`    | 设置里三档模型手动改的上下文窗口、最大输出用哪个环境变量传给 CLI，如 `{"context": "X_MAX_CONTEXT", "maxOutput": "X_MAX_OUTPUT"}`；不写表示 CLI 不接受，界面上会说明                                                                                |

审批：非交互模式下 CLI 不能请用户确认，用权限选项控制它能做什么（参考 Gemini CLI 的 `--approval-mode`；Pi 没有审批，用 `--tools` 限制能用的工具）。

## 把 API 交给 CLI `auth.api`

设置里给 CLI 选了一个 API 后，面板在**保存设置时**就会按 `auth.api` 的规则写进 CLI 自己的配置（执行前还会再写一次，保证配置没被别的工具改掉）。
如果 CLI 支持直接读模型，模型下拉也从 CLI 的配置读，而不是只看全局 API 里填的模型。

| 字段              | 说明                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `protocols`       | 能接受哪些协议的 API                                                                                                             |
| `defaultProvider` | API 没有指定 provider 时，写进 CLI 配置的 provider 名，默认 `agentpanel`                                                         |
| `modelSource`     | `api`（默认）用全局 API 的模型；`cli` 先让 CLI 列模型（API 会先写进 CLI 配置），列不到再回退到 API 的模型                        |
| `modelPrefix`     | 模型 ID 的 provider 前缀模板，例如 `{provider}/`；写进 provider 配置时会把重复的前缀去掉，执行旧的无前缀模型 ID 时会补上         |
| `env` / `args`    | 只在 CLI 只能通过环境变量/参数接收 API 时用；能写配置文件的优先写 `edits`，执行时不再重复传 API 和密钥                           |
| `edits`           | 切到 API 时改的配置文件，保存设置时写；`format` 可以是 `json`（默认）、`toml`、`env`；`merge: true` 时对象递归合并，保留已有配置 |
| `accountEdits`    | 切回账号时还原的配置文件                                                                                                         |
| `wire`            | 协议在 CLI 配置里的写法，用 `{wire}` 引用                                                                                        |

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
